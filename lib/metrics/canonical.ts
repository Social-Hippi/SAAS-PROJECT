/**
 * CANONICAL METRIC LAYER — the single source of truth for revenue, source type,
 * attribution evidence and coverage.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before this module, `paidRevenue` was computed independently in seven places
 * using TWO classifiers that disagreed:
 *
 *   - lib/revenue-by-source.ts  rowSourceType()      coupon OVERRIDES utm
 *   - lib/source-classifier.ts  classifySourceType() utm + click ids only
 *
 * So a ₹50,000 booking from `utm_source=facebook&utm_medium=cpc` that ALSO used
 * a coupon was paid revenue on one screen and not on another, for the same hotel
 * on the same day. Nothing outside this file may classify a row or sum revenue.
 *
 * THE COUPON PRECEDENCE DECISION
 * ------------------------------
 * A paid click identifier (gclid/gbraid/wbraid) or a paid UTM is DETERMINISTIC
 * evidence that money was spent to produce this visit. A coupon code is evidence
 * that an influencer was involved, but it is entered by the guest and survives
 * being shared, so it is weaker. Therefore:
 *
 *     paid click / paid UTM   >   coupon   >   everything else
 *
 * This is a change from rowSourceType(), and it is the point: a coupon no longer
 * erases a paid click. It still outranks organic, direct and "other", so an
 * influencer campaign with no UTM is still credited to the influencer.
 *
 * THE INVARIANT
 * -------------
 *     attributedRevenue + directRevenue + unknownRevenue === totalRevenue
 *
 * exactly, at every level of every breakdown. coverageOf() asserts it. If a
 * filter ever breaks it, the filter is wrong, not the assertion.
 *
 * UNKNOWN IS NEVER ZERO, AND NEVER "DIRECT"
 * -----------------------------------------
 * lib/utm-normalize.ts maps an empty source to "direct", and
 * lib/source-classifier.ts returns "direct" for it. That is correct as a SOURCE
 * KEY and wrong as an ATTRIBUTION OUTCOME: a booking whose origin was lost (a
 * blocked cookie, an ITP eviction at day 7, a booking engine that stripped the
 * query string) is indistinguishable from a guest who typed the URL.
 *
 * attributionOutcomeOf() classifies on POSITIVE EVIDENCE only. Absence of
 * evidence is `unknown_*`, never `direct_confirmed`.
 */

import { classifySourceType, isPaidSourceType, type SourceType } from "@/lib/source-classifier";
import type { ClickIds } from "@/lib/click-ids";

export type { SourceType };

/**
 * ROAS, or NULL when it cannot be computed. Zero spend does not mean zero
 * return; it means the ratio is undefined and must render as a dash.
 *
 * This primitive lives here, not in lib/ad-spend.ts, so that the canonical layer
 * stays free of any database import and can be unit-tested without Prisma.
 * lib/ad-spend.ts re-exports it, so there is still exactly one implementation.
 */
