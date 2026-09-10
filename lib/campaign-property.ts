import { UNASSIGNED_SEGMENT } from "@/lib/segments";

// ─────────────────────────────────────────────────────────────────────────────
// WHICH PROPERTY DOES A CAMPAIGN SELL?
//
// A Meta campaign carries NO property field. The only signal is the name a
// person typed, and Aster's names do carry one:
//
//   SH|CBH| Sales campaign                     -> Coffeeberry Hills
//   ANG - Leads WhatsApp - 3 Hills - 2026      -> Three Hills
//   SH|THC | COUPLES | SALES-WA                -> Three Hills
//   SH|Independence                            -> nothing
//
// So this is an INFERENCE FROM A NAMING CONVENTION, and it is treated as one:
//
//   • the patterns are DATA (PropertySegment.campaignNamePatterns), so an agency
//     can correct them without a deploy — the same choice pathPrefixes made;
//   • a campaign matching NOTHING goes to a visible Unassigned row. It is never
//     split across properties by spend share, by impressions, or by anything
//     else. Dividing one campaign's spend between two properties would invent
//     two numbers from one, which is the thing this codebase exists to refuse;
//   • a campaign matching MORE THAN ONE property is also Unassigned, not
//     awarded to the first or the longest match. Two properties claiming one
//     campaign is a broken rule set, and quietly picking a winner would hide it.
//
// Measured on Aster's real campaigns: 5 of 6 match, covering ₹16,074 of ₹16,540
// spend. The remaining campaign is genuinely unattributable from its name.
// ─────────────────────────────────────────────────────────────────────────────

export type CampaignSegmentRule = {
  id: string;
  name: string;
  campaignNamePatterns: string[];
};

export type CampaignMatch = {
  /** A PropertySegment id, or UNASSIGNED_SEGMENT. */
  segmentKey: string;
  /** Why: the patterns that matched, for showing the reader the rule. */
  matchedPatterns: string[];
  /** True when two or more properties claimed it — a rule-set fault, not data. */
  ambiguous: boolean;
};

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Match one campaign name to a property.
 *
 * Substring, case-insensitive, whitespace-collapsed — because the names contain
 * "3 Hills", "3Hills" and "THC" for the same property, and a person typing them
 * into Meta is not being consistent about separators.
 */
export function matchCampaignToSegment(
  campaignName: string,
  segments: readonly CampaignSegmentRule[],
): CampaignMatch {
  const haystack = norm(campaignName);

  const hits = segments
    .map((seg) => ({
      seg,
      patterns: seg.campaignNamePatterns.filter((p) => {
        const needle = norm(p);
        return needle.length > 0 && haystack.includes(needle);
      }),
    }))
    .filter((h) => h.patterns.length > 0);

  if (hits.length === 0) {
    return { segmentKey: UNASSIGNED_SEGMENT, matchedPatterns: [], ambiguous: false };
  }
  if (hits.length > 1) {
    // Deliberately NOT "most specific wins". A campaign both properties claim
    // means the patterns overlap, and the fix is to correct the patterns — which
    // only happens if the ambiguity is visible.
    return {
      segmentKey: UNASSIGNED_SEGMENT,
      matchedPatterns: hits.flatMap((h) => h.patterns),
      ambiguous: true,
    };
  }
  return {
    segmentKey: hits[0]!.seg.id,
    matchedPatterns: hits[0]!.patterns,
    ambiguous: false,
  };
}

/** Group campaigns by property, preserving each group's input order. */
export function groupCampaignsByProperty<T extends { campaignName: string }>(
  campaigns: readonly T[],
  segments: readonly CampaignSegmentRule[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  // Every property gets a key even with no campaigns, so the report can show
  // "no campaigns ran for this property" rather than omitting it and leaving a
  // reader to wonder whether it was forgotten.
  for (const seg of segments) out.set(seg.id, []);
  for (const c of campaigns) {
    const { segmentKey } = matchCampaignToSegment(c.campaignName, segments);
    const bucket = out.get(segmentKey) ?? [];
    bucket.push(c);
    out.set(segmentKey, bucket);
  }
  return out;
}
