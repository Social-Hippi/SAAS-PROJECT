import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { SOURCE_TYPE_LABEL, type SourceType } from "@/lib/source-classifier";
import { canonicalSourceType, isPaidRow, paidBookingsOf } from "@/lib/metrics/canonical";
import { getSpendByPlatform, safeRoas } from "@/lib/ad-spend";
import type { ClickIds } from "@/lib/click-ids";
import { formatDuration } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// Owner-overview metrics (Tier A) — READ-ONLY calculations over data already in
// the DB (TrackingEvent conversions, Session/PageView journey rows, AdSnapshot /
// AdCampaignSnapshot ad spend). No schema changes, no new integrations.
//
// Money is represented as plain `number` (rupees) — NOT Prisma.Decimal — to match
// the rest of the codebase (lib/savings.ts, lib/attribution.ts all Number() the
// Decimal columns immediately) and to serialise cleanly to JSON for the client.
//
// Multi-tenant: every read goes through agencyScoped(...), which injects the
// caller's agencyId, AND is additionally filtered by hotelClientId — so a hotel
// from another agency simply yields no rows. The route also does an explicit
// ownership check (404) before any of these run.
//
// Notes on two places where the spec referenced fields that don't exist:
//   • AdSnapshot is ACCOUNT-level and has no campaignName; the campaign name +
//     per-campaign spend live on AdCampaignSnapshot, so calculateTopCampaigns
//     joins there (case-insensitive trimmed name match).
//   • PageView has no deviceType column, only viewportWidth — so calculateDeviceSplit
//     classifies by viewportWidth (the exact thresholds the spec gives), and falls
//     back to a Session.userAgent heuristic when the width wasn't captured.
// ─────────────────────────────────────────────────────────────────────────────

const num = (d: { toString(): string } | null | undefined): number =>
  d == null ? 0 : Number(d);

// ── 1. Marketing spend (Meta + Google, via the canonical spend service) ──────
//
// Phase 0: this used to read AdSnapshot directly and return
// `{ total: meta, meta, google: null }` — so "Marketing Spend" on the dashboard
// was Meta-only while being labelled as the total across connected ad accounts.
// Google Ads has been syncing into GoogleAdsCampaignSnapshot the whole time.

export type MarketingSpend = {
  /** meta + google, or NULL when the currencies can't be safely combined. */
  total: number | null;
  meta: number;
  google: number;
  /** True when a combined total would mix currencies (total is then null). */
  mixedCurrency: boolean;
  currency: string;
};

export async function calculateMarketingSpend(
  hotelClientId: string,
  startDate: Date,
  endDate: Date,
): Promise<MarketingSpend> {
  const spend = await getSpendByPlatform(hotelClientId, startDate, endDate);
  return {
    total: spend.total,
    meta: spend.meta,
    google: spend.google,
    mixedCurrency: spend.mixedCurrency,
    currency: spend.currency,
  };
}

// ── 2. Cost per booking ──────────────────────────────────────────────────────

export type CostPerBooking = {
  /** Paid spend ÷ PAID-attributed bookings. Null when either side is unusable. */
  costPerBooking: number | null;
  /** Bookings classified meta_ads / google_ads — the actual denominator. */
  paidBookings: number;
  /** All tracked bookings, kept for context ("12 of 40 bookings were paid"). */
  bookings: number;
  /** Combined paid spend, or null when currencies can't be combined. */
  totalSpend: number | null;
};

/**
 * Phase 0: the denominator is now PAID-attributed bookings. Dividing paid ad
 * spend by every tracked booking (including direct and organic ones) understated
 * the real cost of acquiring a booking through ads, sometimes by an order of
 * magnitude on hotels with strong direct traffic.
 */
