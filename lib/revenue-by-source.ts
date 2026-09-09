import { normalizeSource, normalizeMedium, normalizeCampaign } from "./utm-normalize";
import type { SourceType } from "./source-classifier";
import { canonicalSourceType } from "./metrics/canonical";
import type { ClickIds } from "./click-ids";

// Revenue-by-source aggregation — pure, no DB, no "server-only", so the API
// route and the tests share one implementation. Turns conversion rows into the
// per-granularity table, KPI totals, per-group sparkline, and the daily
// source-type breakdown for the stacked chart.

export const GRANULARITIES = ["source", "source_medium", "source_medium_campaign"] as const;
export type Granularity = (typeof GRANULARITIES)[number];
export function isGranularity(v: unknown): v is Granularity {
  return typeof v === "string" && (GRANULARITIES as readonly string[]).includes(v);
}

export type ConversionRow = Required<ClickIds> & {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  /** Revenue for this booking; NULL conversionValue must be passed as 0. */
  value: number;
  occurredAt: Date;
  /**
   * Coupon code on this booking (Phase R2). When present, the booking is
   * INFLUENCER-attributed: it groups under source "influencer" (medium/campaign =
   * the code) with sourceType "influencer", regardless of UTM — so a booking with
   * both a UTM source and a coupon counts ONCE, under influencer (no double-count).
   */
  couponCode?: string | null;
  /** Hotel this booking belongs to (Phase R3 agency rollup). When present, each
   *  group reports how many distinct hotels contributed (hotelCount). */
  hotelClientId?: string | null;
};

/** Source key used for any coupon-attributed (influencer) booking. */
export const INFLUENCER_SOURCE = "influencer";

/** A row's effective source-level key (coupon ⇒ influencer, else normalized UTM
 *  source). Matches the group key at `source` granularity. */
export function rowSourceKey(row: ConversionRow): string {
  return row.couponCode && row.couponCode.trim() ? INFLUENCER_SOURCE : normalizeSource(row.utmSource);
}

export type RevenueGroup = {
  /** Display key: "instagram", "instagram/reel", or "instagram/reel/monsoon". */
  key: string;
  source: string;
  medium: string | null; // null at source granularity
  campaign: string | null; // null unless source_medium_campaign
  /** Dominant source type (by revenue) within the group — drives the badge. */
  sourceType: SourceType;
  bookings: number;
  revenue: number;
  averageBookingValue: number;
  percentOfTotal: number; // 0–100
  /** Distinct hotels that contributed to this group (R3 agency rollup; 0 when
   *  rows carry no hotelClientId, i.e. the R1 per-hotel call). */
  hotelCount: number;
  /** Daily revenue across the range (one entry per day, in date order). */
  sparkline: number[];
};

export type DailyPoint = { date: string; byType: Partial<Record<SourceType, number>> };

export type RevenueBySource = {
  granularity: Granularity;
  groups: RevenueGroup[];
  totals: { revenue: number; bookings: number; averageBookingValue: number; hotelCount: number };
  topSource: { key: string; revenue: number; percentOfTotal: number } | null;
  daily: DailyPoint[];
  /** Distinct group count BEFORE the top-100 cap, plus whether we truncated. */
  distinctGroups: number;
  truncated: boolean;
};

// Cap the table at the top-100 groups by revenue (Part 5.3); the count + a flag
// are returned so the UI can say "showing top 100 of N".
const MAX_GROUPS = 100;

/** Inclusive list of UTC day keys ("YYYY-MM-DD") from start to end (capped). */
export function dayKeys(start: Date, end: Date, maxDays = 92): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (d <= last && out.length < maxDays) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function groupFields(
  granularity: Granularity,
  source: string,
  medium: string,
  campaign: string,
): { key: string; source: string; medium: string | null; campaign: string | null } {
  if (granularity === "source") return { key: source, source, medium: null, campaign: null };
  if (granularity === "source_medium")
    return { key: `${source}/${medium}`, source, medium, campaign: null };
  return { key: `${source}/${medium}/${campaign}`, source, medium, campaign };
}

type Acc = {
  key: string;
  source: string;
  medium: string | null;
  campaign: string | null;
  bookings: number;
  revenue: number;
  sparkline: number[];
  typeRevenue: Map<SourceType, number>;
  hotels: Set<string>;
};

/**
 * Aggregate conversion rows into the revenue-by-source view. `rows` should
 * already be filtered to the hotel + date range (and, when chips are active, to
 * the selected source types); aggregation is over exactly what it's given.
 */
