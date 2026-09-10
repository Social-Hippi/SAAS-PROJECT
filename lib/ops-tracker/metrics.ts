import {
  isOk,
  notApplicable,
  ok,
  unavailable,
  type MetricValue,
} from "@/lib/metrics/metric-value";

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE TRACKERS ACTUALLY SAY.
//
// Three things about these sheets govern everything in this file.
//
// 1 · "Rm Nts Confirmed" COUNTS ROOM NIGHTS, NOT BOOKINGS. One booking can be
//     several nights. It is never labelled bookings, and any ratio built from it
//     is a yield figure, not a conversion rate — which is why Three Hills reads
//     150% on 15 August (6 room nights against 4 calls) without anything being
//     broken.
//
// 2 · NEITHER "Conversion Rate" COLUMN IS A CONVERSION RATE, and the two are not
//     even the same formula:
//        Coffeeberry Hills: (Rm Nts Confirmed + WhatsApp Confirmed) / Total Leads
//        Three Hills:        Rm Nts Confirmed / Total Calls Received
//     Stored values are audited here and NEVER rendered. Everything displayed is
//     recomputed from components, identically for both properties, so the two
//     are comparable — which as stored they are not.
//
// 3 · THE COMPONENTS DO NOT RECONCILE EITHER. On Coffeeberry Hills, CBH Enquiry
//     + WhatsApp Leads differs from Total Leads by 1-2 on sampled rows. On Three
//     Hills the disposition columns sum far above Total Calls Received (31 Jul:
//     26 dispositions against 9 calls). These are hand-typed sheets carrying
//     internal contradictions, so every relationship is checked across every row
//     and the disagreements are counted and reported rather than smoothed over.
//
// Where a contradiction is large enough that neither the stored value nor the
// computed one can be trusted, the figure renders unavailable. That is a result,
// not a failure.
// ─────────────────────────────────────────────────────────────────────────────

/** A stored tracker day, as the report reads it. Nulls mean NOT RECORDED. */
export type TrackerDay = {
  date: string; // YYYY-MM-DD
  enquiries: number | null;
  repeatContacts: number | null;
  roomNightsConfirmed: number | null;
  junkSpam: number | null;
  soldOut: number | null;
  inhouse: number | null;
  lowBudget: number | null;
  lessRoom: number | null;
  whatsappLeads: number | null;
  whatsappConfirmed: number | null;
  totalCallsReceived: number | null;
  storedTotalLeads: number | null;
  storedConversionRate: number | null;
};

/**
 * Above this, a stored figure and its own components disagree so badly that
 * neither can be trusted and the derived metric renders unavailable. Below it,
 * the components win and the variance is recorded.
 *
 * 25% is chosen against the observed data: Coffeeberry Hills' Total Leads is out
 * by 1-2 on rows of ~10-20 (well inside), while Three Hills' dispositions run
 * ~3x Total Calls Received (well outside). It separates "typed in a hurry" from
 * "these columns are not measuring the same thing".
 */
export const VARIANCE_DISTRUST_THRESHOLD = 0.25;

