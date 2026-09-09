// Attribution + aggregation helpers for the per-hotel dashboard.
//
// These are pure functions over data the caller has ALREADY scoped to one
// agency + hotel (the dashboard page filters every query by agencyId — see
// CLAUDE.md multi-tenancy rule). Keeping the math here makes it testable and
// keeps the page focused on data loading and layout.
//
// Attribution model (matches lib/utm.ts + the tracking snippet): the snippet
// stores first-touch UTM params in a cookie and sends the SAME utm_content on
// both the "visit" and the later "conversion" event. So a content piece's
// events are exactly those whose utm_content === `ht-<contentPieceId>`.

import { UTM_CONTENT_PREFIX } from "@/lib/utm";
import { paidBookingsOf, paidRevenueOf, type CanonicalRow } from "@/lib/metrics/canonical";
import type { ClickIds } from "@/lib/click-ids";
import {
  DEFAULT_TIMEZONE,
  addZonedDays,
  endOfZonedDay,
  parseZonedDayEnd,
  parseZonedDayStart,
  safeTimeZone,
  startOfZonedDay,
  startOfZonedMonth,
  zonedDayString,
  zonedDaySpan,
} from "@/lib/timezone";

const DAY_MS = 86_400_000;

/**
 * The calendar day of a PLATFORM-DAY column (`@db.Date`), read in UTC.
 *
 * Deliberately NOT timezone-converted. Google and Meta deliver rows already
 * bucketed into their own account day; Prisma hands a `@db.Date` back as
 * UTC-midnight, so slicing the ISO string returns the platform's own date
 * unchanged. Running it through the property timezone would shift every row a
 * day earlier and invent a precision the data does not carry. Property-day
 * boundaries — anything derived from an event TIMESTAMP — use lib/timezone.ts.
 */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Date range
// ─────────────────────────────────────────────────────────────────────────────

export type ResolvedRange = {
  since: Date;
  until: Date;
  /** A RANGE_PRESET id or "custom" — drives the active state of the selector. */
  key: string;
  /** The preset's name ("Last 30 days"), or "Custom range". */
  label: string;
  /** YYYY-MM-DD values to prefill the custom date inputs, in `timezone`. */
  fromInput: string;
  toInput: string;
  /** The property timezone every boundary above was computed in. */
  timezone: string;
  /**
   * The window as literal dates — "1 Aug – 9 Sep 2026".
   *
   * Rendered ALWAYS, including for presets. A report is read weeks after it is
   * sent; "Last 30 days" alone does not say which thirty.
   */
  dateLabel: string;
  /**
   * What the server changed about the requested window, in words a client can
   * read. Empty when the request was honoured exactly. The UI must surface
   * these — a silently clamped range is a wrong report with no signal.
   */
  adjustments: string[];
};

/** The URL parameters this resolves. */
export type RangeParams = { range?: string; from?: string; to?: string };

export type RangeOptions = {
  /** Injectable clock, so calendar presets are testable without freezing time. */
  now?: Date;
  /** Property timezone. Falls back to Asia/Kolkata when absent or unknown. */
  timezone?: string;
  /**
   * Earliest recorded event for this property. `from` is clamped to it, so a
   * range cannot claim to cover months for which nothing was ever measured.
   * Null/absent disables the clamp.
   */
  earliest?: Date | null;
};

/** A year plus a day, so a leap year is never truncated by an off-by-one. */
export const MAX_RANGE_DAYS = 366;

/**
 * The selectable windows, in display order.
 *
 * "7" / "30" / "90" keep their original ids so every existing link, export and
 * bookmark keeps resolving to the same window; the calendar presets are added
 * alongside them rather than renumbering anything.
 */
export const RANGE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7", label: "Last 7 days" },
  { key: "30", label: "Last 30 days" },
  { key: "90", label: "Last 90 days" },
  { key: "this_month", label: "This month" },
  { key: "prev_month", label: "Previous month" },
] as const;

