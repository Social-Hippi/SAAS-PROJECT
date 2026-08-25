import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant-scope";
import { gradeMatch, type MatchMethod } from "@/lib/booking-identity";

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC booking ↔ journey matching.
//
// Runs after a Booking is ingested and writes BookingJourneyMatch rows — the
// EVIDENCE that a booking relates to a marketing journey. It never writes to
// Booking, and it never computes attribution: it establishes what can be proven
// and stops there.
//
// WHAT IS DELIBERATELY ABSENT: there is no IP match, no timing proximity, no
// user-agent or device-fingerprint similarity, no geo, and no fuzzy name
// matching. Every method below compares an identifier for EXACT equality. If
// nothing matches exactly, the answer is UNKNOWN — which is recorded, because
// "we could not connect this" is a finding, not a gap to be filled with a guess.
//
// AMBIGUITY IS PRESERVED. Two visitors sharing a guest email produce TWO rows,
// both graded PARTIAL. Picking "the most recent one" would manufacture the
// certainty the data does not contain.
// ─────────────────────────────────────────────────────────────────────────────

export type MatchableBooking = {
  id: string;
  agencyId: string;
  hotelClientId: string;
  guestEmailHash: string | null;
  guestPhoneHash: string | null;
  externalGuestId: string | null;
};

export type MatchOutcome = {
  created: number;
  method: MatchMethod;
  confidence: string;
  candidateCount: number;
};

/**
 * Attempt every deterministic route from a booking to a known visitor, strongest
 * identifier first, and record what it finds.
 *
 * Only ONE method is recorded — the strongest that produced candidates. Emitting
 * a weaker corroborating match alongside a stronger one adds no evidence and
 * would inflate any later "how many matches" count.
 */
export async function matchBookingToJourney(booking: MatchableBooking): Promise<MatchOutcome> {
  const scoped = <D>(model: D) => agencyScopedFor(booking.agencyId, model);

  // Strongest identifier first. customerId is an id the hotel itself issued;
  // email/phone identify the person.
  const attempts: { method: MatchMethod; where: Record<string, unknown> | null }[] = [
    {
      method: "customer_id",
      where: booking.externalGuestId ? { customerId: booking.externalGuestId } : null,
    },
    {
      method: "email_hash",
      where: booking.guestEmailHash ? { emailHash: booking.guestEmailHash } : null,
    },
    {
      method: "phone_hash",
      where: booking.guestPhoneHash ? { phoneHash: booking.guestPhoneHash } : null,
    },
  ];

  for (const attempt of attempts) {
    if (!attempt.where) continue;

    // hotelClientId scoping is what stops one hotel's guest email from matching
    // another hotel's visitor — the same person can be a guest of both.
    const candidates = await scoped(prisma.visitorIdentity).findMany({
      where: { hotelClientId: booking.hotelClientId, ...attempt.where },
      select: { visitorId: true },
    });
    if (candidates.length === 0) continue;

    const confidence = gradeMatch({ method: attempt.method, candidateCount: candidates.length });
    const created = await recordMatches(
      booking,
      candidates.map((c) => c.visitorId),
      attempt.method,
      confidence,
      { matchedOn: attempt.method, candidateCount: candidates.length },
    );
    return { created, method: attempt.method, confidence, candidateCount: candidates.length };
  }

  // Nothing matched. Record that explicitly: an absent row is indistinguishable
  // from "never attempted", and a later attribution pass must be able to tell
  // "we looked and found nothing" from "we never looked".
  const created = await recordMatches(booking, [null], "unknown", "UNKNOWN", {
    matchedOn: "none",
    candidateCount: 0,
    reason: booking.guestEmailHash || booking.guestPhoneHash || booking.externalGuestId
      ? "identifiers present but no visitor matched"
      : "booking carried no usable identifier",
  });
  return { created, method: "unknown", confidence: "UNKNOWN", candidateCount: 0 };
}

/**
 * Insert the match rows, skipping any that already exist for this booking so a
 * re-ingested booking does not accumulate duplicate evidence. Matches are
 * DERIVED data — re-running matching must be safe and idempotent.
 */
async function recordMatches(
  booking: MatchableBooking,
  visitorIds: (string | null)[],
  method: MatchMethod,
  confidence: string,
  evidence: Record<string, unknown>,
): Promise<number> {
  const existing = await prisma.bookingJourneyMatch.findMany({
    where: { bookingId: booking.id },
    select: { matchMethod: true, visitorId: true },
  });
  const seen = new Set(existing.map((e) => `${e.matchMethod}|${e.visitorId ?? ""}`));

  let created = 0;
  for (const visitorId of visitorIds) {
    if (seen.has(`${method}|${visitorId ?? ""}`)) continue;
    await prisma.bookingJourneyMatch.create({
      data: {
        agencyId: booking.agencyId,
        hotelClientId: booking.hotelClientId,
        bookingId: booking.id,
        visitorId,
        matchMethod: method as never,
        matchConfidence: confidence as never,
        // Never contains a raw email, phone, or click id — only what was compared.
        evidence: evidence as never,
      },
    });
    created += 1;
  }
  return created;
}