const add = (...vals: (number | null)[]): number | null => {
  const present = vals.filter((v): v is number => v != null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
};

const sumField = (days: readonly TrackerDay[], pick: (d: TrackerDay) => number | null): number | null => {
  const present = days.map(pick).filter((v): v is number => v != null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
};

// ─────────────────────────────────────────────────────────────────────────────
// Disposition groups (Phase 9.1)
// ─────────────────────────────────────────────────────────────────────────────

export const DISPOSITION_GROUPS = [
  "qualified_new_demand",
  "lost_to_availability_or_rate",
  "existing_or_returning",
  "not_demand",
] as const;
export type DispositionGroup = (typeof DISPOSITION_GROUPS)[number];

export const DISPOSITION_GROUP_LABEL: Record<DispositionGroup, string> = {
  qualified_new_demand: "Qualified new demand",
  lost_to_availability_or_rate: "Lost to availability or rate",
  existing_or_returning: "Existing or returning guests",
  not_demand: "Not demand",
};

/**
 * What each group is made of, in the property's own columns. Coffeeberry Hills
 * splits Low Budget and Less Room; Three Hills combines them. Both land in the
 * same group without either being split or duplicated.
 */
export const DISPOSITION_GROUP_SOURCES: Record<DispositionGroup, string> = {
  qualified_new_demand: "Enquiries + WhatsApp leads",
  lost_to_availability_or_rate: "Sold out + Low budget + Less room",
  existing_or_returning: "Repeat + In-house",
  not_demand: "Junk / spam",
};

function groupTotals(days: readonly TrackerDay[]): Record<DispositionGroup, number | null> {
  return {
    qualified_new_demand: add(
      sumField(days, (d) => d.enquiries),
      sumField(days, (d) => d.whatsappLeads),
    ),
    // Both tabs carry Sold Out, Low Budget and Less Room as the same three
    // columns, so this is one rule rather than a per-property special case. It
    // used to add a fourth, Three Hills' supposed combined "Low Budget Less
    // Room" — a column that does not exist on the live tab.
    lost_to_availability_or_rate: add(
      sumField(days, (d) => d.soldOut),
      sumField(days, (d) => d.lowBudget),
      sumField(days, (d) => d.lessRoom),
    ),
    existing_or_returning: add(
      sumField(days, (d) => d.repeatContacts),
      sumField(days, (d) => d.inhouse),
    ),
    not_demand: sumField(days, (d) => d.junkSpam),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Variance auditing
// ─────────────────────────────────────────────────────────────────────────────

export type VarianceCheck = {
  id: string;
  /** What the relationship is, in words a person can check against the sheet. */
  description: string;
  /** Rows where both sides were present and could be compared. */
  comparable: number;
  /** Rows where the two sides disagreed at all. */
  disagreeing: number;
  /** Rows where they disagreed by more than VARIANCE_DISTRUST_THRESHOLD. */
  severelyDisagreeing: number;
  /** Worst observed relative gap, as a fraction. */
  worstRelativeGap: number | null;
  /** Dates of the worst offenders, capped for legibility. */
  examples: { date: string; stored: number; computed: number }[];
};

function checkRelation(
  days: readonly TrackerDay[],
  id: string,
  description: string,
  stored: (d: TrackerDay) => number | null,
  computed: (d: TrackerDay) => number | null,
): VarianceCheck {
  let comparable = 0;
  let disagreeing = 0;
  let severelyDisagreeing = 0;
  let worstRelativeGap: number | null = null;
  const examples: { date: string; stored: number; computed: number; gap: number }[] = [];

  for (const d of days) {
    const s = stored(d);
    const c = computed(d);
    if (s == null || c == null) continue;
    comparable += 1;
    if (s === c) continue;
    disagreeing += 1;
    // Relative to the larger side, so a 1-vs-0 disagreement cannot report an
    // infinite gap and dominate the worst-case.
    const denom = Math.max(Math.abs(s), Math.abs(c));
    const gap = denom === 0 ? 0 : Math.abs(s - c) / denom;
    if (gap > VARIANCE_DISTRUST_THRESHOLD) severelyDisagreeing += 1;
    if (worstRelativeGap == null || gap > worstRelativeGap) worstRelativeGap = gap;
    examples.push({ date: d.date, stored: s, computed: c, gap });
  }

  examples.sort((a, b) => b.gap - a.gap);
  return {
    id,
    description,
    comparable,
    disagreeing,
    severelyDisagreeing,
    worstRelativeGap,
    examples: examples.slice(0, 5).map(({ date, stored, computed }) => ({ date, stored, computed })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The period summary
// ─────────────────────────────────────────────────────────────────────────────

export type TrackerSummary = {
  /** Days with a stored row inside the requested period. */
  daysRecorded: number;
  /** Days in the requested period with NO row at all — unrecorded, not zero. */
  daysMissing: number;
  /** The latest date for which a row exists, or null. */
  completeThrough: string | null;

  totalCallsReceived: MetricValue<number>;
  enquiries: MetricValue<number>;
  whatsappLeads: MetricValue<number>;
  whatsappConfirmed: MetricValue<number>;
  roomNightsConfirmed: MetricValue<number>;

  /** Calls + WhatsApp leads. The denominator for every contact-based ratio. */
  recordedContacts: MetricValue<number>;
  /** Enquiries + WhatsApp leads. Phase 9.1's headline. */
  qualifiedNewDemand: MetricValue<number>;

  /**
   * Room nights confirmed per recorded contact. NOT a conversion rate, and never
   * labelled as one: the numerator counts nights and the denominator counts
   * people, so it can legitimately exceed 1.
   */
  roomNightsPerContact: MetricValue<number>;

  dispositionGroups: Record<DispositionGroup, MetricValue<number>>;
  /** Each group's share of recorded contacts. */
  dispositionShare: Record<DispositionGroup, MetricValue<number>>;

  variances: VarianceCheck[];
  /** True when a relationship disagreed badly enough to distrust both sides. */
  hasSevereVariance: boolean;
};

const NOT_RECORDED = "Not recorded in the property's operations tracker for this period.";

function metric(v: number | null, reason = NOT_RECORDED): MetricValue<number> {
  return v == null ? unavailable(reason) : ok(v);
}

/**
 * Summarise tracker days for one property over one period.
 *
 * `expectedDates` is every date in the selected period, so a day with no row can
 * be reported as UNRECORDED rather than silently contributing nothing. That
 * distinction is the whole point: a period whose range runs past the last
 * completed tracker row must say so, not average a gap into the total.
 */
export function summariseTrackerDays(
  days: readonly TrackerDay[],
  expectedDates: readonly string[],
): TrackerSummary {
  const present = new Set(days.map((d) => d.date));
  const daysMissing = expectedDates.filter((d) => !present.has(d)).length;
  const completeThrough = days.length
    ? days.map((d) => d.date).sort().at(-1) ?? null
    : null;

  const calls = sumField(days, (d) => d.totalCallsReceived);
  const enquiries = sumField(days, (d) => d.enquiries);
  const waLeads = sumField(days, (d) => d.whatsappLeads);
  const waConfirmed = sumField(days, (d) => d.whatsappConfirmed);
  const roomNights = sumField(days, (d) => d.roomNightsConfirmed);

  const contacts = add(calls, waLeads);
  const qualified = add(enquiries, waLeads);
  const groups = groupTotals(days);

  const variances: VarianceCheck[] = [
    checkRelation(
      days,
      "total_leads_vs_components",
      "Total Leads should equal Enquiries + WhatsApp Leads",
      (d) => d.storedTotalLeads,
      (d) => add(d.enquiries, d.whatsappLeads),
    ),
    checkRelation(
      days,
      "dispositions_vs_calls",
      "Dispositions (repeat, junk, sold out, in-house, budget, less room) should not exceed Total Calls Received",
      (d) => d.totalCallsReceived,
      (d) =>
        add(
          d.repeatContacts,
          d.junkSpam,
          d.soldOut,
          d.inhouse,
          d.lowBudget,
          d.lessRoom,
        ),
    ),
  ].filter((v) => v.comparable > 0);

  const hasSevereVariance = variances.some((v) => v.severelyDisagreeing > 0);

  const contactsMetric = metric(contacts);
  const roomNightsMetric = metric(roomNights);

  // Room nights per contact needs BOTH sides, and needs the sheet's own internal
  // arithmetic to hold well enough to be worth dividing. When dispositions run
  // three times the recorded calls, the denominator is not a count of anything.
  const severeOnContacts = variances.some(
    (v) => v.id === "dispositions_vs_calls" && v.severelyDisagreeing > 0,
  );
  const roomNightsPerContact: MetricValue<number> = severeOnContacts
    ? unavailable(
        "The tracker's disposition columns and Total Calls Received contradict each other on " +
          "one or more days in this period, so contacts cannot be counted reliably.",
      )
    : !isOk(roomNightsMetric) || !isOk(contactsMetric)
      ? unavailable(NOT_RECORDED)
      : contactsMetric.value === 0
        ? notApplicable("No contacts were recorded in this period, so there is nothing to divide by.")
        : ok(roomNightsMetric.value / contactsMetric.value);

  const dispositionGroups = Object.fromEntries(
    DISPOSITION_GROUPS.map((g) => [g, metric(groups[g])]),
  ) as Record<DispositionGroup, MetricValue<number>>;

  const dispositionShare = Object.fromEntries(
    DISPOSITION_GROUPS.map((g) => {
      const total = groups[g];
      if (total == null) return [g, unavailable(NOT_RECORDED)];
      if (!isOk(contactsMetric)) return [g, unavailable(NOT_RECORDED)];
      if (contactsMetric.value === 0) {
        return [g, notApplicable("No contacts were recorded in this period.")];
      }
      return [g, ok(total / contactsMetric.value)];
    }),
  ) as Record<DispositionGroup, MetricValue<number>>;

  return {
    daysRecorded: days.length,
    daysMissing,
    completeThrough,
    totalCallsReceived: metric(calls),
    enquiries: metric(enquiries),
    whatsappLeads: metric(waLeads),
    whatsappConfirmed: metric(waConfirmed),
    roomNightsConfirmed: roomNightsMetric,
    recordedContacts: contactsMetric,
    qualifiedNewDemand: metric(qualified),
    roomNightsPerContact,
    dispositionGroups,
    dispositionShare,
    variances,
    hasSevereVariance,
  };
}

/** Recorded contacts grouped by day of week (0 = Sunday). Phase 9.4. */
export function contactsByWeekday(days: readonly TrackerDay[]): (number | null)[] {
  const buckets: (number | null)[] = Array.from({ length: 7 }, () => null);
  for (const d of days) {
    const contacts = add(d.totalCallsReceived, d.whatsappLeads);
    if (contacts == null) continue;
    const [y, m, dd] = d.date.split("-").map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
    buckets[weekday] = (buckets[weekday] ?? 0) + contacts;
  }
  return buckets;
}