export type RangePresetKey = (typeof RANGE_PRESETS)[number]["key"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "9 Sep 2026", read in the property timezone. */
function longDay(d: Date, tz: string): string {
  const [y, m, day] = zonedDayString(d, tz).split("-").map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
}

/**
 * "1 Aug – 9 Sep 2026", collapsing the repeated year and month where it reads
 * naturally. A single day renders as just that day.
 */
export function formatDateRange(since: Date, until: Date, tz: string): string {
  const a = zonedDayString(since, tz).split("-").map(Number);
  const b = zonedDayString(until, tz).split("-").map(Number);
  const [ay, am, ad] = a;
  const [by, bm, bd] = b;
  if (ay === by && am === bm && ad === bd) return longDay(since, tz);
  if (ay === by && am === bm) return `${ad}–${bd} ${MONTHS[am - 1]} ${ay}`;
  if (ay === by) return `${ad} ${MONTHS[am - 1]} – ${bd} ${MONTHS[bm - 1]} ${ay}`;
  return `${longDay(since, tz)} – ${longDay(until, tz)}`;
}

/**
 * Resolves the dashboard date range from URL search params.
 *
 * EVERY BOUNDARY IS COMPUTED IN THE PROPERTY TIMEZONE. This used to be UTC, so
 * "Today" for an Asia/Kolkata property began at 05:30 local and ended at 05:29
 * the next morning. Every figure a client read under the Today and Yesterday
 * chips was shifted by five and a half hours.
 *
 * PRECEDENCE, exactly as specified: a valid `from`+`to` pair wins, else `range`,
 * else the last 30 days. BOTH custom bounds must parse — one valid and one
 * malformed is not half a request, it is a broken URL, and the honest response
 * is the default window rather than a window the caller did not ask for.
 *
 * THE URL IS PUBLIC, FORWARDABLE AND MISTYPABLE. Nothing here throws. The
 * previous implementation shape-tested with /^\d{4}-\d{2}-\d{2}$/, which
 * accepts "2026-13-45"; that became an Invalid Date and threw RangeError out of
 * toISOString(), i.e. a 500 on a link a client had been sent. Parsing is now
 * strict and every out-of-bounds request is clamped and REPORTED via
 * `adjustments`, never rejected and never silently honoured.
 */
export function resolveRange(sp: RangeParams, options: RangeOptions = {}): ResolvedRange {
  const tz = safeTimeZone(options.timezone);
  const now = options.now ?? new Date();
  const adjustments: string[] = [];

  // The ceiling for every window: no report may extend past the end of today.
  const ceiling = endOfZonedDay(now, tz);
  const floor = options.earliest ? startOfZonedDay(options.earliest, tz) : null;

  const finish = (since: Date, until: Date, key: string, label: string): ResolvedRange => ({
    since,
    until,
    key,
    label,
    fromInput: zonedDayString(since, tz),
    toInput: zonedDayString(until, tz),
    timezone: tz,
    dateLabel: formatDateRange(since, until, tz),
    adjustments,
  });

  // ── Custom range ────────────────────────────────────────────────────────────
  const askedCustom = Boolean(sp.from || sp.to);
  if (askedCustom) {
    const parsedFrom = parseZonedDayStart(sp.from, tz);
    const parsedTo = parseZonedDayEnd(sp.to, tz);

    if (parsedFrom && parsedTo) {
      let since = parsedFrom;
      let until = parsedTo;

      // 1 · Reversed bounds are a typo, not a request for an empty report.
      if (since.getTime() > until.getTime()) {
        [since, until] = [until, since];
        // Re-snap: the swapped values were a day-END and a day-START.
        since = startOfZonedDay(since, tz);
        until = endOfZonedDay(until, tz);
        adjustments.push("The start and end dates were the wrong way round, so they were swapped.");
      }

      // 2 · No future. Nothing has been measured there.
      if (until.getTime() > ceiling.getTime()) {
        until = ceiling;
        adjustments.push(`The end date was in the future, so it was moved to today (${longDay(ceiling, tz)}).`);
      }

      // 3 · No claiming coverage that predates the first thing ever recorded.
      if (floor && since.getTime() < floor.getTime()) {
        since = floor;
        adjustments.push(
          `The start date was before this property's first recorded activity, so it was moved to ${longDay(floor, tz)}.`,
        );
      }

      // 4 · Cap the span. Clamp FORWARD — the start moves later, keeping the
      //     most recent MAX_RANGE_DAYS, which is what someone asking for "up to
      //     today" over too long a window actually wants.
      if (zonedDaySpan(since, until) + 1 > MAX_RANGE_DAYS) {
        since = addZonedDays(until, -(MAX_RANGE_DAYS - 1), tz);
        adjustments.push(
          `The requested window was longer than ${MAX_RANGE_DAYS} days, so it starts at ${longDay(since, tz)}.`,
        );
      }

      // A swap plus a clamp can still leave since > until (e.g. both bounds in
      // the future). Fall back rather than render an inverted, empty window.
      if (since.getTime() <= until.getTime()) {
        return finish(since, until, "custom", "Custom range");
      }
      adjustments.length = 0;
    }
    // Unparseable, or unrecoverable after clamping: fall through to the preset
    // path silently, exactly as specified. No error page.
  }

  // ── Presets ─────────────────────────────────────────────────────────────────
  const capped = (since: Date, until: Date): [Date, Date] => [
    floor && since.getTime() < floor.getTime() ? floor : since,
    until.getTime() > ceiling.getTime() ? ceiling : until,
  ];

  switch (sp.range) {
    case "today": {
      const [a, b] = capped(startOfZonedDay(now, tz), ceiling);
      return finish(a, b, "today", "Today");
    }
    case "yesterday": {
      const y = addZonedDays(startOfZonedDay(now, tz), -1, tz);
      const [a, b] = capped(y, endOfZonedDay(y, tz));
      return finish(a, b, "yesterday", "Yesterday");
    }
    case "this_month": {
      const [a, b] = capped(startOfZonedMonth(now, tz), ceiling);
      return finish(a, b, "this_month", "This month");
    }
    case "prev_month": {
      const firstOfThis = startOfZonedMonth(now, tz);
      const inPrev = new Date(firstOfThis.getTime() - DAY_MS);
      const [a, b] = capped(startOfZonedMonth(inPrev, tz), endOfZonedDay(inPrev, tz));
      return finish(a, b, "prev_month", "Previous month");
    }
    default: {
      // Rolling windows now cover WHOLE property days — "last 30 days" is today
      // plus the 29 before it, not a 30×24h slice ending mid-afternoon. A report
      // that states literal dates has to mean whole ones.
      const days = sp.range === "7" ? 7 : sp.range === "90" ? 90 : 30;
      const [a, b] = capped(addZonedDays(startOfZonedDay(now, tz), -(days - 1), tz), ceiling);
      return finish(a, b, String(days), `Last ${days} days`);
    }
  }
}

/**
 * The equivalent window immediately before `range`, for period-over-period
 * comparison, carrying its own literal-date label.
 *
 * Calendar presets get the previous CALENDAR period, not a same-length slice:
 * the month before a 31-day month is 28-31 days long, and comparing March
 * against "the 31 days before March" would silently include two days of
 * February twice. Rolling windows and custom ranges get a same-length window.
 *
 * The label is literal dates, never "previous period" — a comparison the reader
 * cannot date is a comparison they cannot check.
 */
export function previousRangeOf(range: ResolvedRange): { since: Date; until: Date; label: string } {
  const tz = range.timezone || DEFAULT_TIMEZONE;

  if (range.key === "this_month" || range.key === "prev_month") {
    const firstOfThis = startOfZonedMonth(range.since, tz);
    const inPrev = new Date(firstOfThis.getTime() - DAY_MS);
    const since = startOfZonedMonth(inPrev, tz);
    const until = endOfZonedDay(inPrev, tz);
    return { since, until, label: formatDateRange(since, until, tz) };
  }

  const span = range.until.getTime() - range.since.getTime();
  const until = new Date(range.since.getTime() - 1);
  const since = new Date(range.since.getTime() - span - 1);
  return { since, until, label: formatDateRange(since, until, tz) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

export type EventInput = Required<ClickIds> & {
  eventType: "visit" | "conversion";
  // utmSource + utmMedium are REQUIRED (Phase 0): computeKpis has to classify a
  // conversion as paid or non-paid, and it can't do that from utm_content alone.
  // Deliberately not optional — a call site that forgets to SELECT them would
  // otherwise silently classify every booking as `direct` and report a paid ROAS
  // of 0×. A compile error is the cheaper failure.
  //
  // The click ids are Required for exactly the same reason: an omitted gclid
  // reads as `undefined`, isGoogleAdsClick returns false, and every auto-tagged
  // Google booking silently becomes `direct`. See ClassifiableUtm.
  utmSource: string | null;
  utmMedium: string | null;
  utmContent: string | null;
  utmCampaign: string | null;
  sessionId: string;
  conversionValue: number | null;
};

export type ContentInput = {
  id: string;
  title: string;
  contentType: string;
  platform: string;
  couponCode: string | null;
  influencerName: string | null;
};

export type AdSnapshotInput = {
  date: Date;
  spend: number;
  conversions: number;
  roas: number;
};

export type RedemptionInput = {
  contentPieceId: string;
  orderValue: number;
};

/** Extracts the content-piece id from a utm_content tag, if it's one of ours. */
export function contentIdFromUtmContent(
  utmContent: string | null | undefined,
  valid: Set<string>,
): string | null {
  if (!utmContent || !utmContent.startsWith(UTM_CONTENT_PREFIX)) return null;
  const id = utmContent.slice(UTM_CONTENT_PREFIX.length);
  return valid.has(id) ? id : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — KPIs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Paid ad spend split by platform. Structurally identical to
 * `SpendByPlatform` from lib/ad-spend.ts (which is server-only, so it cannot be
 * imported into this pure module) — a `SpendByPlatform` satisfies this type.
 *
 * `total` is NULL when the platforms report in currencies that cannot be safely
 * added; every figure derived from it is then null too, never a wrong number.
 */
export type PaidSpendInput = {
  meta: number;
  google: number;
  total: number | null;
};

export type Kpis = {
  visits: number;
  bookings: number;
  /** ALL tracked conversion revenue, every channel. Not a ROAS numerator. */
  revenue: number;
  /** Revenue from conversions classified meta_ads or google_ads only. */
  paidRevenue: number;
  /** Bookings classified meta_ads or google_ads only. */
  paidBookings: number;
  /**
   * Combined PAID ad spend (Meta + Google). Null when the currencies can't be
   * safely combined — callers must render "—", never 0.
   */
  spend: number | null;
  /** Paid spend split by platform, for per-platform display. */
  spendByPlatform: PaidSpendInput;
  /**
   * Paid spend ÷ PAID bookings. Null when there's no paid spend or no paid
   * booking. (Phase 0: the denominator is paid bookings, not all bookings —
   * dividing paid spend by organic bookings understated the true cost.)
   */
  costPerBooking: number | null;
  /**
   * THE ROAS. paidRevenue ÷ paid spend — both sides paid-only.
   * Null when there's no paid spend to divide by.
   */
  roas: number | null;
  /**
   * ALL revenue ÷ paid spend. This is what `roas` used to be. It is a real and
   * sometimes useful figure ("every rupee of ad spend coincided with ₹X of total
   * revenue"), but it is NOT return on ad spend and must never be labelled ROAS
   * without the word "Blended".
   */
  blendedRoas: number | null;
};

/**
 * Period KPIs.
 *
 * PHASE 0 CORRECTION: `roas` used to be `allRevenue / metaSpend` — direct,
 * organic, influencer, email and WhatsApp revenue divided by Meta-only ad spend,
 * displayed as "True ROAS". It is now paid revenue ÷ paid spend, with the old
 * figure preserved (and honestly named) as `blendedRoas`.
 */
export function computeKpis(events: EventInput[], spend: PaidSpendInput): Kpis {
  let visits = 0;
  let bookings = 0;
  let revenue = 0;

  const conversions: CanonicalRow[] = [];
  for (const e of events) {
    if (e.eventType === "visit") {
      visits += 1;
      continue;
    }
    const value = e.conversionValue ?? 0;
    bookings += 1;
    revenue += value;
    conversions.push({ ...e, value });
  }

  const paidRevenue = paidRevenueOf(conversions);
  const paidBookings = paidBookingsOf(conversions);

  const paidSpend = spend.total;
  const divisible = paidSpend != null && paidSpend > 0;

  return {
    visits,
    bookings,
    revenue,
    paidRevenue,
    paidBookings,
    spend: paidSpend,
    spendByPlatform: { meta: spend.meta, google: spend.google, total: spend.total },
    costPerBooking: divisible && paidBookings > 0 ? paidSpend / paidBookings : null,
    roas: divisible ? paidRevenue / paidSpend : null,
    blendedRoas: divisible ? revenue / paidSpend : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — Content performance
// ─────────────────────────────────────────────────────────────────────────────

export type ContentPerf = {
  id: string;
  title: string;
  contentType: string;
  platform: string;
  /** Visit events from this piece's link (every tracked arrival). */
  clicks: number;
  /** Distinct sessions among those visits (unique visitors). */
  sessions: number;
  bookings: number;
  revenue: number;
  /** bookings / sessions. */
  conversionRate: number;
};

export function computeContentPerformance(
  content: ContentInput[],
  events: EventInput[],
): ContentPerf[] {
  const valid = new Set(content.map((c) => c.id));
  const clicks = new Map<string, number>();
  const sessions = new Map<string, Set<string>>();
  const bookings = new Map<string, number>();
  const revenue = new Map<string, number>();
  for (const c of content) {
    clicks.set(c.id, 0);
    sessions.set(c.id, new Set());
    bookings.set(c.id, 0);
    revenue.set(c.id, 0);
  }

  for (const e of events) {
    const cid = contentIdFromUtmContent(e.utmContent, valid);
    if (!cid) continue;
    if (e.eventType === "visit") {
      clicks.set(cid, (clicks.get(cid) ?? 0) + 1);
      sessions.get(cid)!.add(e.sessionId);
    } else {
      bookings.set(cid, (bookings.get(cid) ?? 0) + 1);
      revenue.set(cid, (revenue.get(cid) ?? 0) + (e.conversionValue ?? 0));
    }
  }

  return content.map((c) => {
    const sessionCount = sessions.get(c.id)!.size;
    const bookingCount = bookings.get(c.id) ?? 0;
    return {
      id: c.id,
      title: c.title,
      contentType: c.contentType,
      platform: c.platform,
      clicks: clicks.get(c.id) ?? 0,
      sessions: sessionCount,
      bookings: bookingCount,
      revenue: revenue.get(c.id) ?? 0,
      conversionRate: sessionCount > 0 ? bookingCount / sessionCount : 0,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — Paid ads
// ─────────────────────────────────────────────────────────────────────────────

export type AdsSummary = {
  spend: number;
  /** Meta-reported conversions from ad snapshots. */
  bookingsFromAds: number;
  /** Meta-reported ad revenue (Σ spend × roas). */
  metaReportedRevenue: number;
  metaRoas: number | null;
  /** Daily spend for the line chart, ascending by date. */
  spendOverTime: { date: string; spend: number }[];
};

export function computeAdsSummary(snapshots: AdSnapshotInput[]): AdsSummary {
  let spend = 0;
  let bookingsFromAds = 0;
  let metaReportedRevenue = 0;

  const byDate = new Map<string, number>();
  for (const s of snapshots) {
    spend += s.spend;
    bookingsFromAds += s.conversions;
    metaReportedRevenue += s.spend * s.roas;
    const key = ymd(s.date);
    byDate.set(key, (byDate.get(key) ?? 0) + s.spend);
  }

  const spendOverTime = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, spend: value }));

  return {
    spend,
    bookingsFromAds,
    metaReportedRevenue,
    metaRoas: spend > 0 ? metaReportedRevenue / spend : null,
    spendOverTime,
  };
}

/**
 * "True ROI" — our measured website-booking revenue from paid-ad content vs the
 * ad spend, as opposed to Meta's self-reported ROAS. This is HotelTrack's core
 * claim: real bookings, not platform-attributed ones.
 *   (real ad-driven revenue − spend) / spend
 */
export function trueRoi(realAdRevenue: number, spend: number): number | null {
  if (spend <= 0) return null;
  return (realAdRevenue - spend) / spend;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — Influencer impact
// ─────────────────────────────────────────────────────────────────────────────

export type InfluencerRow = {
  id: string;
  title: string;
  influencerName: string;
  couponCode: string | null;
  redemptions: number;
  revenue: number;
  /** Influencer fees aren't tracked in the schema yet, so this is null. */
  costPerBooking: number | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — Multi-touch attribution models
//
// HotelTrack's flagship lens: split credit for a booking across the FULL visitor
// journey (the ordered touchpoints captured by the snippet), under one of three
// models. Pure functions — the dashboard page assembles the touchpoint lists
// (real Touchpoint rows, or synthesized from TrackingEvent history for legacy
// conversions) and the per-source visitor/spend maps, then calls in here.
// ─────────────────────────────────────────────────────────────────────────────

export type AttributionModel = "first" | "last" | "position";

/** One touch in a journey. `source` is the raw utm_source (null = direct). */
export type TouchpointInput = { position: number; source: string | null };

/** source -> fractional credit for a single conversion; values sum to ~1. */
export type CreditMap = Record<string, number>;

export type ChannelRow = {
  source: string;
  /** Distinct visitors whose journey touched this source (model-independent). */
  visitorsBrought: number;
  /** Credited bookings ÷ visitors brought (shifts with the model). */
  conversionRate: number;
  /** Credited bookings — fractional under the position-based model. */
  bookings: number;
  /** Booking value credited to this source under the model. */
  revenue: number;
  /** Credited revenue ÷ this source's ad spend; null when spend is unknown. */
  trueRoas: number | null;
};

export const ATTRIBUTION_MODELS: {
  id: AttributionModel;
  name: string;
  lens: string;
  question: string;
}[] = [
  { id: "first", name: "Awareness View", lens: "First-Touch", question: "Which channels create demand?" },
  { id: "last", name: "Sales View", lens: "Last-Touch", question: "Which channels close bookings?" },
  { id: "position", name: "Strategic View", lens: "Position-Based", question: "Balanced view across the journey" },
];

const DIRECT = "Direct";

/** Normalize a utm_source: empty / "(none)" / "direct" all collapse to "Direct". */
export function normSource(source: string | null | undefined): string {
  const s = (source ?? "").trim();
  if (!s || s.toLowerCase() === "(none)" || s.toLowerCase() === "direct") return DIRECT;
  return s;
}

function ordered(touchpoints: TouchpointInput[]): string[] {
  return [...touchpoints]
    .sort((a, b) => a.position - b.position)
    .map((t) => normSource(t.source));
}

/** 100% credit to the first touch. */
export function firstTouchCredit(touchpoints: TouchpointInput[]): CreditMap {
  const srcs = ordered(touchpoints);
  return srcs.length ? { [srcs[0]]: 1 } : {};
}

/** 100% credit to the last touch. */
export function lastTouchCredit(touchpoints: TouchpointInput[]): CreditMap {
  const srcs = ordered(touchpoints);
  return srcs.length ? { [srcs[srcs.length - 1]]: 1 } : {};
}

/**
 * Position-based U-shaped:
 *   1 touch  → 100% first
 *   2 touches → 50% first, 50% last
 *   3+ touches → 40% first, 40% last, 20% split evenly across the middle
 * Credit for a repeated source accumulates.
 */
export function uShapedCredit(touchpoints: TouchpointInput[]): CreditMap {
  const srcs = ordered(touchpoints);
  const n = srcs.length;
  const out: CreditMap = {};
  const add = (s: string, w: number) => {
    out[s] = (out[s] ?? 0) + w;
  };
  if (n === 0) return out;
  if (n === 1) {
    add(srcs[0], 1);
    return out;
  }
  if (n === 2) {
    add(srcs[0], 0.5);
    add(srcs[1], 0.5);
    return out;
  }
  add(srcs[0], 0.4);
  add(srcs[n - 1], 0.4);
  const middle = 0.2 / (n - 2);
  for (let i = 1; i < n - 1; i++) add(srcs[i], middle);
  return out;
}

/** Dispatch to the credit function for a given model. */
export function creditForModel(
  model: AttributionModel,
  touchpoints: TouchpointInput[],
): CreditMap {
  if (model === "last") return lastTouchCredit(touchpoints);
  if (model === "position") return uShapedCredit(touchpoints);
  return firstTouchCredit(touchpoints);
}

export type ConversionForAttribution = {
  touchpoints: TouchpointInput[];
  value: number;
};

/**
 * Aggregate per-source channel performance under a model. `visitorsBySource`
 * and `spendBySource` are model-independent inputs the caller builds from the
 * (agency-scoped) visit + spend data; sources use the same normalized labels as
 * normSource(). Bookings/revenue are credit-weighted, so they shift per model.
 */
export function computeChannelPerformance(
  model: AttributionModel,
  conversions: ConversionForAttribution[],
  visitorsBySource: Record<string, number>,
  spendBySource: Record<string, number>,
): ChannelRow[] {
  const bookings: CreditMap = {};
  const revenue: CreditMap = {};
  const sources = new Set<string>();

  for (const s of Object.keys(visitorsBySource)) sources.add(s);
  for (const s of Object.keys(spendBySource)) sources.add(s);

  for (const c of conversions) {
    const credit = creditForModel(model, c.touchpoints);
    for (const [src, w] of Object.entries(credit)) {
      bookings[src] = (bookings[src] ?? 0) + w;
      revenue[src] = (revenue[src] ?? 0) + w * c.value;
      sources.add(src);
    }
  }

  return [...sources]
    .map((source): ChannelRow => {
      const visitors = visitorsBySource[source] ?? 0;
      const bk = bookings[source] ?? 0;
      const rev = revenue[source] ?? 0;
      const spend = spendBySource[source] ?? 0;
      return {
        source,
        visitorsBrought: visitors,
        conversionRate: visitors > 0 ? bk / visitors : 0,
        bookings: bk,
        revenue: rev,
        trueRoas: spend > 0 ? rev / spend : null,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);
}

/** Credit map as integer percentages (for the drill-down "credit by model"). */
export function creditPercents(credit: CreditMap): { source: string; pct: number }[] {
  return Object.entries(credit)
    .map(([source, w]) => ({ source, pct: Math.round(w * 100) }))
    .sort((a, b) => b.pct - a.pct);
}

export function computeInfluencerImpact(
  content: ContentInput[],
  redemptions: RedemptionInput[],
): InfluencerRow[] {
  const counts = new Map<string, number>();
  const revenue = new Map<string, number>();
  for (const r of redemptions) {
    counts.set(r.contentPieceId, (counts.get(r.contentPieceId) ?? 0) + 1);
    revenue.set(
      r.contentPieceId,
      (revenue.get(r.contentPieceId) ?? 0) + r.orderValue,
    );
  }

  return content
    .filter((c) => c.contentType === "influencer")
    .map((c) => ({
      id: c.id,
      title: c.title,
      influencerName: c.influencerName ?? "Influencer",
      couponCode: c.couponCode,
      redemptions: counts.get(c.id) ?? 0,
      revenue: revenue.get(c.id) ?? 0,
      costPerBooking: null,
    }));
}
