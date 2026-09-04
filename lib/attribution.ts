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
import { classifySourceType, isPaidSourceType } from "@/lib/source-classifier";
import type { ClickIds } from "@/lib/click-ids";

const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────────
// Date range
// ─────────────────────────────────────────────────────────────────────────────

export type ResolvedRange = {
  since: Date;
  until: Date;
  /** "7" | "30" | "90" | "custom" — drives the active state of the selector. */
  key: string;
  label: string;
  /** YYYY-MM-DD values to prefill the custom date inputs. */
  fromInput: string;
  toInput: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Resolves the dashboard date range from URL search params. Supports the preset
 * windows (`range=7|30|90`) and a custom range (`from`/`to` as YYYY-MM-DD).
 * Defaults to the last 30 days.
 */
export function resolveRange(sp: {
  range?: string;
  from?: string;
  to?: string;
}): ResolvedRange {
  const now = new Date();
  const from = sp.from && DATE_RE.test(sp.from) ? sp.from : null;
  const to = sp.to && DATE_RE.test(sp.to) ? sp.to : null;

  if (from || to) {
    const since = from
      ? new Date(`${from}T00:00:00.000Z`)
      : new Date(now.getTime() - 30 * DAY_MS);
    const until = to ? new Date(`${to}T23:59:59.999Z`) : now;
    return {
      since,
      until,
      key: "custom",
      label: "Custom range",
      fromInput: ymd(since),
      toInput: ymd(until),
    };
  }

  const days = sp.range === "7" ? 7 : sp.range === "90" ? 90 : 30;
  const since = new Date(now.getTime() - days * DAY_MS);
  return {
    since,
    until: now,
    key: String(days),
    label: `Last ${days} days`,
    fromInput: ymd(since),
    toInput: ymd(now),
  };
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
  let paidRevenue = 0;
  let paidBookings = 0;

  for (const e of events) {
    if (e.eventType === "visit") {
      visits += 1;
      continue;
    }
    const value = e.conversionValue ?? 0;
    bookings += 1;
    revenue += value;
    if (isPaidSourceType(classifySourceType(e))) {
      paidBookings += 1;
      paidRevenue += value;
    }
  }

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
