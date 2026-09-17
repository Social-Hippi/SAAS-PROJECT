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

/** The spreadsheet-import prefix. A synthesised id, never one Kraya issued. */
const EXPORT_PREFIX = "export:";

/**
 * The stored lead id, with any raw phone number taken out of it.
 *
 * A spreadsheet export carries no Kraya lead id, so the importer synthesises one
 * from the phone — which is the ONE identity both paths share, and the only
 * thing that makes a re-import land on the row a webhook already created. That
 * is sound; putting the number itself in a stored column was not. It survived
 * into 4,002 production rows and, being a stored field, onto any screen that
 * showed it.
 *
 * Hashing keeps every property the synthesised id needed — deterministic, unique
 * per guest, identical across a re-import — and stores no contact detail. The
 * real Kraya id from a webhook is passed through untouched.
 */
function safeLeadId(leadId: string, phoneHash: string): string {
  return leadId.startsWith(EXPORT_PREFIX) ? `${EXPORT_PREFIX}${phoneHash}` : leadId;
}

/**
 * The last four digits of a number, or null.
 *
 * The whole of what we keep of a contact detail, and only for a lead that has no
 * real Kraya id to be found by. See WhatsAppConversation.phoneLast4.
 */
function phoneLast4Of(leadId: string, phone: string): string | null {
  if (!leadId.startsWith(EXPORT_PREFIX)) return null;
  const digits = String(phone ?? "").replace(/[^0-9]/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

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

  // Never store `lead.leadId` directly: the spreadsheet path builds it from the
  // raw phone number.
  const krayaLeadId = safeLeadId(lead.leadId, phoneHash);
  const phoneLast4 = phoneLast4Of(lead.leadId, lead.phone);

  const scoped = agencyScopedFor(agencyId, prisma.whatsAppConversation);
  const existing = await scoped.findFirst({
    where: { hotelClientId, phoneHash },
    select: {
      id: true,
      ctwaClid: true,
      sourceId: true,
      sourceType: true,
      sourceUrl: true,
      headline: true,
      firstMessageAt: true,
    },
  });

  const ref = lead.referral;

  // The referral is written on create, and on update ONLY into fields that are
  // still empty — FIELD BY FIELD, not all-or-nothing.
  //
  // Never overwrite: Kraya re-sends the whole lead on every stage change, and a
  // hand-edited lead can come back with the wa_ref_* attributes blank. Assigning
  // unconditionally would erase the ad the moment somebody moved the lead to
  // "Booking Confirmed" — deleting the attribution at the instant it became
  // worth having.
  //
  // But always FILL: an all-or-nothing gate ("write nothing unless every field
  // is empty") looks equivalent and is not. A row holding a click id but no ad
  // id can never gain the ad id, because the click id makes the gate false. That
  // is not hypothetical — it happened here. Eighty rows had a corrupted ad id
  // cleared for re-import while their click ids were left in place, and the gate
  // then refused every one of them. Per-field filling has no such hole.
  const fill = <T,>(current: T | null, incoming: T | null): T | null | undefined =>
    current == null && incoming != null ? incoming : undefined;

  const referralUpdate = ref
    ? {
        ctwaClid: fill(existing?.ctwaClid ?? null, ref.ctwaClid),
        sourceId: fill(existing?.sourceId ?? null, ref.sourceId),
        sourceType: fill(existing?.sourceType ?? null, ref.sourceType),
        sourceUrl: fill(existing?.sourceUrl ?? null, ref.sourceUrl),
        headline: fill(existing?.headline ?? null, ref.headline),
      }
    : {};

  // Undefined entries are dropped, so Prisma leaves those columns untouched.
  const referralFields = Object.fromEntries(
    Object.entries(referralUpdate).filter(([, v]) => v !== undefined),
  );
  const gainsAttribution = Object.keys(referralFields).length > 0;

  const conversationId = existing
    ? (
        await scoped.update({
          where: { id: existing.id },
          data: {
            krayaLeadId,
            // Only filled in for an imported lead, and never cleared by a later
            // webhook — the row keeps whichever handle it has.
            ...(phoneLast4 ? { phoneLast4 } : {}),
            stageName: lead.stage,
            pipelineName: lead.pipeline,
            lastMessageAt: dates.lastSeenAt ?? now,
            messageCount: { increment: 1 },
            ...referralFields,
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
            krayaLeadId,
            phoneLast4,
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
