import { classifySourceType, type SourceType } from "@/lib/source-classifier";
import { isMetaClick, type ClickIds } from "@/lib/click-ids";
import { ok, unavailable, type MetricValue } from "@/lib/metrics/metric-value";

// ─────────────────────────────────────────────────────────────────────────────
// WHERE DEMAND COMES FROM.
//
// This buckets VISITS for the source-composition section. It is a different
// question from `SourceType`, which buckets REVENUE for attribution, and the two
// must not be conflated:
//
//   • "Meta & Instagram" here combines paid and organic, because a hotel owner
//     asking where their visitors came from means the channel, not the billing
//     arrangement. SourceType keeps them apart because only the paid half may
//     appear in a ROAS numerator.
//
//   • fbclid lands here in the Meta bucket but NEVER makes a conversion
//     `meta_ads`. Meta appends fbclid to organic post links too, so it proves
//     the surface, not the spend (see lib/click-ids.ts isMetaClick).
//
// So this DERIVES from classifySourceType rather than re-implementing it — one
// classifier, two questions — and adds only the two rules the attribution
// classifier deliberately does not apply.
// ─────────────────────────────────────────────────────────────────────────────

export const DEMAND_BUCKETS = [
  "google_ads",
  "meta_instagram",
  "ai_assistants",
  "google_hotel_ads",
  "email",
  "referral_other",
  "no_source",
] as const;
export type DemandBucket = (typeof DEMAND_BUCKETS)[number];

export const DEMAND_BUCKET_LABEL: Record<DemandBucket, string> = {
  google_ads: "Google Ads",
  meta_instagram: "Meta & Instagram",
  ai_assistants: "AI assistants",
  google_hotel_ads: "Google Hotel Ads",
  email: "Email",
  referral_other: "Referral & other tagged",
  no_source: "No source attached",
};

/** What each bucket means, for the methodology panel (Phase 9.5). */
export const DEMAND_BUCKET_DEFINITION: Record<DemandBucket, string> = {
  google_ads:
    "Visits carrying a Google Ads click identifier (gclid, gbraid or wbraid), or tagged with a paid Google medium.",
  meta_instagram:
    "Visits from Facebook or Instagram, paid or organic, including those carrying a Meta click identifier (fbclid).",
  ai_assistants:
    "Visits referred by an AI assistant — ChatGPT, Perplexity, Copilot, Gemini, Claude or you.com.",
  google_hotel_ads:
    "Visits tagged with the Google Hotel Ads medium. A distinct product from Google Ads search, with its own economics.",
  email: "Visits tagged with an email medium.",
  referral_other:
    "Visits carrying some other source tag we do not have a named bucket for.",
  no_source:
    "Visits with no source tag at all. This mixes direct visits, organic search and untagged links, and they cannot be separated from one another.",
};

/** The subset of a visit this needs. Structural, so any query shape can pass. */
export type DemandRow = ClickIds & {
  utmSource: string | null | undefined;
  utmMedium: string | null | undefined;
  utmContent?: string | null | undefined;
};

const SOURCE_TYPE_TO_BUCKET: Record<SourceType, DemandBucket> = {
  google_ads: "google_ads",
  google_hotel_ads: "google_hotel_ads",
  ai_assistant: "ai_assistants",
  meta_ads: "meta_instagram",
  instagram_organic: "meta_instagram",
  facebook_organic: "meta_instagram",
  email: "email",
  // Neither is a demand SOURCE — both are ways a visit was tagged, and both
  // carry a source, so they belong with the other tagged traffic.
  influencer: "referral_other",
  whatsapp: "referral_other",
  other: "referral_other",
  // classifySourceType returns `direct` exactly when there is no source tag.
  direct: "no_source",
};

/** Sources that name Meta even without a paid medium. */
const META_SOURCES = new Set(["ig", "instagram", "fb", "facebook", "meta"]);

/**
 * First-match-wins, in the order documented on the report.
 *
 * The order matters at exactly one place: a visit carrying BOTH a Google click
 * id and a Meta source is counted as Google Ads, because a click identifier is
 * deterministic evidence of the click that produced the visit and a source tag
 * is not.
 */
export function demandBucketOf(row: DemandRow): DemandBucket {
  const byType = classifySourceType({
    utmSource: row.utmSource ?? null,
    utmMedium: row.utmMedium ?? null,
    utmContent: row.utmContent ?? null,
    gclid: row.gclid ?? null,
    gbraid: row.gbraid ?? null,
    wbraid: row.wbraid ?? null,
    fbclid: row.fbclid ?? null,
  });

  // Google click identity already won inside the classifier.
  if (byType === "google_ads") return "google_ads";

  // The two rules the attribution classifier deliberately does not apply.
  const source = String(row.utmSource ?? "").trim().toLowerCase();
  if (isMetaClick(row) || META_SOURCES.has(source)) return "meta_instagram";

  return SOURCE_TYPE_TO_BUCKET[byType];
}

export type DemandComposition = {
  bucket: DemandBucket;
  label: string;
  visits: number;
  /** Distinct sessions among those visits. A secondary figure, never a bar. */
  sessions: number;
  /** Share of total visits, 0-1. */
  share: number;
  /**
   * Signed change against the comparison window.
   *
   * UNAVAILABLE when the comparison window recorded nothing for this bucket —
   * not +100%, which asserts growth from a measured zero, and not 0%, which
   * asserts no change. We did not measure it.
   */
  change: MetricValue<number>;
};

type CountedRow = DemandRow & { sessionId?: string | null };

function tally(rows: readonly CountedRow[]): Map<DemandBucket, { visits: number; sessions: Set<string> }> {
  const out = new Map<DemandBucket, { visits: number; sessions: Set<string> }>();
  for (const b of DEMAND_BUCKETS) out.set(b, { visits: 0, sessions: new Set() });
  for (const row of rows) {
    const entry = out.get(demandBucketOf(row))!;
    entry.visits += 1;
    const sid = row.sessionId;
    if (sid) entry.sessions.add(sid);
  }
  return out;
}

/**
 * Compose the period's demand, ordered by visits descending.
 *
 * Buckets with no visits in EITHER window are dropped: a row of zeros for a
 * channel the property has never used is noise, not information. A bucket
 * present in the comparison window but absent now IS kept, because that is a
 * real change worth seeing.
 */
export function composeDemand(
  rows: readonly CountedRow[],
  previousRows: readonly CountedRow[] = [],
): { rows: DemandComposition[]; totalVisits: number } {
  const now = tally(rows);
  const prev = tally(previousRows);
  const totalVisits = rows.length;

  const out: DemandComposition[] = [];
  for (const bucket of DEMAND_BUCKETS) {
    const cur = now.get(bucket)!;
    const before = prev.get(bucket)!;
    if (cur.visits === 0 && before.visits === 0) continue;

    out.push({
      bucket,
      label: DEMAND_BUCKET_LABEL[bucket],
      visits: cur.visits,
      sessions: cur.sessions.size,
      share: totalVisits === 0 ? 0 : cur.visits / totalVisits,
      change:
        previousRows.length === 0
          ? unavailable("There is no comparison period to measure against.")
          : before.visits === 0
            ? unavailable(
                `No visits were recorded from ${DEMAND_BUCKET_LABEL[bucket]} in the comparison period, ` +
                  `so there is no baseline to compare against.`,
              )
            : ok((cur.visits - before.visits) / before.visits),
    });
  }

  return { rows: out.sort((a, b) => b.visits - a.visits), totalVisits };
}
