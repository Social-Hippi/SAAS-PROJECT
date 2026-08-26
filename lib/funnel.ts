// Funnel-stage logic — pure, no DB, no "server-only", so the tracking ingest,
// the dashboard aggregation, the backfill script, and the tests can all import it.
//
// Stages are ordered awareness(1) → consideration(2) → intent(3) → booking(4).
// A visitor "reaches" a stage when a page tags it (data-ht-stage) or the page
// path matches one of the hotel's funnelStageRules.

export const STAGES = ["awareness", "consideration", "intent", "booking"] as const;
export type FunnelStage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<FunnelStage, string> = {
  awareness: "Awareness",
  consideration: "Consideration",
  intent: "Intent",
  booking: "Booking",
};

/** 1-based rank (awareness=1 … booking=4), or 0 for an invalid stage. */
export function stageRank(stage: string | null | undefined): number {
  const i = STAGES.indexOf((stage ?? "") as FunnelStage);
  return i < 0 ? 0 : i + 1;
}

export function isFunnelStage(v: unknown): v is FunnelStage {
  return typeof v === "string" && (STAGES as readonly string[]).includes(v);
}

export type FunnelRule = { urlPattern: string; stage: FunnelStage };

// Sensible starter rules for a typical hotel site (the "Sensible defaults" button).
export const SENSIBLE_DEFAULTS: FunnelRule[] = [
  { urlPattern: "/", stage: "awareness" },
  { urlPattern: "/rooms*", stage: "consideration" },
  { urlPattern: "/book*", stage: "intent" },
  { urlPattern: "/thank-you", stage: "booking" },
];

/** Strip a trailing slash except for the root path; lower-case for matching. */
function normalizePath(p: string): string {
  const lower = p.toLowerCase();
  return lower.length > 1 && lower.endsWith("/") ? lower.slice(0, -1) : lower;
}

/**
 * Does `path` match `pattern`? A pattern with no `*` is an exact match
 * (case-insensitive, trailing-slash tolerant). A pattern containing `*` is a
 * glob anchored at both ends, so `/rooms*` matches `/rooms`, `/rooms/deluxe`,
 * `/rooms/deluxe/photos`. Other regex metacharacters are escaped.
 */
export function matchUrlPattern(pattern: string, path: string): boolean {
  if (!pattern) return false;
  const pat = pattern.toLowerCase();
  const target = normalizePath(path);
  if (pat.indexOf("*") < 0) return normalizePath(pat) === target;
  // Escape regex specials, then turn the escaped "*" back into ".*".
  const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  try {
    return new RegExp(`^${escaped}$`).test(target);
  } catch {
    return false;
  }
}

/** Validate/normalize the HotelClient.funnelStageRules Json column into rules. */
export function parseFunnelRules(json: unknown): FunnelRule[] {
  if (!Array.isArray(json)) return [];
  const out: FunnelRule[] = [];
  for (const raw of json) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const urlPattern = typeof r.urlPattern === "string" ? r.urlPattern.trim() : "";
    const stage = r.stage;
    if (urlPattern && isFunnelStage(stage)) out.push({ urlPattern, stage });
  }
  return out;
}

/** First rule (in array order) whose pattern matches the path, else null. */
export function resolveStageFromRules(
  rules: FunnelRule[],
  path: string,
): FunnelStage | null {
  for (const rule of rules) {
    if (matchUrlPattern(rule.urlPattern, path)) return rule.stage;
  }
  return null;
}

// ── Evidence-based stage resolution ──────────────────────────────────────────
//
// Path rules require a hotel to describe its own site, and most never do —
// every Aster PageView has funnelStage NULL because funnelStageRules is unset.
// Rather than guess from page names, derive the one stage we hold HARD evidence
// for: a visitor who has landed on the hotel's own booking engine has, by
// definition, reached booking INTENT. The host list is server-side
// configuration (HotelClient.bookingDomains), never client-guessable, so this
// is evidence rather than inference.
//
// Deliberately NOT inferred: `consideration`. There is no reliable signal for
// it — "viewed 2+ pages" is a guess, so it stays rule-driven.

/**
 * Stage implied by WHERE the pageview happened. Returns "intent" when the URL's
 * host is one of the hotel's configured booking domains, else null.
 *
 * Takes precedence over path rules because the host is stronger evidence than
 * the path: a booking engine's landing page is often "/", which a hotel rule
 * mapping "/" to awareness would otherwise mislabel.
 */
