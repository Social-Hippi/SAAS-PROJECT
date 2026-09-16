import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant";
import { hashGuestEmail, hashGuestPhone } from "@/lib/booking-identity";
import { isConfirmedStage, type KrayaLead } from "@/lib/kraya-webhook";

// ─────────────────────────────────────────────────────────────────────────────
// Kraya lead → conversation, and sometimes → booking.
//
// EVERY lead becomes a WhatsAppConversation. Most of them stop there: a lead
// that is "No Response" or "Junk" is still a real enquiry the marketing
// produced, and dropping it would understate the top of the funnel while
// flattering the conversion rate computed from it.
//
// ONE lead in the nominated stage ALSO becomes a Booking. That is the only stage
// with a consequence, which is why it is configuration rather than a guess —
// see KrayaConnection.confirmedStageName.
//
// WHAT WE DO NOT TAKE: names, notes, message bodies. Phone and email exist here
// only long enough to be hashed, through the same chain as Booking.guestPhoneHash
// so a Kraya lead and a booking engine reservation for the same guest resolve to
// the same person without either side storing a contact detail.
// ─────────────────────────────────────────────────────────────────────────────

export type KrayaIngestResult = {
  conversation: "created" | "updated";
  /** Set when this lead crossed into the confirmed stage. */
  booking: "created" | "updated" | null;
  /** True when Meta named the ad that started the conversation. */
  attributed: boolean;
};

export type KrayaTenant = {
  connectionId: string;
  agencyId: string;
  hotelClientId: string;
  confirmedStageName: string | null;
};

/**
 * Dates the webhook cannot supply.
 *
 * Kraya's webhook payload carries no timestamps at all, so the live path can
 * only date a lead by when it arrived. The EXPORT carries `Created at`, `Stage
 * updated at` and a full stage history, so an import can place each lead — and
 * each booking — on the day it actually happened.
 */
export type KrayaDates = {
  firstSeenAt?: Date | null;
  lastSeenAt?: Date | null;
  confirmedAt?: Date | null;
};

export async function ingestKrayaLead(
  tenant: KrayaTenant,
  lead: KrayaLead,
  now = new Date(),
  dates: KrayaDates = {},
): Promise<KrayaIngestResult | null> {
  const { agencyId, hotelClientId } = tenant;

  const phoneHash = hashGuestPhone(lead.phone);
  // Unusable number. Storing it would mint a join key matching every other
  // unusable one, and the booking join is the entire point of this row.
  if (!phoneHash) return null;

  const scoped = agencyScopedFor(agencyId, prisma.whatsAppConversation);
  const existing = await scoped.findFirst({
    where: { hotelClientId, phoneHash },
    select: { id: true, ctwaClid: true, sourceId: true, firstMessageAt: true },
  });

  const ref = lead.referral;

  // The referral is written on create, and on update ONLY into empty fields.
  //
  // Kraya re-sends the whole lead on every stage change, and a lead edited by
  // hand can come back with the wa_ref_* attributes blank. Assigning them
  // unconditionally would erase the ad the moment somebody moved the lead to
  // "Booking Confirmed" — deleting the attribution at the exact instant it
  // became worth having.
  const gainsAttribution =
    ref != null && existing != null && existing.ctwaClid == null && existing.sourceId == null;

  const conversationId = existing
    ? (
        await scoped.update({
          where: { id: existing.id },
          data: {
            krayaLeadId: lead.leadId,
            stageName: lead.stage,
            pipelineName: lead.pipeline,
            lastMessageAt: dates.lastSeenAt ?? now,
            messageCount: { increment: 1 },
            ...(gainsAttribution
              ? {
                  ctwaClid: ref.ctwaClid,
                  sourceId: ref.sourceId,
                  sourceType: ref.sourceType,
                  sourceUrl: ref.sourceUrl,
                  headline: ref.headline,
                }
              : {}),
          },
          select: { id: true },
        })
      ).id
    : (
        await scoped.create({
          data: {
            agencyId,
            hotelClientId,
            // Kraya leads have no WhatsAppConnection — the number is Kraya's, not
            // ours. connectionId is nullable for exactly this case.
            connectionId: null,
            phoneHash,
            krayaLeadId: lead.leadId,
            stageName: lead.stage,
            pipelineName: lead.pipeline,
            ctwaClid: ref?.ctwaClid ?? null,
            sourceId: ref?.sourceId ?? null,
            sourceType: ref?.sourceType ?? null,
            sourceUrl: ref?.sourceUrl ?? null,
            headline: ref?.headline ?? null,
            firstMessageAt: dates.firstSeenAt ?? now,
            lastMessageAt: dates.lastSeenAt ?? dates.firstSeenAt ?? now,
            messageCount: 1,
          },
          select: { id: true },
        })
      ).id;
  void conversationId;

  let booking: KrayaIngestResult["booking"] = null;

  if (isConfirmedStage(lead.stage, tenant.confirmedStageName)) {
    // bookedAt is the moment WE learned of it, not the moment it was confirmed.
    // Kraya's webhook carries no timestamps — the stage history that does is only
    // in the export, which is also how backfill dates these properly.
    // KEYED ON THE PHONE HASH, not on lead.leadId.
    //
    // The same booking reaches us two ways — live from the webhook, which knows
    // Kraya's numeric lead id, and from the export, which carries no id at all.
    // Keying on the id would file those as two separate bookings for one guest,
    // and a backfill would silently double every confirmed booking it touched.
    //
    // The phone hash is the identity BOTH paths share, and it is Kraya's own
    // deduplication model: one lead per number. Kraya has no reservation id to
    // offer — a lead is not a reservation — so there is nothing more reconcilable
    // to use.
    const scopedBooking = agencyScopedFor(agencyId, prisma.booking);
    const externalBookingId = phoneHash;
    const priorBooking = await scopedBooking.findFirst({
      where: { hotelClientId, provider: "kraya", externalBookingId },
      select: { id: true },
    });

    const data = {
      status: "CONFIRMED" as const,
      // NOT the marketing source: a WhatsApp booking may have been produced by a
      // Google ad. The channel is how it was booked; attribution lives on the
      // conversation this booking shares a phone hash with.
      bookingChannel: "whatsapp",
      guestPhoneHash: phoneHash,
      guestEmailHash: hashGuestEmail(lead.email),
      bookedAt: dates.confirmedAt ?? now,
    };

    if (priorBooking) {
      await scopedBooking.update({ where: { id: priorBooking.id }, data });
      booking = "updated";
    } else {
      await scopedBooking.create({
        data: {
          agencyId,
          hotelClientId,
          provider: "kraya",
          externalBookingId,
          ...data,
        },
      });
      booking = "created";
    }
  }

  return {
    conversation: existing ? "updated" : "created",
    booking,
    attributed: Boolean(ref?.ctwaClid ?? ref?.sourceId),
  };
}