export async function calculateCostPerBooking(
  hotelClientId: string,
  startDate: Date,
  endDate: Date,
): Promise<CostPerBooking> {
  const [spend, conversions] = await Promise.all([
    getSpendByPlatform(hotelClientId, startDate, endDate),
    agencyScoped(prisma.trackingEvent).findMany({
      where: { hotelClientId, eventType: "conversion", createdAt: { gte: startDate, lte: endDate } },
      select: { utmSource: true, utmMedium: true, utmContent: true, gclid: true, gbraid: true, wbraid: true, fbclid: true, },
    }),
  ]);

  const bookings = conversions.length;
  const paidBookings = paidBookingsOf(conversions.map((c) => ({ ...c, value: 0 })));
  const totalSpend = spend.total;

  return {
    costPerBooking:
      totalSpend != null && totalSpend > 0 && paidBookings > 0 ? totalSpend / paidBookings : null,
    paidBookings,
    bookings,
    totalSpend,
  };
}

// ── 3. ROAS (paid-only, per platform + combined) ─────────────────────────────
//
// PHASE 0 CORRECTION. `overall` was `totalRevenue / metaSpend` — every rupee of
// booking revenue (direct, organic, influencer, email, WhatsApp, Google-driven)
// divided by Meta-only ad spend, and shown to agencies and hotels as "ROAS". On
// a hotel with strong direct traffic and modest Meta spend that produced a
// spectacular, meaningless number.
//
// Now: paid revenue over paid spend, per platform and combined, with the blended
// figure kept but honestly named.

export type Roas = {
  /** (metaRevenue + googleRevenue) ÷ (metaSpend + googleSpend). THE ROAS. */
  overall: number | null;
  meta: number | null;
  google: number | null;
  /** ALL revenue ÷ paid spend. NOT return on ad spend — label it "Blended". */
  blended: number | null;
  /** Revenue classified meta_ads or google_ads. */
  paidRevenue: number;
  /** Everything else: direct, organic, influencer, email, whatsapp, other. */
  nonPaidRevenue: number;
  /** All tracked booking revenue = paidRevenue + nonPaidRevenue. */
  totalRevenue: number;
  metaRevenue: number;
  googleRevenue: number;
  /** True when overall/blended are null because currencies can't be combined. */
  mixedCurrency: boolean;
};

export async function calculateROAS(
  hotelClientId: string,
  startDate: Date,
  endDate: Date,
): Promise<Roas> {
  const [spend, conversions] = await Promise.all([
    getSpendByPlatform(hotelClientId, startDate, endDate),
    agencyScoped(prisma.trackingEvent).findMany({
      where: { hotelClientId, eventType: "conversion", createdAt: { gte: startDate, lte: endDate } },
      select: { conversionValue: true, utmSource: true, utmMedium: true, utmContent: true, gclid: true, gbraid: true, wbraid: true, fbclid: true, },
    }),
  ]);

  let totalRevenue = 0;
  let metaRevenue = 0;
  let googleRevenue = 0;
  for (const c of conversions) {
    const value = num(c.conversionValue);
    totalRevenue += value;
    const type = canonicalSourceType({ ...c, value });
    if (type === "meta_ads") metaRevenue += value;
    else if (type === "google_ads") googleRevenue += value;
  }
  const paidRevenue = metaRevenue + googleRevenue;

  // safeRoas returns null — never 0× — whenever the denominator is missing or
  // zero, so the UI keeps rendering "—" for "no data" (Part 5 #5).
  return {
    overall: safeRoas(paidRevenue, spend.total),
    meta: safeRoas(metaRevenue, spend.meta),
    google: safeRoas(googleRevenue, spend.google),
    blended: safeRoas(totalRevenue, spend.total),
    paidRevenue,
    nonPaidRevenue: totalRevenue - paidRevenue,
    totalRevenue,
    metaRevenue,
    googleRevenue,
    mixedCurrency: spend.mixedCurrency,
  };
}

// ── 4. Conversion rate (bookings ÷ sessions × 100) ───────────────────────────

export type ConversionRate = { conversionRate: number; bookings: number; sessions: number };

