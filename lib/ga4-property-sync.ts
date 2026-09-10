import { UNASSIGNED_SEGMENT } from "@/lib/segments";

// ─────────────────────────────────────────────────────────────────────────────
// SPLITTING GA4 BY PROPERTY, AT SYNC TIME.
//
// Ga4Snapshot stores SITE totals, and a total cannot be cut afterwards: it
// arrives pre-aggregated, with no rows left to filter. So the split has to be
// made while we are still talking to GA4 — by asking the same questions again
// with a dimensionFilter on the session's landing page.
//
// WHY ASK GA4 RATHER THAN DIVIDE UP WHAT WE STORE. Two of the figures on that
// card cannot be produced by arithmetic on anything we could store:
//
//   • UNIQUE VISITORS. One person can land on both properties. Per-property user
//     counts do not sum to the site total, and adding them would overcount by
//     exactly the people who visited both — a number we do not have.
//   • BOUNCE RATE / AVG SESSION. Ratios. Re-deriving them means a weighted
//     average over buckets we would first have to be sure were complete.
//
// GA4 does its own de-duplication per query, so a filtered query answers both
// correctly. That is the whole reason this file exists rather than a `.filter()`
// over stored rows.
//
// A SESSION BELONGS TO THE PROPERTY IT LANDED ON.
//
// Every session has exactly one landing page, so the buckets PARTITION the
// traffic: no session is counted twice, and the parts sum to the site total.
// The alternative — "any session that touched a property's pages" — counts a
// session that visited both in both, so the parts exceed the whole and no
// honest total can be shown.
//
// The cost of that choice, stated plainly because it makes the numbers look
// smaller: a visitor who arrives on the HOME PAGE and then reads Coffeeberry
// Hills pages counts as SHARED, not as Coffeeberry Hills. Their interest is
// real, and this attributes it to the group rather than guessing which property
// earned it.
//
// SHARED IS A FIRST-CLASS BUCKET, never distributed across properties by ratio
// — the same rule lib/segments.ts enforces for HotelTrack's own tracking.
// ─────────────────────────────────────────────────────────────────────────────

/** The GA4 dimension every filter here is built on. */
export const LANDING_DIMENSION = "landingPagePlusQueryString";

export type PropertyBucket = {
  /** A PropertySegment id, or UNASSIGNED_SEGMENT for shared pages. */
  key: string;
  name: string;
  /** Path prefixes owned by this bucket. Empty for the shared bucket. */
  prefixes: string[];
};

type SegmentLike = { id: string; name: string; pathPrefixes: string[] };

const beginsWith = (value: string) => ({
  filter: {
    fieldName: LANDING_DIMENSION,
    stringFilter: { matchType: "BEGINS_WITH", value, caseSensitive: false },
  },
});

/**
 * "Landed on any of these prefixes."
 *
 * A single prefix is emitted as a bare filter rather than a one-element orGroup:
 * GA4 accepts both, and the flat form is what its own examples produce, so a
 * request logged during debugging reads the way the documentation does.
 */
export function landingPrefixFilter(prefixes: readonly string[]): unknown {
  if (prefixes.length === 1) return beginsWith(prefixes[0]!);
  return { orGroup: { expressions: prefixes.map(beginsWith) } };
}

/**
 * "Landed on none of the properties' prefixes" — the shared bucket.
 *
 * Defined as the COMPLEMENT rather than as a list of known shared paths. A page
 * nobody has classified yet (a new landing page, a campaign microsite) lands
 * here automatically instead of vanishing from the totals, which is what keeps
 * the buckets summing to the site total.
 */
export function sharedPagesFilter(allPrefixes: readonly string[]): unknown {
  if (allPrefixes.length === 0) return null; // nothing is claimed, so nothing is shared
  return { notExpression: landingPrefixFilter(allPrefixes) };
}

/**
 * The buckets to sync for a hotel: one per property that has prefixes, plus the
 * shared bucket.
 *
 * A segment with NO prefixes is skipped rather than synced as zeros. Zero is a
 * measurement; "we have no rule that identifies this property's pages" is not,
 * and storing the first to mean the second is how a dashboard reports an outage
 * as a quiet month.
 */
export function bucketsFor(segments: readonly SegmentLike[]): PropertyBucket[] {
  const withPrefixes = segments.filter((s) => s.pathPrefixes.length > 0);
  if (withPrefixes.length === 0) return [];

  const buckets: PropertyBucket[] = withPrefixes.map((s) => ({
    key: s.id,
    name: s.name,
    prefixes: s.pathPrefixes,
  }));
  buckets.push({ key: UNASSIGNED_SEGMENT, name: "Shared pages", prefixes: [] });
  return buckets;
}

/** The filter for one bucket. Shared is the complement of every other bucket. */
export function filterForBucket(
  bucket: PropertyBucket,
  allBuckets: readonly PropertyBucket[],
): unknown {
  if (bucket.key !== UNASSIGNED_SEGMENT) return landingPrefixFilter(bucket.prefixes);
  return sharedPagesFilter(allBuckets.flatMap((b) => b.prefixes));
}
