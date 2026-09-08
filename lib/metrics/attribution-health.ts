import "server-only";

import type { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import {
  ok,
  notAttributable,
  notTraceable,
  notApplicable,
  ratio,
  type MetricValue,
} from "@/lib/metrics/metric-value";

// ─────────────────────────────────────────────────────────────────────────────
// ATTRIBUTION HEALTH — how much of the truth we can actually account for.
//
// HotelTrack ingests real reservations (Booking) and, separately, the evidence
// linking each one to a marketing journey (BookingJourneyMatch). Both tables
// have existed and been populated for some time; NEITHER has ever been shown to
// a hotel owner. That is the gap this module closes.
//
// The distinction it exists to protect:
//
//   "0 bookings"        we received the reservations and there were none
//   "Not traceable"     no booking system is connected, so we never saw any
//   "Not attributable"  we have the reservation, but cannot prove which
//                       campaign produced it
//
// Reporting the last two as zero would understate a hotel's marketing and
// overstate our own confidence at the same time.
//
// BUCKETING, and why ambiguity is not success. recordMatches() in
// lib/booking-match.ts writes ONE ROW PER CANDIDATE VISITOR, so two rows at the
// same confidence means two people plausibly made this booking. We take the
// strongest confidence present, then require it to be UNAMBIGUOUS:
//
//   attributed        one candidate, at DETERMINISTIC or STRONG confidence
//   partial           several candidates at that confidence (we know it was one
//                     of them, not which), or the best evidence is only PARTIAL
//   not attributable  no match rows at all, or only UNKNOWN
//
// Downgrading ambiguity to `partial` is deliberate. Crediting a campaign for a
// booking that two different journeys could explain is precisely the kind of
// manufactured certainty this product exists to avoid.
// ─────────────────────────────────────────────────────────────────────────────

/** Higher wins. Mirrors the BookingMatchConfidence enum. */
const CONFIDENCE_RANK: Record<string, number> = {
  DETERMINISTIC: 3,
  STRONG: 2,
  PARTIAL: 1,
  UNKNOWN: 0,
};

/**
 * Statuses that count as a booking that happened.
 *
 * CANCELLED and REFUNDED are excluded: a cancelled reservation is not a result,
 * and counting it would inflate both the numerator and any ROAS built on it.
 * BookingStatusEvent keeps the full history either way, so nothing is lost.
 */
const COUNTED_STATUSES: BookingStatus[] = ["CONFIRMED", "MODIFIED", "COMPLETED"];

export type AttributionHealth = {
  /**
   * Whether a booking source is wired up at all. Everything below is
   * `not_traceable` when it is not — the honest answer to "how many bookings did
   * marketing drive" for a hotel we receive no bookings from.
   */
  bookingSource: {
    connected: boolean;
    status: string | null;
    lastBookingReceivedAt: Date | null;
  };
  totalBookings: MetricValue<number>;
  attributedBookings: MetricValue<number>;
  partiallyAttributedBookings: MetricValue<number>;
  unattributedBookings: MetricValue<number>;
  /** (attributed + partial) ÷ total, as a fraction. */
  coverage: MetricValue<number>;
  /** Revenue across counted bookings, refusing to combine currencies. */
  totalRevenue: MetricValue<number>;
  attributedRevenue: MetricValue<number>;
  currency: string | null;
  /** How many counted bookings carried no monetary amount from the provider. */
  bookingsMissingAmount: number;
  /** Owner-facing "why not attributed" breakdown, largest first. */
  reasons: { label: string; count: number }[];
};

const NO_SOURCE_REASON =
  "No booking system is connected for this hotel yet, so we do not receive reservations to attribute.";

/**
 * Attribution health for one hotel over a window.
 *
 * Runs under agencyScoped, so it is correct on both the agency dashboard (Clerk
 * session) and the public share report (runWithAgencyScope override).
 */
export async function loadAttributionHealth(
  hotelClientId: string,
  range: { since: Date; until: Date },
): Promise<AttributionHealth> {
  const connection = await agencyScoped(prisma.bookingConnection).findFirst({
    where: { hotelClientId },
    select: { status: true, lastBookingReceivedAt: true },
  });

  const bookingSource = {
    connected: Boolean(connection),
    status: connection?.status ?? null,
    lastBookingReceivedAt: connection?.lastBookingReceivedAt ?? null,
  };

  // No booking source: every figure below is unknowable, not zero.
  if (!connection) {
    const untraceable = notTraceable<number>(NO_SOURCE_REASON);
    return {
      bookingSource,
      totalBookings: untraceable,
      attributedBookings: untraceable,
      partiallyAttributedBookings: untraceable,
      unattributedBookings: untraceable,
      coverage: untraceable,
      totalRevenue: untraceable,
      attributedRevenue: untraceable,
      currency: null,
      bookingsMissingAmount: 0,
      reasons: [],
    };
  }

  const bookings = await agencyScoped(prisma.booking).findMany({
    where: {
      hotelClientId,
      bookedAt: { gte: range.since, lte: range.until },
      status: { in: COUNTED_STATUSES },
    },
    select: {
      id: true,
      currency: true,
      grossAmount: true,
      netAmount: true,
      roomRevenue: true,
      journeyMatches: { select: { matchConfidence: true, matchMethod: true } },
    },
  });

  let attributed = 0;
  let partial = 0;
  let unattributed = 0;
  let missingAmount = 0;
  const reasonCounts = new Map<string, number>();
  const currencies = new Set<string>();
  let totalRevenue = 0;
  let attributedRevenue = 0;

  const note = (label: string) => reasonCounts.set(label, (reasonCounts.get(label) ?? 0) + 1);

  for (const b of bookings) {
    // Provider-supplied amounts, in preference order. Every one is nullable by
    // design, so "no amount" is tracked rather than silently treated as zero.
    const amountRaw = b.grossAmount ?? b.netAmount ?? b.roomRevenue;
    const amount = amountRaw == null ? null : Number(amountRaw);
    if (amount == null) missingAmount += 1;
    else totalRevenue += amount;
    if (b.currency) currencies.add(b.currency);

    const matches = b.journeyMatches;
    if (matches.length === 0) {
      unattributed += 1;
      note("No visit could be linked to this reservation");
      continue;
    }

    const bestRank = Math.max(...matches.map((m) => CONFIDENCE_RANK[m.matchConfidence] ?? 0));
    const candidatesAtBest = matches.filter(
      (m) => (CONFIDENCE_RANK[m.matchConfidence] ?? 0) === bestRank,
    ).length;

    if (bestRank >= CONFIDENCE_RANK.STRONG && candidatesAtBest === 1) {
      attributed += 1;
      if (amount != null) attributedRevenue += amount;
    } else if (bestRank >= CONFIDENCE_RANK.PARTIAL) {
      partial += 1;
      note(
        candidatesAtBest > 1
          ? "More than one visitor matched this reservation, so we cannot say which visit produced it"
          : "Only partial evidence links this reservation to a visit",
      );
    } else {
      unattributed += 1;
      note("The evidence linking this reservation to a visit was inconclusive");
    }
  }

  const total = bookings.length;
  const mixedCurrency = currencies.size > 1;
  const currency = currencies.size === 1 ? [...currencies][0] : null;

  // Mixed currencies are not summable. This is the same refusal getSpendByPlatform
  // makes for ad spend, for the same reason: a total that silently adds rupees to
  // dollars is worse than no total.
  const revenueOf = (value: number): MetricValue<number> =>
    mixedCurrency
      ? notApplicable(
          "These reservations are in more than one currency, so a single revenue total would be misleading.",
        )
      : ok(value);

  return {
    bookingSource,
    totalBookings: ok(total),
    attributedBookings: ok(attributed),
    partiallyAttributedBookings: ok(partial),
    unattributedBookings: ok(unattributed),
    // A period with no reservations has no coverage to report — 100% would claim
    // we attributed everything, and 0% would claim we failed to.
    coverage:
      total === 0
        ? notApplicable("There were no reservations in this period to attribute.")
        : ratio(ok(attributed + partial), ok(total)),
    totalRevenue: revenueOf(totalRevenue),
    attributedRevenue:
      attributed === 0 && total > 0
        ? notAttributable(
            "We received reservations in this period but could not connect any of them to a campaign.",
          )
        : revenueOf(attributedRevenue),
    currency,
    bookingsMissingAmount: missingAmount,
    reasons: [...reasonCounts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
  };
}