export async function calculateConversionRate(
  hotelClientId: string,
  startDate: Date,
  endDate: Date,
): Promise<ConversionRate> {
  const [sessions, bookings] = await Promise.all([
    agencyScoped(prisma.session).count({
      where: { hotelClientId, startedAt: { gte: startDate, lte: endDate } },
    }),
    agencyScoped(prisma.trackingEvent).count({
      where: { hotelClientId, eventType: "conversion", createdAt: { gte: startDate, lte: endDate } },
    }),
  ]);
  // 0 when there are no sessions (the UI shows "—" for that "no data yet" case;
  // a real 0% — traffic but no bookings — is shown as 0%, see Part 5 #1/#3).
  return {
    conversionRate: sessions > 0 ? (bookings / sessions) * 100 : 0,
    bookings,
    sessions,
  };
}

// ── 5. New vs returning visitors (ad-driven sessions) ────────────────────────

export type NewVsReturning = { newVisitors: number; returningVisitors: number; totalAdVisitors: number };

type AdSessionRow = Required<ClickIds> & {
  utmSource: string | null;
  utmMedium: string | null;
};

const isPaidAdSession = (s: AdSessionRow): boolean =>
  // A session carries no revenue; value is the row shape's required field, not
  // a figure being reported.
  isPaidRow({ ...s, value: 0 });

export async function calculateNewVsReturningFromAds(
  hotelClientId: string,
  startDate: Date,
  endDate: Date,
): Promise<NewVsReturning> {
  const sessions = await agencyScoped(prisma.session).findMany({
    where: { hotelClientId, startedAt: { gte: startDate, lte: endDate } },
    select: {
      visitorId: true, utmSource: true, utmMedium: true,
      // Required by canonicalSourceType — an auto-tagged Google session carries a
      // gclid and no utm, so without these it is not counted as an ad session.
      gclid: true, gbraid: true, wbraid: true, fbclid: true,
    },
  });
  const adSessions = sessions.filter(isPaidAdSession);
  const visitorIds = [...new Set(adSessions.map((s) => s.visitorId))];

  // Which of these visitors were seen in ANY session before this period started?
  const priorVisitorIds =
    visitorIds.length > 0
      ? new Set(
          (
            await agencyScoped(prisma.session).findMany({
              where: { hotelClientId, visitorId: { in: visitorIds }, startedAt: { lt: startDate } },
              select: { visitorId: true },
              distinct: ["visitorId"],
            })
          ).map((r) => r.visitorId),
        )
      : new Set<string>();

  let newVisitors = 0;
  let returningVisitors = 0;
  for (const s of adSessions) {
    if (priorVisitorIds.has(s.visitorId)) returningVisitors += 1;
    else newVisitors += 1;
  }
  return { newVisitors, returningVisitors, totalAdVisitors: adSessions.length };
}

// ── 6. Device split (mobile / desktop / tablet / unknown) ────────────────────

export type DeviceSplit = { mobile: number; desktop: number; tablet: number; unknown: number };

type Device = keyof DeviceSplit;

function deviceFromWidth(width: number | null | undefined): Device | null {
  if (width == null) return null;
  if (width < 768) return "mobile";
  if (width <= 1024) return "tablet";
  return "desktop";
}

function deviceFromUserAgent(ua: string | null | undefined): Device {
  const s = (ua ?? "").toLowerCase();
  if (!s) return "unknown";
  if (/ipad|tablet/.test(s)) return "tablet";
  if (/mobi|android|iphone|ipod/.test(s)) return "mobile";
  return "desktop";
}