export function resolveStageFromBookingDomain(
  pageUrl: string | null | undefined,
  bookingDomains: readonly string[] | null | undefined,
): FunnelStage | null {
  if (!pageUrl || !bookingDomains?.length) return null;
  let host = "";
  try { host = new URL(pageUrl).host.toLowerCase().replace(/\.$/, ""); } catch { return null; }
  if (!host) return null;
  for (const d of bookingDomains) {
    const t = String(d ?? "").trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    // Exact host or a true subdomain — never a bare suffix.
    if (t && (host === t || host.endsWith("." + t))) return "intent";
  }
  return null;
}

/**
 * Full precedence for a pageview's stage:
 *   1. what the page declared   (data-ht-stage — the hotel said so explicitly)
 *   2. booking-domain evidence  (we observed them ON the booking engine)
 *   3. the hotel's path rules   (hotel-authored, but weaker than 1 and 2)
 * Null when nothing applies — never a guess.
 */
export function resolvePageStage(opts: {
  declaredStage?: unknown;
  pageUrl?: string | null;
  bookingDomains?: readonly string[] | null;
  rules?: FunnelRule[];
  path: string;
}): FunnelStage | null {
  if (isFunnelStage(opts.declaredStage)) return opts.declaredStage;
  const byHost = resolveStageFromBookingDomain(opts.pageUrl, opts.bookingDomains);
  if (byHost) return byHost;
  return resolveStageFromRules(opts.rules ?? [], opts.path);
}

// ── Aggregate funnel (pure) ───────────────────────────────────────────────────

export type FunnelStageStat = {
  stage: FunnelStage;
  label: string;
  /** Unique sessions that reached AT LEAST this stage (cumulative funnel). */
  visitors: number;
  /** visitors(this) / visitors(prev); 1 for the first stage; null when prev = 0. */
  conversionFromPrev: number | null;
  /** Sessions lost between this stage and the next (0 for the last stage). */
  dropOff: number;
  /** dropOff / visitors(this); null when visitors(this) = 0. */
  dropOffPct: number | null;
  /** Avg ms from reaching this stage to the next, when timing is available. */
  avgTimeToNextMs: number | null;
};

export type FunnelResult = {
  stages: FunnelStageStat[];
  /** Sessions that reached booking. */
  conversions: number;
  /** Sum of booking revenue in the range. */
  revenue: number;
  /** Overall booking ÷ awareness rate (null when no awareness sessions). */
  overallConversion: number | null;
};

/**
 * Build the funnel from a per-rank session-count map (`reachedByRank[r]` = number
 * of sessions whose HIGHEST stage rank is exactly r), the booking revenue, and an
 * optional avg-time-to-next map keyed by stage. Counts are made cumulative here
 * (a session at rank r counts toward every stage ≤ r), yielding the monotonic
 * funnel HotelTrack shows.
 */
export function computeFunnel(opts: {
  reachedByRank: Record<number, number>;
  revenue: number;
  avgTimeToNextMs?: Partial<Record<FunnelStage, number | null>>;
}): FunnelResult {
  const { reachedByRank, revenue, avgTimeToNextMs = {} } = opts;
  // Cumulative: visitors at stage k = sessions with highest rank >= k.
  const visitorsAt = (k: number): number => {
    let sum = 0;
    for (let r = k; r <= STAGES.length; r++) sum += reachedByRank[r] ?? 0;
    return sum;
  };

  const stages: FunnelStageStat[] = STAGES.map((stage, idx) => {
    const k = idx + 1;
    const visitors = visitorsAt(k);
    const next = k < STAGES.length ? visitorsAt(k + 1) : 0;
    const prev = k > 1 ? visitorsAt(k - 1) : null;
    return {
      stage,
      label: STAGE_LABEL[stage],
      visitors,
      conversionFromPrev: k === 1 ? 1 : prev && prev > 0 ? visitors / prev : null,
      dropOff: k < STAGES.length ? Math.max(0, visitors - next) : 0,
      dropOffPct:
        k < STAGES.length && visitors > 0 ? Math.max(0, visitors - next) / visitors : null,
      avgTimeToNextMs: avgTimeToNextMs[stage] ?? null,
    };
  });

  const awareness = visitorsAt(1);
  const conversions = visitorsAt(STAGES.length);
  return {
    stages,
    conversions,
    revenue,
    overallConversion: awareness > 0 ? conversions / awareness : null,
  };
}
