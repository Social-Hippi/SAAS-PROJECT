// ─────────────────────────────────────────────────────────────────────────────
// PROPERTY SEGMENTATION.
//
// Aster Holidays is one HotelClient covering two properties — Coffeeberry Hills
// and Three Hills. Both appear in the same website traffic and each keeps its own
// operations workbook. This classifies a visit or a conversion to one of them.
//
// UNASSIGNED IS A FIRST-CLASS ANSWER, not a failure. The home page, the blog and
// every shared page belong to the GROUP, not to a property, and there is no
// honest way to attribute them to one. Unassigned is rendered as its own visible
// row and is NEVER distributed across properties by ratio, by traffic share, or
// by any other estimate — that would be inventing per-property numbers out of
// group numbers, which is precisely what this module exists to prevent.
//
// The rules are DATA (PropertySegment.pathPrefixes / bookingHosts), so they can
// be corrected by someone who cannot deploy. An empty rule set matches nothing,
// which is the safe failure: traffic falls to Unassigned, visibly.
// ─────────────────────────────────────────────────────────────────────────────

/** The bucket for traffic that belongs to the group rather than a property. */
export const UNASSIGNED_SEGMENT = "unassigned";

export type SegmentRule = {
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
  /** Matched against a URL PATH, case-insensitively, as a prefix. */
  pathPrefixes: string[];
  /** Matched against a URL HOST, case-insensitively (exact or subdomain). */
  bookingHosts: string[];
};

/** Lower-cased path of a URL, or null when it cannot be read. */
export function pathOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;
  try {
    return new URL(text.includes("://") ? text : `https://example.invalid${text.startsWith("/") ? "" : "/"}${text}`)
      .pathname.toLowerCase();
  } catch {
    // A bare path that URL() still refused (control characters, say).
    return text.startsWith("/") ? text.split(/[?#]/)[0]!.toLowerCase() : null;
  }
}

/** Lower-cased host of an absolute URL, or null. */
export function hostOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text.includes("://")) return null;
  try {
    return new URL(text).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function hostMatches(host: string, candidate: string): boolean {
  const c = candidate.trim().toLowerCase().replace(/^www\./, "");
  if (!c) return false;
  return host === c || host.endsWith(`.${c}`);
}

function pathMatches(path: string, prefix: string): boolean {
  const p = prefix.trim().toLowerCase();
  if (!p) return false;
  return path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`) || path.startsWith(p);
}

/**
 * Classify a VISIT by page path.
 *
 * First match wins, in displayOrder, so overlapping prefixes resolve
 * deterministically rather than by whichever row the database returned first.
 */
export function classifyVisit(
  pageUrl: string | null | undefined,
  segments: readonly SegmentRule[],
): string {
  const path = pathOf(pageUrl);
  if (!path) return UNASSIGNED_SEGMENT;

  for (const seg of [...segments].sort((a, b) => a.displayOrder - b.displayOrder)) {
    if (seg.pathPrefixes.some((p) => pathMatches(path, p))) return seg.id;
  }
  return UNASSIGNED_SEGMENT;
}

/**
 * Classify a CONVERSION.
 *
 * Booking host first, then page path. The host is the stronger signal: a booking
 * completes on the property's own booking engine (bookings.coffeeberryhills.in),
 * which names the property unambiguously, while the path on that host is the
 * engine's own and says nothing.
 */
export function classifyConversion(
  pageUrl: string | null | undefined,
  segments: readonly SegmentRule[],
): string {
  const ordered = [...segments].sort((a, b) => a.displayOrder - b.displayOrder);

  const host = hostOf(pageUrl);
  if (host) {
    for (const seg of ordered) {
      if (seg.bookingHosts.some((h) => hostMatches(host, h))) return seg.id;
    }
  }

  return classifyVisit(pageUrl, ordered);
}

export type SegmentCounts = {
  /** segment id -> count. */
  bySegment: Record<string, number>;
  unassigned: number;
  total: number;
};

/**
 * Count rows per segment.
 *
 * The returned shape satisfies an invariant the tests assert directly:
 *   sum(bySegment) + unassigned === total
 * Every row lands in exactly one bucket. If that ever stops holding, a row is
 * being counted twice or dropped, and either is a reporting defect.
 */
export function countBySegment(
  rows: readonly { pageUrl: string | null }[],
  segments: readonly SegmentRule[],
  classify: (url: string | null | undefined, segs: readonly SegmentRule[]) => string = classifyVisit,
): SegmentCounts {
  const bySegment: Record<string, number> = {};
  for (const seg of segments) bySegment[seg.id] = 0;
  let unassigned = 0;

  for (const row of rows) {
    const id = classify(row.pageUrl, segments);
    if (id === UNASSIGNED_SEGMENT || !(id in bySegment)) {
      unassigned += 1;
      continue;
    }
    bySegment[id] += 1;
  }

  return { bySegment, unassigned, total: rows.length };
}

/** Share of traffic that could not be attributed to a property, 0-1. */
export function unassignedShare(counts: SegmentCounts): number | null {
  return counts.total === 0 ? null : counts.unassigned / counts.total;
}