export async function calculateDeviceSplit(
  hotelClientId: string,
  startDate: Date,
  endDate: Date,
): Promise<DeviceSplit> {
  const sessions = await agencyScoped(prisma.session).findMany({
    where: { hotelClientId, startedAt: { gte: startDate, lte: endDate } },
    select: { id: true, userAgent: true },
  });
  const result: DeviceSplit = { mobile: 0, desktop: 0, tablet: 0, unknown: 0 };
  if (sessions.length === 0) return result;

  const sessionIds = sessions.map((s) => s.id);
  // First pageview (by enteredAt) per session carries the viewport width we
  // classify on. Fetch ascending and keep the earliest seen per session.
  const pageViews = await agencyScoped(prisma.pageView).findMany({
    where: { sessionId: { in: sessionIds } },
    orderBy: { enteredAt: "asc" },
    select: { sessionId: true, viewportWidth: true },
  });
  const firstWidth = new Map<string, number | null>();
  for (const pv of pageViews) {
    if (!firstWidth.has(pv.sessionId)) firstWidth.set(pv.sessionId, pv.viewportWidth);
  }

  for (const s of sessions) {
    // Prefer the first pageview's viewport; fall back to a UA heuristic when the
    // width wasn't captured (older snippet versions) — Part 5 #4.
    const byWidth = firstWidth.has(s.id) ? deviceFromWidth(firstWidth.get(s.id)) : null;
    const device = byWidth ?? deviceFromUserAgent(s.userAgent);
    result[device] += 1;
  }
  return result;
}

// ── 7. Bounce rate (1 pageview AND < 10s on site) ────────────────────────────

export type BounceRate = { bounceRate: number; bouncedSessions: number; totalSessions: number };

export async function calculateBounceRate(
  hotelClientId: string,
  startDate: Date,
  endDate: Date,
): Promise<BounceRate> {
  const [totalSessions, bouncedSessions] = await Promise.all([
    agencyScoped(prisma.session).count({
      where: { hotelClientId, startedAt: { gte: startDate, lte: endDate } },
    }),
    agencyScoped(prisma.session).count({
      where: {
        hotelClientId,
        startedAt: { gte: startDate, lte: endDate },
        pageViewCount: 1,
        totalTimeMs: { lt: 10_000 },
      },
    }),
  ]);
  return {
    bounceRate: totalSessions > 0 ? (bouncedSessions / totalSessions) * 100 : 0,
    bouncedSessions,
    totalSessions,
  };
}

// ── 8. Average time on site ──────────────────────────────────────────────────

export type AverageTimeOnSite = { averageMs: number; averageFormatted: string; sessions: number };

export async function calculateAverageTimeOnSite(
  hotelClientId: string,
  startDate: Date,
  endDate: Date,
): Promise<AverageTimeOnSite> {
  const agg = await agencyScoped(prisma.session).aggregate({
    where: { hotelClientId, startedAt: { gte: startDate, lte: endDate }, totalTimeMs: { gt: 0 } },
    _avg: { totalTimeMs: true },
    _count: { _all: true },
  });
  const sessions = agg._count._all;
  const averageMs = Math.round(agg._avg.totalTimeMs ?? 0);
  return {
    averageMs,
    averageFormatted: sessions > 0 ? formatDuration(averageMs) : "—",
    sessions,
  };
}

// ── 9. Top campaigns (by booking revenue), joined to Meta spend by name ──────

export type TopCampaign = {
  campaignName: string;
  source: "meta" | "google" | "other";
  spend: number | null;
  revenue: number;
  bookings: number;
  roas: number | null;
  costPerBooking: number | null;
};
export type TopCampaigns = { campaigns: TopCampaign[] };

