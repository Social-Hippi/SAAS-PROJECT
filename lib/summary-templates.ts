// Owner-summary templates (Part 3) — 4 patterns × 3 periods + a shared no_data
// template. Pure: no DB. The {placeholder} tokens are filled with formatted
// values; the {ifX: '...'} tokens are kept only when flag X is true (and their
// inner placeholders are then filled too). Honest tone — declines are named, but
// every line ends with what's working or what to do next.

export type Pattern = "strong" | "flat_or_slight_decline" | "significant_decline" | "no_data";
export type Period = "1d" | "7d" | "30d";

export type TemplateContext = {
  values: Record<string, string | number>;
  flags: Record<string, boolean>;
};

/**
 * Render a template: drop/keep {ifX:'…'} blocks by flag X (X is matched
 * case-insensitively on its first letter), then substitute {placeholder} tokens,
 * then tidy whitespace + stray spaces before punctuation.
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  const conditional = template.replace(/\{if([A-Za-z]+):\s*'([^']*)'\}/g, (_m, name: string, inner: string) => {
    const key = name.charAt(0).toLowerCase() + name.slice(1);
    return ctx.flags[key] ? inner : "";
  });
  const filled = conditional.replace(/\{(\w+)\}/g, (_m, key: string) =>
    key in ctx.values ? String(ctx.values[key]) : "",
  );
  // Collapse runs of whitespace, drop a stray space before sentence punctuation
  // (but NOT before an em-dash — that keeps its surrounding spaces), and fix the
  // "1 bookings" singular.
  return filled
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;])/g, "$1")
    .replace(/\b1 bookings\b/g, "1 booking")
    .trim();
}

export const NO_DATA_TEMPLATE =
  "No tracked bookings in this period yet. Make sure the HotelTrack snippet is installed on your hotel's website and visitors are completing bookings. Once data starts flowing, summaries will appear here automatically.";

// pattern → period → template.
export const TEMPLATES: Record<Exclude<Pattern, "no_data">, Record<Period, string>> = {
  strong: {
    "1d":
      "Yesterday brought {revenue} across {bookings} bookings. {topSource} was the top source.{ifAdSpend: ' ROAS for the day was {roas}.'} A good day to build on.",
    "7d":
      "Last 7 days were strong — {revenue} across {bookings} bookings{ifComparison: ', up {revenueChangePct}% from the week before'}. {topSource} drove your top revenue ({topSourceRevenue} from {topSourceBookings} bookings).{ifInfluencerActive: ' {influencerName} added {influencerRevenue}.'} Keep doing what's working.",
    "30d":
      "Last 30 days hit {revenue} across {bookings} bookings{ifComparison: ', up {revenueChangePct}% from the previous month'}. {topSource} led at {topSourceRevenue}.{ifSavings: ' Your direct bookings saved approximately {savings} in OTA commissions.'} Solid month.",
  },
  flat_or_slight_decline: {
    "1d":
      "Yesterday brought {revenue} across {bookings} bookings, a quieter day. {topSource} still contributed. Tomorrow's a fresh start.",
    "7d":
      "Last 7 days brought {revenue} across {bookings} bookings, slightly below the previous week's {previousRevenue}.{ifAvgValueShown: ' The good news: average booking value is {avgValueChangeDirection} {avgValueChangePctAbs}% — guests are spending {moreOrLess} per stay.'} Focus on driving traffic volume next week.",
    "30d":
      "Last 30 days totaled {revenue} across {bookings} bookings, slightly below the previous month. Average booking value held steady at {avgBookingValue}. Consider testing new ad creatives or influencer partnerships for next month.",
  },
  significant_decline: {
    "1d":
      "Yesterday was slow — {bookings} bookings.{ifZero: ' No bookings tracked.'} Single-day variation is normal — the 7-day view shows the bigger picture.",
    "7d":
      "Last 7 days were quiet — {bookings} bookings worth {revenue}, well below the recent average.{ifTrafficSteady: ' Direct traffic was steady, suggesting demand exists but conversions slipped.'}{ifInfluencerActive: ' Your influencer partnerships still drove {influencerRevenue}.'} Worth reviewing the booking flow.",
    "30d":
      "Last 30 days totaled {revenue} across {bookings} bookings, well below the prior month.{ifTopSourceStillStrong: ' {topSource} continued to perform with {topSourceRevenue}.'} Time to review what changed — ad performance, seasonality, or website conversions.",
  },
};

export function templateFor(pattern: Pattern, period: Period): string {
  if (pattern === "no_data") return NO_DATA_TEMPLATE;
  return TEMPLATES[pattern][period];
}

// ─────────────────────────────────────────────────────────────────────────────
// PERIOD NARRATIVE (Phase 6) and RECOMMENDED ACTIONS (Phase 9.6).
//
// Same engine as above — templates, computed values, threshold conditions. NO
// model call at render time, ever: a sentence generated from free text can
// assert something the data does not support, and this report is read by an
// owner deciding where to spend money.
//
// TWO RULES GOVERN EVERY SENTENCE HERE:
//
//   1. It must carry at least one COMPUTED FIGURE. A sentence that would read
//      identically for any period and any property is filler, and filler in a
//      report like this is worse than silence — it trains the reader to skim.
//
//   2. It must not assert CAUSATION between a channel and a contact. Nothing
//      records which channel produced a call, so "Google drove your enquiries"
//      is not a stronger claim than we can make, it is a false one.
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the narrative and the actions are allowed to talk about. */
export type NarrativeFacts = {
  periodLabel: string;
  comparisonLabel: string | null;
  /** Which property, or null for the whole group. */
  propertyName: string | null;

  visits: number;
  previousVisits: number | null;
  /** Signed fraction, e.g. -0.12. Null when there is no baseline. */
  visitChange: number | null;

  topSourceLabel: string | null;
  topSourceVisits: number | null;
  topSourceShare: number | null;

  /** 0-1. The "No source attached" bucket. */
  noSourceShare: number | null;
  aiAssistantVisits: number | null;
  metaVisits: number | null;

  /** 0-1 of group visits that belong to shared pages. */
  unassignedShare: number | null;

  recordedContacts: number | null;
  roomNightsConfirmed: number | null;
  trackerCompleteThrough: string | null;
  trackerDaysMissing: number;
  /** Properties in scope with no tracker rows at all this period. */
  propertiesMissingData: string[];

  /** Bookings HotelTrack measured itself. */
  measuredBookings: number;

  /** Sources whose newest data predates the end of the period. */
  staleSources: { label: string; lastUpdated: string }[];

  /** 0-1 share of contacts lost to sold-out / rate / room size. */
  lostToAvailabilityShare: number | null;
  /** Change in junk share against the comparison window, in POINTS. */
  junkShareDeltaPoints: number | null;

  /** Highest-spend campaign with no recorded click or conversion. */
  topNoOutcomeCampaign: { name: string; spend: string } | null;
};

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const points = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(1)} points`;
const num = (v: number): string => v.toLocaleString("en-IN");

type Rule = {
  id: string;
  /** Null to skip. Otherwise the finished sentence. */
  render: (f: NarrativeFacts) => string | null;
};

/**
 * Ordered so the narrative reads as an argument rather than a list: what the
 * period was, where it came from, what we cannot see, what the property's own
 * team recorded, and finally what is broken.
 */
const NARRATIVE_RULES: Rule[] = [
  {
    id: "scope",
    render: (f) =>
      f.propertyName
        ? renderTemplate(
            "These figures describe {property} only, for {period}.",
            { values: { property: f.propertyName, period: f.periodLabel }, flags: {} },
          )
        : null,
  },
  {
    id: "traffic",
    render: (f) => {
      if (f.visits === 0) {
        return renderTemplate("No website visits were recorded in {period}.", {
          values: { period: f.periodLabel }, flags: {},
        });
      }
      if (f.visitChange == null || f.previousVisits == null) {
        return renderTemplate(
          "{visits} website visits in {period}. There is no comparable earlier window, so no change is shown.",
          { values: { visits: num(f.visits), period: f.periodLabel }, flags: {} },
        );
      }
      const dir = f.visitChange >= 0 ? "up" : "down";
      return renderTemplate(
        "{visits} website visits in {period}, {dir} {change} from {prev} in {comparison}.",
        {
          values: {
            visits: num(f.visits), period: f.periodLabel, dir,
            change: pct(Math.abs(f.visitChange)), prev: num(f.previousVisits),
            comparison: f.comparisonLabel ?? "the previous window",
          },
          flags: {},
        },
      );
    },
  },
  {
    id: "top_source",
    render: (f) =>
      f.topSourceLabel && f.topSourceVisits != null && f.topSourceShare != null
        ? renderTemplate(
            "The largest identified source was {source}, with {sourceVisits} visits ({share} of the total).",
            {
              values: {
                source: f.topSourceLabel, sourceVisits: num(f.topSourceVisits),
                share: pct(f.topSourceShare),
              },
              flags: {},
            },
          )
        : null,
  },
  {
    id: "untagged",
    render: (f) =>
      f.noSourceShare != null && f.noSourceShare > 0.35
        ? renderTemplate(
            "{share} of visits arrived with no source tag. That bucket mixes direct visits, organic search and untagged links, and the system cannot currently separate them from one another. Tagging outbound links is the cheapest gain available here.",
            { values: { share: pct(f.noSourceShare) }, flags: {} },
          )
        : null,
  },
  {
    id: "ai_over_meta",
    render: (f) =>
      f.aiAssistantVisits != null &&
      f.metaVisits != null &&
      f.aiAssistantVisits > f.metaVisits
        ? renderTemplate(
            "AI assistants sent more visits than Meta and Instagram this period — {ai} against {meta}. That ordering is worth knowing; it is not yet a channel anyone is managing.",
            { values: { ai: num(f.aiAssistantVisits), meta: num(f.metaVisits) }, flags: {} },
          )
        : null,
  },
  {
    id: "unassigned",
    render: (f) =>
      f.unassignedShare != null && f.unassignedShare > 0.2 && f.propertyName == null
        ? renderTemplate(
            "{share} of visits were on pages shared by both properties, so they belong to the group rather than to either one. They are counted once and never split between them.",
            { values: { share: pct(f.unassignedShare) }, flags: {} },
          )
        : null,
  },
  {
    id: "contacts",
    render: (f) =>
      f.recordedContacts != null
        ? renderTemplate(
            "The property's own team recorded {contacts} customer contacts in this period. Nothing records which marketing channel produced them, so they are not attributable to Google, to Meta, or to anything else.",
            { values: { contacts: num(f.recordedContacts) }, flags: {} },
          )
        : null,
  },
  {
    id: "room_nights",
    render: (f) =>
      f.roomNightsConfirmed != null
        ? renderTemplate(
            "{nights} room nights were confirmed, again recorded by the property rather than measured by HotelTrack, and not attributable to a channel.",
            { values: { nights: num(f.roomNightsConfirmed) }, flags: {} },
          )
        : null,
  },
  {
    id: "tracker_incomplete",
    render: (f) =>
      f.trackerDaysMissing > 0 && f.trackerCompleteThrough
        ? renderTemplate(
            "Operations data is complete through {through}; {missing} days in this period have no tracker row and are excluded rather than counted as zero.",
            {
              values: { through: f.trackerCompleteThrough, missing: String(f.trackerDaysMissing) },
              flags: {},
            },
          )
        : null,
  },
  {
    id: "one_property_only",
    render: (f) =>
      f.propertiesMissingData.length > 0
        ? renderTemplate(
            "No tracker data was recorded for {names} in this period, so the contact figures above describe the other property only.",
            { values: { names: f.propertiesMissingData.join(" or ") }, flags: {} },
          )
        : null,
  },
  {
    id: "no_bookings_measured",
    render: (f) =>
      f.measuredBookings === 0
        ? "Booking confirmations are not connected to website sessions, so HotelTrack measured no bookings in this period. That is a wiring gap, not a result."
        : null,
  },
  {
    id: "stale",
    render: (f) =>
      f.staleSources.length > 0
        ? renderTemplate(
            "{sources} last updated before the end of this period, so the figures in {those} block{plural} do not cover the whole window.",
            {
              values: {
                sources: f.staleSources.map((x) => `${x.label} (${x.lastUpdated})`).join(" and "),
                those: f.staleSources.length === 1 ? "that" : "those",
                plural: f.staleSources.length === 1 ? "" : "s",
              },
              flags: {},
            },
          )
        : null,
  },
];

/**
 * The period narrative: every sentence that the data supports, in order.
 *
 * The "no_bookings_measured" sentence is deliberately the only one without a
 * computed figure — it states an absence, and inventing a number to satisfy the
 * rule would be worse than the exception.
 */
export function buildPeriodNarrative(facts: NarrativeFacts): string[] {
  return NARRATIVE_RULES.map((r) => r.render(facts)).filter((x): x is string => Boolean(x));
}

// ── Recommended actions (9.6) ───────────────────────────────────────────────

export type RecommendedAction = {
  id: string;
  text: string;
  /** Who acts. The report is read by the owner; some of these are the agency's. */
  owner: "agency" | "property";
  /**
   * Ranking key — the SIZE of the thing behind the action, normalised to 0-1
   * where comparable. Ranked by this rather than by the order they are written,
   * so the biggest number is the first thing read.
   */
  magnitude: number;
};

export function buildRecommendedActions(f: NarrativeFacts): RecommendedAction[] {
  const out: RecommendedAction[] = [];

  if (f.noSourceShare != null && f.noSourceShare > 0.35) {
    out.push({
      id: "tagging",
      owner: "agency",
      magnitude: f.noSourceShare,
      text: renderTemplate(
        "Tag outbound links. {share} of visits arrive with no source at all, so that share of demand cannot be credited to any channel — this is the cheapest measurement gain available.",
        { values: { share: pct(f.noSourceShare) }, flags: {} },
      ),
    });
  }

  if (f.lostToAvailabilityShare != null && f.lostToAvailabilityShare > 0.15) {
    out.push({
      id: "availability",
      owner: "property",
      magnitude: f.lostToAvailabilityShare,
      text: renderTemplate(
        "Review rates and availability. {share} of recorded contacts were lost to sold-out dates, rate or room size — demand the marketing produced and the property could not serve.",
        { values: { share: pct(f.lostToAvailabilityShare) }, flags: {} },
      ),
    });
  }

  if (f.junkShareDeltaPoints != null && f.junkShareDeltaPoints > 5) {
    out.push({
      id: "junk",
      owner: "agency",
      magnitude: Math.min(1, f.junkShareDeltaPoints / 100),
      text: renderTemplate(
        "Review targeting and lead-form quality. The junk and spam share of contacts moved {delta} against the comparison period.",
        { values: { delta: points(f.junkShareDeltaPoints) }, flags: {} },
      ),
    });
  }

  if (f.aiAssistantVisits != null && f.metaVisits != null && f.aiAssistantVisits > f.metaVisits) {
    out.push({
      id: "ai_visibility",
      owner: "agency",
      magnitude: f.visits > 0 ? f.aiAssistantVisits / f.visits : 0,
      text: renderTemplate(
        "Work on visibility to AI assistants. They sent {ai} visits against {meta} from Meta and Instagram, and nobody is currently managing that surface.",
        { values: { ai: num(f.aiAssistantVisits), meta: num(f.metaVisits) }, flags: {} },
      ),
    });
  }

  for (const src of f.staleSources) {
    out.push({
      id: `stale_${src.label.toLowerCase().replace(/\s+/g, "_")}`,
      owner: "agency",
      // Ranked high: a stale source makes every figure under it suspect.
      magnitude: 0.9,
      text: renderTemplate(
        "Fix the {source} integration. Its data last updated {when}, before this period ended, so the figures under it do not cover the whole window.",
        { values: { source: src.label, when: src.lastUpdated }, flags: {} },
      ),
    });
  }

  if (f.topNoOutcomeCampaign) {
    out.push({
      id: "no_outcome_spend",
      owner: "agency",
      magnitude: 0.5,
      text: renderTemplate(
        "Review {campaign}. It spent {spend} in this period with no click or conversion recorded — which may mean it is producing calls the system cannot see, so check before pausing it.",
        {
          values: { campaign: f.topNoOutcomeCampaign.name, spend: f.topNoOutcomeCampaign.spend },
          flags: {},
        },
      ),
    });
  }

  if (f.measuredBookings === 0) {
    out.push({
      id: "booking_link",
      owner: "agency",
      // The single change that unlocks channel attribution for everything else.
      magnitude: 0.95,
      text: renderTemplate(
        "Connect the booking-engine hand-off. No booking was measured in {period}, and until confirmations carry the session across to the booking engine, no revenue can be credited to any channel.",
        { values: { period: f.periodLabel }, flags: {} },
      ),
    });
  }

  // Ranked by the size of the thing behind them, capped at five. Never padded:
  // fewer than three is a correct outcome when fewer than three conditions fire.
  return out.sort((a, b) => b.magnitude - a.magnitude).slice(0, 5);
}