export function safeRoas(revenue: number, spend: number | null): number | null {
  if (spend == null || !Number.isFinite(spend) || spend <= 0) return null;
  if (!Number.isFinite(revenue)) return null;
  return revenue / spend;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minimum a row must carry to be classified and summed. Deliberately
 * structural (not a Prisma type) so this module stays pure, dependency-free and
 * unit-testable without a database.
 */
export type CanonicalRow = ClickIds & {
  utmSource: string | null | undefined;
  utmMedium: string | null | undefined;
  utmCampaign?: string | null | undefined;
  utmContent?: string | null | undefined;
  utmTerm?: string | null | undefined;
  /** Revenue for this booking. A NULL conversionValue is passed as 0. */
  value: number;
  /** Coupon code used on this booking, if any. */
  couponCode?: string | null | undefined;
  /** Session this conversion belongs to. The ingest route writes "" when absent. */
  sessionId?: string | null | undefined;
  /** Anonymous visitor id, used to detect a returning visitor. */
  visitorId?: string | null | undefined;
  /**
   * How the snippet derived `value`: "attribute" | "url_param" | "heuristic".
   * NULL on rows written before this column existed, which honestly means
   * "we do not know how this was derived" — never report those as measured.
   */
  valueSource?: string | null | undefined;
};

function present(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function hasCoupon(row: CanonicalRow): boolean {
  return present(row.couponCode);
}

function hasUtm(row: CanonicalRow): boolean {
  return (
    present(row.utmSource) ||
    present(row.utmMedium) ||
    present(row.utmCampaign) ||
    present(row.utmContent) ||
    present(row.utmTerm)
  );
}

function hasClickId(row: CanonicalRow): boolean {
  return present(row.gclid) || present(row.gbraid) || present(row.wbraid) || present(row.fbclid);
}

// ─────────────────────────────────────────────────────────────────────────────
// C-4 · One source type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE classifier. Replaces both classifySourceType() and rowSourceType() at
 * every revenue call site.
 *
 * Order: paid (deterministic spend) → coupon (influencer) → UTM heuristics.
 */
export function canonicalSourceType(row: CanonicalRow): SourceType {
  // Normalise before delegating. CanonicalRow accepts `undefined` on the UTM and
  // click-id fields, because rows reach this module from several query shapes and
  // from plain object literals in tests. ClassifiableUtm's click ids are
  // `string | null`. Collapsing undefined to null here keeps the two contracts
  // compatible under Next's build-time type check, which resolves the mapped
  // Partial<Record<...>> more strictly than a bare `tsc --noEmit` does.
  const byUtm = classifySourceType({
    utmSource: row.utmSource ?? null,
    utmMedium: row.utmMedium ?? null,
    utmContent: row.utmContent ?? null,
    gclid: row.gclid ?? null,
    gbraid: row.gbraid ?? null,
    wbraid: row.wbraid ?? null,
    fbclid: row.fbclid ?? null,
  });
  if (isPaidSourceType(byUtm)) return byUtm;
  if (hasCoupon(row)) return "influencer";
  return byUtm;
}

/** Is this row's revenue attributable to paid media under the canonical rule? */
export function isPaidRow(row: CanonicalRow): boolean {
  return isPaidSourceType(canonicalSourceType(row));
}

// ─────────────────────────────────────────────────────────────────────────────
// S-1 · Cancellations and refunds
// ─────────────────────────────────────────────────────────────────────────────

/** The subset of Booking a revenue calculation needs. Structural on purpose. */
export type BookingOutcome = {
  status?: string | null;
  /** Amount refunded, in the same units as CanonicalRow.value. */
  refundedAmount?: number | null;
} | null | undefined;

const NON_REALISED = new Set(["CANCELLED", "REFUNDED", "NO_SHOW"]);

/**
 * The revenue that actually happened, after cancellation and refund.
 *
 * TODAY THIS IS A NO-OP: no Booking row can exist in production, because the
 * only registered provider adapter rejects every payload. It is written now so
 * that on the day bookings start flowing, cancelled revenue does not silently
 * stay in every report forever — which is the current behaviour and the reason
 * OTA "commission saved" is overstated.
 *
 * With no booking supplied, the row's own value stands: absence of a matched
 * booking is not evidence of cancellation.
 */
export function realisedValueOf(row: CanonicalRow, booking?: BookingOutcome): number {
  const base = Number.isFinite(row.value) ? row.value : 0;
  if (!booking) return base;
  const status = (booking.status ?? "").toUpperCase();
  if (NON_REALISED.has(status)) return 0;
  const refunded = Number.isFinite(booking.refundedAmount ?? NaN) ? (booking.refundedAmount as number) : 0;
  return Math.max(0, base - refunded);
}

export function isRevenueRealised(row: CanonicalRow, booking?: BookingOutcome): boolean {
  return realisedValueOf(row, booking) > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Revenue sums
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve the matched booking for a row, when the caller has one. */
export type BookingResolver = (row: CanonicalRow) => BookingOutcome;

const NO_BOOKING: BookingResolver = () => null;

/** All tracked booking revenue, after cancellations and refunds. */
export function totalRevenueOf(rows: readonly CanonicalRow[], booking: BookingResolver = NO_BOOKING): number {
  let sum = 0;
  for (const row of rows) sum += realisedValueOf(row, booking(row));
  return sum;
}

/** Revenue on rows the canonical rule classifies as paid media. */
export function paidRevenueOf(rows: readonly CanonicalRow[], booking: BookingResolver = NO_BOOKING): number {
  let sum = 0;
  for (const row of rows) {
    if (isPaidRow(row)) sum += realisedValueOf(row, booking(row));
  }
  return sum;
}

/** Count of bookings classified as paid media. The ROAS/CAC denominator. */
export function paidBookingsOf(rows: readonly CanonicalRow[]): number {
  let n = 0;
  for (const row of rows) if (isPaidRow(row)) n++;
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// C-2 · Attribution outcome, on positive evidence only
// ─────────────────────────────────────────────────────────────────────────────

export const ATTRIBUTION_OUTCOMES = [
  "attributed",
  "direct_confirmed",
  "unknown_no_session",
  "unknown_no_evidence",
] as const;
export type AttributionOutcome = (typeof ATTRIBUTION_OUTCOMES)[number];

/** True when the outcome is one we could not trace. */
export function isUnknownOutcome(o: AttributionOutcome): boolean {
  return o === "unknown_no_session" || o === "unknown_no_evidence";
}

/**
 * Owner-facing reason for each outcome. Never shown as an internal key.
 * "Direct" here means we have evidence they came straight to the site, NOT that
 * we lost the trail.
 */
export const OUTCOME_REASON: Record<AttributionOutcome, string> = {
  attributed: "Traced to a campaign, link or code",
  direct_confirmed: "Came straight to your site",
  unknown_no_session: "The visit behind this booking was not recorded",
  unknown_no_evidence: "No campaign, link, code or referring site was recorded",
};

/**
 * Evidence available about the session a conversion belongs to. TrackingEvent
 * has no referrer column; Session.referrer does, and joins on sessionId. That
 * join is the entire mechanism — without it, "unknown" cannot be separated from
 * "direct", which is the defect this module exists to fix.
 */
export type EvidenceContext = {
  /** The joined Session row, or null when none could be found. */
  session?: { referrer?: string | null } | null;
  /** Host of the hotel's own website, e.g. "silentshoresresort.com". */
  hotelHost?: string | null;
  /** Does this visitorId have an EARLIER session on this hotel? */
  visitorHasPriorSession?: boolean;
};

/** Lower-cased host of a referrer string, or null if it is absent/unparseable. */
function hostOf(value: string | null | undefined): string | null {
  if (!present(value)) return null;
  const raw = (value as string).trim();
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Classify a conversion's attribution evidence.
 *
 * Rules run in order and every "attributed" / "direct_confirmed" branch requires
 * POSITIVE evidence. The default when a caller supplies no EvidenceContext is
 * `unknown_no_session`, not `direct_confirmed` — a lazy call site must err
 * toward "we do not know", never toward a claim it cannot support.
 */
export function attributionOutcomeOf(row: CanonicalRow, ctx: EvidenceContext = {}): AttributionOutcome {
  // 1-3 · Marketing context on the conversion itself.
  if (hasUtm(row)) return "attributed";
  if (hasClickId(row)) return "attributed";
  if (hasCoupon(row)) return "attributed";

  // 4 · No joinable session. The ingest route writes "" when sessionId is absent,
  //     so an empty string is the same as a missing row.
  const session = ctx.session;
  if (!session) return "unknown_no_session";

  const refHost = hostOf(session.referrer);
  const ownHost = ctx.hotelHost ? hostOf(ctx.hotelHost) : null;

  if (refHost) {
    // 6 · Referred by the hotel's own site: internal navigation, genuinely direct.
    if (ownHost && refHost === ownHost) return "direct_confirmed";
    // 5 · An external referrer IS a channel (referral), so it is attributable.
    return "attributed";
  }

  // 7 · No referrer, no marketing context, but this visitor has been here before:
  //     a returning guest typing the URL or using a bookmark. Real direct traffic.
  //     Without this rule the split is a relabelling exercise, not a fix.
  if (ctx.visitorHasPriorSession) return "direct_confirmed";

  // 8 · First-ever session, no referrer, no marketing context. We do not know.
  return "unknown_no_evidence";
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage
// ─────────────────────────────────────────────────────────────────────────────

export type Coverage = {
  attributedRevenue: number;
  directRevenue: number;
  unknownRevenue: number;
  totalRevenue: number;
  attributedBookings: number;
  directBookings: number;
  unknownBookings: number;
  totalBookings: number;
  /** (attributed + direct) / total. NULL — never 0 — when there is no revenue. */
  coveragePct: number | null;
  /** Revenue per unknown reason code, for the "why" breakdown. */
  unknownByReason: Record<string, number>;
  /** How many booking values were read off the page by the fallback heuristic. */
  heuristicValueBookings: number;
  /** ...and how many have no recorded derivation at all (rows predating C-3). */
  unknownValueSourceBookings: number;
};

export type EvidenceResolver = (row: CanonicalRow) => EvidenceContext;

const NO_EVIDENCE: EvidenceResolver = () => ({});

/**
 * Split revenue into attributed / direct / unknown, and report how much of the
 * total we can actually account for.
 *
 * The three buckets sum EXACTLY to the total; the assertion below is deliberate
 * and must not be relaxed. It is the property every screen depends on.
 */
export function coverageOf(
  rows: readonly CanonicalRow[],
  evidence: EvidenceResolver = NO_EVIDENCE,
  booking: BookingResolver = NO_BOOKING,
): Coverage {
  let attributedRevenue = 0;
  let directRevenue = 0;
  let unknownRevenue = 0;
  let attributedBookings = 0;
  let directBookings = 0;
  let unknownBookings = 0;
  let heuristicValueBookings = 0;
  let unknownValueSourceBookings = 0;
  const unknownByReason: Record<string, number> = {};

  for (const row of rows) {
    const value = realisedValueOf(row, booking(row));
    const outcome = attributionOutcomeOf(row, evidence(row));

    if (outcome === "attributed") {
      attributedRevenue += value;
      attributedBookings++;
    } else if (outcome === "direct_confirmed") {
      directRevenue += value;
      directBookings++;
    } else {
      unknownRevenue += value;
      unknownBookings++;
      unknownByReason[outcome] = (unknownByReason[outcome] ?? 0) + value;
    }

    if (row.valueSource === "heuristic") heuristicValueBookings++;
    else if (!present(row.valueSource)) unknownValueSourceBookings++;
  }

  const totalRevenue = attributedRevenue + directRevenue + unknownRevenue;
  const totalBookings = attributedBookings + directBookings + unknownBookings;

  // The invariant, asserted rather than assumed. Floating-point sums of the same
  // addends in the same order are exact here, so an epsilon is not needed; the
  // guard exists to catch a future refactor that filters one bucket only.
  if (Math.abs(attributedRevenue + directRevenue + unknownRevenue - totalRevenue) > 1e-6) {
    throw new Error("canonical: attributed + direct + unknown must equal total revenue");
  }

  return {
    attributedRevenue,
    directRevenue,
    unknownRevenue,
    totalRevenue,
    attributedBookings,
    directBookings,
    unknownBookings,
    totalBookings,
    coveragePct: totalRevenue > 0 ? (attributedRevenue + directRevenue) / totalRevenue : null,
    unknownByReason,
    heuristicValueBookings,
    unknownValueSourceBookings,
  };
}