export async function calculateTopCampaigns(
  hotelClientId: string,
  startDate: Date,
  endDate: Date,
  limit = 5,
): Promise<TopCampaigns> {
  const [conversions, campaignSnaps, googleCampaignSnaps] = await Promise.all([
    agencyScoped(prisma.trackingEvent).findMany({
      where: { hotelClientId, eventType: "conversion", createdAt: { gte: startDate, lte: endDate } },
      select: { utmCampaign: true, utmSource: true, utmMedium: true, utmContent: true, conversionValue: true, gclid: true, gbraid: true, wbraid: true, fbclid: true, },
    }),
    // Per-campaign Meta spend (AdSnapshot has no campaign dimension).
    agencyScoped(prisma.adCampaignSnapshot).findMany({
      where: { hotelClientId, archived: false, date: { gte: startDate, lte: endDate } },
      select: { campaignName: true, spend: true },
    }),
    // Per-campaign GOOGLE spend. Phase 0: without this, a Google campaign's
    // revenue was divided by whatever Meta campaign happened to share its name.
    agencyScoped(prisma.googleAdsCampaignSnapshot).findMany({
      where: { hotelClientId, date: { gte: startDate, lte: endDate } },
      select: { campaignName: true, spend: true },
    }),
  ]);

  // Spend per campaign name, kept PER PLATFORM so a Meta campaign's spend can
  // never be matched to a Google campaign's revenue (or vice versa) just because
  // the two share a name. Keyed case-insensitively, as before.
  const metaSpendByName = new Map<string, number>();
  for (const s of campaignSnaps) {
    const key = s.campaignName.trim().toLowerCase();
    if (!key) continue;
    metaSpendByName.set(key, (metaSpendByName.get(key) ?? 0) + num(s.spend));
  }
  const googleSpendByName = new Map<string, number>();
  for (const s of googleCampaignSnaps) {
    const key = s.campaignName.trim().toLowerCase();
    if (!key) continue;
    googleSpendByName.set(key, (googleSpendByName.get(key) ?? 0) + num(s.spend));
  }

  type Agg = { campaignName: string; revenue: number; bookings: number; source: TopCampaign["source"] };
  const byCampaign = new Map<string, Agg>();
  for (const c of conversions) {
    const name = (c.utmCampaign ?? "").trim();
    if (!name) continue; // no campaign → excluded from this table (the "Direct" bucket)
    const key = name.toLowerCase();
    const type = canonicalSourceType({ ...c, value: num(c.conversionValue) });
    const source: TopCampaign["source"] =
      type === "meta_ads" ? "meta" : type === "google_ads" ? "google" : "other";
    const row = byCampaign.get(key) ?? { campaignName: name, revenue: 0, bookings: 0, source };
    row.revenue += num(c.conversionValue);
    row.bookings += 1;
    byCampaign.set(key, row);
  }

  const campaigns: TopCampaign[] = [...byCampaign.entries()]
    .map(([key, a]): TopCampaign => {
      // Match spend to the campaign's OWN platform only. An "other"-source
      // campaign (organic/influencer UTM) gets no ad spend and therefore no
      // ROAS — its revenue was not bought with ad spend.
      const platformSpend =
        a.source === "meta"
          ? metaSpendByName
          : a.source === "google"
            ? googleSpendByName
            : null;
      const spend = platformSpend?.has(key) ? platformSpend.get(key)! : null;
      return {
        campaignName: a.campaignName,
        source: a.source,
        spend,
        revenue: a.revenue,
        bookings: a.bookings,
        roas: safeRoas(a.revenue, spend),
        costPerBooking: spend != null && spend > 0 && a.bookings > 0 ? spend / a.bookings : null,
      };
    })
    .sort((x, y) => y.revenue - x.revenue)
    .slice(0, limit);

  return { campaigns };
}

// ── 10. Bookings by source (R1 source-classifier as the visualization layer) ──

export type SourceBreakdownRow = { type: SourceType; label: string; revenue: number; bookings: number };
export type BookingsBySource = { sources: SourceBreakdownRow[]; totalRevenue: number; totalBookings: number };

