import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant";

// ─────────────────────────────────────────────────────────────────────────────
// Joining a WhatsApp conversation to a booking.
//
// The last link in the click-to-WhatsApp chain:
//
//   Meta ad  ->  ctwa_clid on the conversation  ->  phone hash  ->  booking
//
// Meta names the ad itself, so the first hop is a FACT. The second is an
// inference: the phone that messaged is probably the phone that booked. That
// distinction is why this returns a confidence rather than a boolean, and why a
// number shared by two guests downgrades the result instead of being ignored.
//
// WHY NOT `phone_hash` ALONE. The existing booking matcher already links a
// booking to a VISITOR by phone. This is a different claim — the booking came
// from a conversation that Meta told us began at a specific ad — and it carries
// evidence the visitor path never has. Recording it as plain `phone_hash` would
// lose which ad, which is the entire point.
// ─────────────────────────────────────────────────────────────────────────────

export type WhatsAppAttribution = {
  conversationId: string;
  /** The ad Meta named. Null when the guest messaged without clicking an ad. */
  ctwaClid: string | null;
  sourceId: string | null;
  /**
   * DETERMINISTIC is deliberately NOT available here.
   *
   * Even a perfect phone match is "the person who messaged is the person who
   * booked" — an identity inference. Only an identifier HotelTrack minted and
   * got back unchanged earns DETERMINISTIC, and a phone number is not that.
   *
   * STRONG   one conversation matched, and Meta named the ad.
   * PARTIAL  one conversation matched, but no ad — or several conversations
   *          share the number, so which person booked is unknown.
   */
  confidence: "STRONG" | "PARTIAL";
  /** How many conversations shared this number. >1 weakens the claim. */
  candidateCount: number;
};

/**
 * Find the WhatsApp conversation, if any, behind a booking.
 *
 * `bookedAt` bounds it: a conversation that STARTED AFTER the booking cannot
 * have caused it. Without that guard a guest who books in March and messages in
 * April would have the April ad credited with the March booking — attribution
 * running backwards, which is worse than none.
 */
export async function findWhatsAppAttribution(args: {
  agencyId: string;
  hotelClientId: string;
  guestPhoneHash: string | null;
  bookedAt: Date;
}): Promise<WhatsAppAttribution | null> {
  const { agencyId, hotelClientId, guestPhoneHash, bookedAt } = args;
  if (!guestPhoneHash) return null;

  const candidates = await agencyScopedFor(agencyId, prisma.whatsAppConversation).findMany({
    where: {
      hotelClientId,
      phoneHash: guestPhoneHash,
      firstMessageAt: { lte: bookedAt },
    },
    // The conversation nearest the booking is the likeliest cause of it.
    orderBy: { firstMessageAt: "desc" },
    select: { id: true, ctwaClid: true, sourceId: true },
  });

  if (candidates.length === 0) return null;

  const best = candidates[0];
  const namesAnAd = Boolean(best.ctwaClid ?? best.sourceId);

  return {
    conversationId: best.id,
    ctwaClid: best.ctwaClid,
    sourceId: best.sourceId,
    // A shared number means we cannot say WHICH person booked, so the claim
    // weakens even when the ad is known.
    confidence: namesAnAd && candidates.length === 1 ? "STRONG" : "PARTIAL",
    candidateCount: candidates.length,
  };
}