export function aggregateRevenueBySource(
  rows: ConversionRow[],
  granularity: Granularity,
  range: { start: Date; end: Date },
): RevenueBySource {
  const days = dayKeys(range.start, range.end);
  const dayIndex = new Map(days.map((d, i) => [d, i] as const));

  const accs = new Map<string, Acc>();
  const daily: DailyPoint[] = days.map((date) => ({ date, byType: {} }));
  const allHotels = new Set<string>();
  let totalRevenue = 0;
  let totalBookings = 0;

  for (const row of rows) {
    // Coupon (influencer) attribution wins over UTM, so a booking with both is
    // counted once under "influencer". The code becomes the medium/campaign so the
    // finer granularities show WHICH code drove the revenue.
    const coupon = row.couponCode ? row.couponCode.trim().toLowerCase() : "";
    const isInfluencer = coupon.length > 0;
    const source = isInfluencer ? INFLUENCER_SOURCE : normalizeSource(row.utmSource);
    const medium = isInfluencer ? coupon : normalizeMedium(row.utmMedium);
    const campaign = isInfluencer ? coupon : normalizeCampaign(row.utmCampaign);
    // Grouping still keys on the coupon (above) so an influencer's bookings stay
    // under their code. The TYPE is canonical, which differs on one row shape:
    // a coupon used on a PAID click is meta_ads/google_ads, not influencer, so
    // the spend that bought it can be reconciled against it.
    const sourceType = canonicalSourceType(row);
    const value = Number.isFinite(row.value) && row.value > 0 ? row.value : 0;
    const dayKey = row.occurredAt.toISOString().slice(0, 10);
    const di = dayIndex.get(dayKey);
    if (row.hotelClientId) allHotels.add(row.hotelClientId);

    totalRevenue += value;
    totalBookings += 1;

    const f = groupFields(granularity, source, medium, campaign);
    let acc = accs.get(f.key);
    if (!acc) {
      acc = {
        key: f.key,
        source: f.source,
        medium: f.medium,
        campaign: f.campaign,
        bookings: 0,
        revenue: 0,
        sparkline: new Array(days.length).fill(0),
        typeRevenue: new Map(),
        hotels: new Set(),
      };
      accs.set(f.key, acc);
    }
    acc.bookings += 1;
    acc.revenue += value;
    if (row.hotelClientId) acc.hotels.add(row.hotelClientId);
    if (di !== undefined) acc.sparkline[di] += value;
    // Track revenue per source type so the badge shows the dominant one. Count a
    // baseline 1 per booking too, so a group of all-zero-value rows still resolves
    // a type (by booking count) rather than staying at "other".
    acc.typeRevenue.set(sourceType, (acc.typeRevenue.get(sourceType) ?? 0) + value + 1);

    if (di !== undefined) daily[di].byType[sourceType] = (daily[di].byType[sourceType] ?? 0) + value;
  }

  const dominantType = (m: Map<SourceType, number>): SourceType => {
    let best: SourceType = "other";
    let bestV = -1;
    for (const [t, v] of m) {
      if (v > bestV) {
        best = t;
        bestV = v;
      }
    }
    return best;
  };

  let groups: RevenueGroup[] = [...accs.values()].map((a) => ({
    key: a.key,
    source: a.source,
    medium: a.medium,
    campaign: a.campaign,
    sourceType: dominantType(a.typeRevenue),
    bookings: a.bookings,
    revenue: a.revenue,
    averageBookingValue: a.bookings > 0 ? a.revenue / a.bookings : 0,
    percentOfTotal: totalRevenue > 0 ? (a.revenue / totalRevenue) * 100 : 0,
    hotelCount: a.hotels.size,
    sparkline: a.sparkline,
  }));

  // Sort by revenue desc (then bookings, then key) for a stable order.
  groups.sort(
    (x, y) => y.revenue - x.revenue || y.bookings - x.bookings || x.key.localeCompare(y.key),
  );

  const distinctGroups = groups.length;
  const truncated = distinctGroups > MAX_GROUPS;
  if (truncated) groups = groups.slice(0, MAX_GROUPS);

  const top = groups[0] ?? null;

  return {
    granularity,
    groups,
    totals: {
      revenue: totalRevenue,
      bookings: totalBookings,
      averageBookingValue: totalBookings > 0 ? totalRevenue / totalBookings : 0,
      hotelCount: allHotels.size,
    },
    topSource: top ? { key: top.key, revenue: top.revenue, percentOfTotal: top.percentOfTotal } : null,
    daily,
    distinctGroups,
    truncated,
  };
}