export async function calculateBookingsBySource(
  hotelClientId: string,
  startDate: Date,
  endDate: Date,
): Promise<BookingsBySource> {
  const conversions = await agencyScoped(prisma.trackingEvent).findMany({
    where: { hotelClientId, eventType: "conversion", createdAt: { gte: startDate, lte: endDate } },
    select: {
      conversionValue: true, utmSource: true, utmMedium: true, utmContent: true,
      // Required by canonicalSourceType. Omitting these made an auto-tagged
      // Google booking read as `direct` HERE while calculateROAS (which does
      // select them) counted the same booking as google_ads — the same
      // /owner-metrics payload contradicted itself.
      gclid: true, gbraid: true, wbraid: true, fbclid: true,
    },
  });
  const byType = new Map<SourceType, { revenue: number; bookings: number }>();
  let totalRevenue = 0;
  let totalBookings = 0;
  for (const c of conversions) {
    const value = num(c.conversionValue);
    const type = canonicalSourceType({ ...c, value });
    const row = byType.get(type) ?? { revenue: 0, bookings: 0 };
    row.revenue += value;
    row.bookings += 1;
    byType.set(type, row);
    totalRevenue += value;
    totalBookings += 1;
  }
  const sources: SourceBreakdownRow[] = [...byType.entries()]
    .map(([type, v]) => ({ type, label: SOURCE_TYPE_LABEL[type], revenue: v.revenue, bookings: v.bookings }))
    .sort((a, b) => b.revenue - a.revenue || b.bookings - a.bookings);
  return { sources, totalRevenue, totalBookings };
}

// ── Aggregate: everything the owner-metrics endpoint returns ──────────────────

export type OwnerMetrics = {
  marketingSpend: MarketingSpend;
  costPerBooking: CostPerBooking;
  roas: Roas;
  conversionRate: ConversionRate;
  newVsReturning: NewVsReturning;
  deviceSplit: DeviceSplit;
  bounceRate: BounceRate;
  averageTimeOnSite: AverageTimeOnSite;
  topCampaigns: TopCampaigns;
  bookingsBySource: BookingsBySource;
  meta: {
    metaConnected: boolean;
    /** Phase 0: Google Ads IS integrated — the UI must stop saying otherwise. */
    googleConnected: boolean;
    /** Either paid platform is connected — gates the spend/ROAS/CPB cards. */
    paidConnected: boolean;
  };
};

/** Run every calculation for one hotel + period in parallel. */
export async function loadOwnerMetrics(
  hotelClientId: string,
  startDate: Date,
  endDate: Date,
): Promise<OwnerMetrics> {
  const [
    marketingSpend,
    costPerBooking,
    roas,
    conversionRate,
    newVsReturning,
    deviceSplit,
    bounceRate,
    averageTimeOnSite,
    topCampaigns,
    bookingsBySource,
    adSnapshotCount,
    googleAdsConnectionCount,
  ] = await Promise.all([
    calculateMarketingSpend(hotelClientId, startDate, endDate),
    calculateCostPerBooking(hotelClientId, startDate, endDate),
    calculateROAS(hotelClientId, startDate, endDate),
    calculateConversionRate(hotelClientId, startDate, endDate),
    calculateNewVsReturningFromAds(hotelClientId, startDate, endDate),
    calculateDeviceSplit(hotelClientId, startDate, endDate),
    calculateBounceRate(hotelClientId, startDate, endDate),
    calculateAverageTimeOnSite(hotelClientId, startDate, endDate),
    calculateTopCampaigns(hotelClientId, startDate, endDate),
    calculateBookingsBySource(hotelClientId, startDate, endDate),
    // "Has this hotel ever had any (non-archived) Meta ad data?" — drives the
    // "Connect Meta Ads…" hint vs a real ₹0 (Part 5 #2).
    agencyScoped(prisma.adSnapshot).count({ where: { hotelClientId, archived: false } }),
    // Same question for Google Ads: an ACTIVE connection with a chosen account.
    // Presence of the connection (not of spend) is the right signal — a
    // connected account with zero spend this period is a real ₹0, not "absent".
    agencyScoped(prisma.googleAdsConnection).count({
      where: { hotelClientId, customerId: { not: "" } },
    }),
  ]);

  return {
    marketingSpend,
    costPerBooking,
    roas,
    conversionRate,
    newVsReturning,
    deviceSplit,
    bounceRate,
    averageTimeOnSite,
    topCampaigns,
    bookingsBySource,
    meta: {
      metaConnected: adSnapshotCount > 0,
      googleConnected: googleAdsConnectionCount > 0,
      paidConnected: adSnapshotCount > 0 || googleAdsConnectionCount > 0,
    },
  };
}
