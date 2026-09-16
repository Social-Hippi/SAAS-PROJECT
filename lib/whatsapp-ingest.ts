import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant";
import { hashGuestPhone } from "@/lib/booking-identity";
import type { InboundMessage } from "@/lib/whatsapp-webhook";

// ─────────────────────────────────────────────────────────────────────────────
// Turning inbound WhatsApp messages into attribution.
//
// One row per contact per hotel, never a message log. The attribution question
// is "who, and from which ad" — a conversation answers it, and every extra
// message only updates when it was last seen.
//
// THE REFERRAL IS WRITTEN ONCE AND NEVER OVERWRITTEN. Meta attaches it to the
// FIRST message of an ad-originated conversation; later messages carry none. A
// blind update would therefore erase the ad the moment the guest sent "thanks",
// which is the single most likely way this feature could silently stop working.
// So every referral field is set on create, and on update ONLY when the stored
// value is null and the incoming one is not.
//
// NO RAW PHONE NUMBER IS STORED. The number is normalized and hashed through the
// same chain as VisitorIdentity.phoneHash and Booking.guestPhoneHash, which is
// what lets a conversation join to a booking without either side holding PII —
// and why normalizePhone folding "919900449954" and "9900449954" to one form is
// load-bearing rather than cosmetic.
// ─────────────────────────────────────────────────────────────────────────────

export type IngestResult = {
  stored: number;
  /** Messages whose phone_number_id matched no connected hotel. */
  unrouted: number;
  /** Conversations that gained an ad attribution on this delivery. */
  attributed: number;
};

/**
 * Persist a batch of inbound messages.
 *
 * Resolves each message to a tenant by `phoneNumberId` — never by anything in
 * the message body, so a payload has no say in which agency is written to.
 */
export async function ingestInboundMessages(
  messages: readonly InboundMessage[],
): Promise<IngestResult> {
  const result: IngestResult = { stored: 0, unrouted: 0, attributed: 0 };
  if (messages.length === 0) return result;

  // One lookup for the whole batch: Meta delivers several messages at once, and
  // they can belong to different hotels.
  const ids = [...new Set(messages.map((m) => m.phoneNumberId))];
  const connections = await prisma.whatsAppConnection.findMany({
    where: { phoneNumberId: { in: ids }, status: { not: "disconnected" } },
    select: { id: true, agencyId: true, hotelClientId: true, phoneNumberId: true },
  });
  const byPhoneNumberId = new Map(connections.map((c) => [c.phoneNumberId, c]));

  for (const message of messages) {
    const conn = byPhoneNumberId.get(message.phoneNumberId);
    if (!conn) {
      // A number nobody has connected. Not an error — Meta will deliver for any
      // number subscribed to the app — but it must not be stored against a guess.
      result.unrouted += 1;
      continue;
    }

    const phoneHash = hashGuestPhone(message.fromPhone);
    // Unusable sender. Storing a null-ish hash would mint a join key that
    // matches every other unusable number.
    if (!phoneHash) continue;

    const scoped = agencyScopedFor(conn.agencyId, prisma.whatsAppConversation);
    const existing = await scoped.findFirst({
      where: { hotelClientId: conn.hotelClientId, phoneHash },
      select: {
        id: true,
        ctwaClid: true,
        sourceId: true,
        firstMessageAt: true,
        lastMessageAt: true,
      },
    });

    const ref = message.referral;

    if (!existing) {
      await scoped.create({
        data: {
          agencyId: conn.agencyId,
          hotelClientId: conn.hotelClientId,
          connectionId: conn.id,
          phoneHash,
          ctwaClid: ref?.ctwaClid ?? null,
          sourceId: ref?.sourceId ?? null,
          sourceType: ref?.sourceType ?? null,
          sourceUrl: ref?.sourceUrl ?? null,
          headline: ref?.headline ?? null,
          firstMessageAt: message.sentAt,
          lastMessageAt: message.sentAt,
          messageCount: 1,
        },
      });
      result.stored += 1;
      if (ref) result.attributed += 1;
      continue;
    }

    // ONLY FILL WHAT IS EMPTY. A later referral may arrive if the guest clicks a
    // second ad, and that is worth keeping when we had nothing — but it must
    // never replace the ad that actually started the conversation, and an absent
    // referral must never blank one.
    const gainsAttribution =
      ref != null && existing.ctwaClid == null && existing.sourceId == null;

    await scoped.update({
      where: { id: existing.id },
      data: {
        lastMessageAt:
          message.sentAt > existing.lastMessageAt ? message.sentAt : existing.lastMessageAt,
        // Out-of-order delivery is possible; the earliest wins.
        firstMessageAt:
          message.sentAt < existing.firstMessageAt ? message.sentAt : existing.firstMessageAt,
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
    });
    result.stored += 1;
    if (gainsAttribution) result.attributed += 1;
  }

  // Health signal, mirroring BookingConnection: what matters is whether a
  // message has actually ARRIVED, not whether a row exists.
  // Grouped by agency so each updateMany stays inside one tenant's scope.
  const touchedByAgency = new Map<string, string[]>();
  for (const m of messages) {
    const c = byPhoneNumberId.get(m.phoneNumberId);
    if (!c) continue;
    const list = touchedByAgency.get(c.agencyId) ?? [];
    if (!list.includes(c.id)) list.push(c.id);
    touchedByAgency.set(c.agencyId, list);
  }
  for (const [agencyId, ids2] of touchedByAgency) {
    await agencyScopedFor(agencyId, prisma.whatsAppConnection).updateMany({
      where: { id: { in: ids2 } },
      data: { lastMessageReceivedAt: new Date(), status: "active", lastError: null },
    });
  }

  return result;
}
