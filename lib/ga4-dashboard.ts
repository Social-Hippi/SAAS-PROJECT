import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant-scope";

// Aggregates a hotel's Ga4Snapshot rows (the selected window) into the shape the
// dashboard's "Website Traffic" section renders. Always scoped by agencyId +
// hotelClientId. `trackedSessions` (HotelTrack snippet sessions, or null in
// pixel mode) is passed in by the page for the cross-validation card.
//
// Everything here READS already-synced columns (the daily GA4 cron fetches and
// stores them) — no GA4 API calls happen on page load. The expanded sections
// (acquisition / landing×source / pages / engagement / new-vs-returning / events
// / ecommerce / daily trend) are merged across the window from the per-day rows.

type NamedSessions = { name: string; sessions: number };
type PathSessions = { path: string; sessions: number };

type SourceRow = { source: string; medium: string; sessions: number; users: number; keyEvents: number };
type CampaignRow = { campaign: string; sessions: number; users: number; keyEvents: number };
type LandingRow = { landing: string; source: string; medium: string; sessions: number; keyEvents: number; engagedSessions: number; users: number };
type PageRow = { path: string; title: string; views: number; entrances: number; engagementSeconds: number };
type SegmentRow = { segment: string; users: number; newUsers: number; sessions: number; keyEvents: number };
type EventRow = { event: string; count: number; keyEvents: number; users: number };
type TrendPoint = { date: string; sessions: number; keyEvents: number };

export type Ga4Dashboard = {
  connected: boolean;
  propertyName: string | null;
  lastSyncedAt: string | null;
  days: number; // snapshot days available
  sessions: number;
  users: number;
  pageViews: number;
  avgSessionDuration: number; // seconds (weighted)
  bounceRate: number; // 0..1 (weighted)
  keyEvents: number; // total GA4 key events (conversions) over the window
  channels: { organic: number; paid: number; social: number; direct: number; referral: number };
  ads: { clicks: number; impressions: number; cost: number; conversions: number } | null;
  topCountries: NamedSessions[];
  topCities: NamedSessions[];
  topLandingPages: PathSessions[];
  device: { mobile: number; desktop: number; tablet: number };
  // ── Expanded sections (Reports 1–7) ──
  engagement: {
    engagedSessions: number;
    engagementRate: number; // 0..1 (recomputed from totals)
    screenPageViewsPerSession: number; // recomputed from totals
    avgEngagementSeconds: number; // userEngagementDuration / sessions
  };
  sources: SourceRow[]; // Report 1 — source × medium
  campaigns: CampaignRow[]; // Report 1 — campaign
  landingBySource: LandingRow[]; // Report 2
  topPages: PageRow[]; // Report 3
  newVsReturning: SegmentRow[]; // Report 5
  events: EventRow[]; // Report 6
  ecommerce: { purchaseRevenue: number; transactions: number } | null; // Report 6 (paise); null when absent
  trend: TrendPoint[]; // Report 7 — per-day sessions + keyEvents
  /** HotelTrack snippet sessions over the same window; null in pixel mode. */
  trackedSessions: number | null;
};

const SEP = String.fromCharCode(31);
const n = (v: unknown): number => Number(v ?? 0) || 0;

// Merge single-metric {name|path, sessions} top-N lists across days (existing behaviour).
function mergeTop<T extends Record<string, unknown>>(lists: unknown[], key: keyof T, limit: number): T[] {
  const acc = new Map<string, number>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list as Record<string, unknown>[]) {
      const k = String(item[key as string] ?? "");
      const s = n(item.sessions);
      if (k) acc.set(k, (acc.get(k) ?? 0) + s);
    }
  }
  return [...acc.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, s]) => ({ [key]: k, sessions: s }) as unknown as T);
}

// Merge multi-metric rows across days: group by keyFields, sum numFields, sort by
// `sortBy` desc, keep top `limit`. Non-numeric fields come from the first-seen row.
function mergeRows<T extends Record<string, unknown>>(
  lists: unknown[],
  keyFields: (keyof T)[],
  numFields: (keyof T)[],
  sortBy: keyof T,
  limit: number,
): T[] {
  const acc = new Map<string, T>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list as T[]) {
      const k = keyFields.map((f) => String(raw[f] ?? "")).join(SEP);
      const cur = acc.get(k);
      if (!cur) {
        const copy = { ...raw } as T;
        for (const f of numFields) (copy[f] as number) = n(raw[f]);
        acc.set(k, copy);
      } else {
        for (const f of numFields) (cur[f] as number) = n(cur[f]) + n(raw[f]);
      }
    }
  }
  return [...acc.values()].sort((a, b) => n(b[sortBy]) - n(a[sortBy])).slice(0, limit);
}

export async function loadGa4Dashboard(args: {
  agencyId: string;
  hotelId: string;
  since: Date;
  until: Date;
  trackedSessions: number | null;
}): Promise<Ga4Dashboard> {
  const { agencyId, hotelId, since, until, trackedSessions } = args;
  const scoped = <D>(m: D) => agencyScopedFor(agencyId, m);

  const conn = await scoped(prisma.ga4Connection).findFirst({
    where: { hotelClientId: hotelId },
    select: { status: true, propertyName: true, propertyId: true, lastSyncedAt: true },
  });
  const connected = !!conn && conn.propertyId !== "" && conn.status !== "REVOKED";

  const base: Ga4Dashboard = {
    connected,
    propertyName: conn?.propertyName ?? null,
    lastSyncedAt: conn?.lastSyncedAt?.toISOString() ?? null,
    days: 0,
    sessions: 0, users: 0, pageViews: 0, avgSessionDuration: 0, bounceRate: 0, keyEvents: 0,
    channels: { organic: 0, paid: 0, social: 0, direct: 0, referral: 0 },
    ads: null,
    topCountries: [], topCities: [], topLandingPages: [],
    device: { mobile: 0, desktop: 0, tablet: 0 },
    engagement: { engagedSessions: 0, engagementRate: 0, screenPageViewsPerSession: 0, avgEngagementSeconds: 0 },
    sources: [], campaigns: [], landingBySource: [], topPages: [], newVsReturning: [], events: [],
    ecommerce: null,
    trend: [],
    trackedSessions,
  };
  if (!connected) return base;

  const snaps = await scoped(prisma.ga4Snapshot).findMany({
    where: { hotelClientId: hotelId, date: { gte: since, lte: until } },
    orderBy: { date: "asc" },
  });
  if (snaps.length === 0) return base;

  let durWeighted = 0;
  let bounceWeighted = 0;
  let adsClicks = 0, adsImpr = 0, adsCost = 0, adsConv = 0, hasAds = false;
  let engagedSessions = 0, userEngagementDuration = 0;
  let ecomRevenue = 0, ecomTxns = 0, hasEcom = false;
  const countryLists: NamedSessions[][] = [];
  const cityLists: NamedSessions[][] = [];
  const landingLists: PathSessions[][] = [];
  const sourceLists: unknown[] = [];
  const campaignLists: unknown[] = [];
  const landingBySourceLists: unknown[] = [];
  const pageLists: unknown[] = [];
  const segmentLists: unknown[] = [];
  const eventLists: unknown[] = [];

  for (const s of snaps) {
    base.sessions += s.sessions;
    base.users += s.users;
    base.pageViews += s.pageViews;
    base.keyEvents += s.keyEvents;
    durWeighted += s.avgSessionDuration * s.sessions;
    bounceWeighted += s.bounceRate * s.sessions;
    engagedSessions += s.engagedSessions;
    userEngagementDuration += s.userEngagementDuration;
    base.channels.organic += s.organicSessions;
    base.channels.paid += s.paidSessions;
    base.channels.social += s.socialSessions;
    base.channels.direct += s.directSessions;
    base.channels.referral += s.referralSessions;
    base.device.mobile += s.mobileSessions;
    base.device.desktop += s.desktopSessions;
    base.device.tablet += s.tabletSessions;
    if (s.googleAdsClicks != null || s.googleAdsImpressions != null || s.googleAdsCost != null) {
      hasAds = true;
      adsClicks += s.googleAdsClicks ?? 0;
      adsImpr += s.googleAdsImpressions ?? 0;
      adsCost += s.googleAdsCost ?? 0;
      adsConv += s.googleAdsConversions ?? 0;
    }
    if (s.purchaseRevenue != null || s.transactions != null) {
      hasEcom = true;
      ecomRevenue += s.purchaseRevenue ?? 0;
      ecomTxns += s.transactions ?? 0;
    }
    countryLists.push((s.topCountries as NamedSessions[]) ?? []);
    cityLists.push((s.topCities as NamedSessions[]) ?? []);
    landingLists.push((s.topLandingPages as PathSessions[]) ?? []);
    sourceLists.push(s.topSources);
    campaignLists.push(s.topCampaigns);
    landingBySourceLists.push(s.landingBySource);
    pageLists.push(s.topPages);
    segmentLists.push(s.newVsReturning);
    eventLists.push(s.topEvents);
    base.trend.push({ date: s.date.toISOString().slice(0, 10), sessions: s.sessions, keyEvents: s.keyEvents });
  }

  base.days = snaps.length;
  base.avgSessionDuration = base.sessions > 0 ? Math.round(durWeighted / base.sessions) : 0;
  base.bounceRate = base.sessions > 0 ? bounceWeighted / base.sessions : 0;
  base.ads = hasAds ? { clicks: adsClicks, impressions: adsImpr, cost: adsCost, conversions: adsConv } : null;
  base.topCountries = mergeTop(countryLists, "name", 5);
  base.topCities = mergeTop(cityLists, "name", 5);
  base.topLandingPages = mergeTop(landingLists, "path", 5);

  base.engagement = {
    engagedSessions,
    engagementRate: base.sessions > 0 ? engagedSessions / base.sessions : 0,
    screenPageViewsPerSession: base.sessions > 0 ? base.pageViews / base.sessions : 0,
    avgEngagementSeconds: base.sessions > 0 ? Math.round(userEngagementDuration / base.sessions) : 0,
  };
  base.sources = mergeRows<SourceRow>(sourceLists, ["source", "medium"], ["sessions", "users", "keyEvents"], "sessions", 10);
  base.campaigns = mergeRows<CampaignRow>(campaignLists, ["campaign"], ["sessions", "users", "keyEvents"], "sessions", 10)
    .filter((c) => c.campaign && c.campaign !== "(not set)");
  base.landingBySource = mergeRows<LandingRow>(landingBySourceLists, ["landing", "source", "medium"], ["sessions", "keyEvents", "engagedSessions", "users"], "sessions", 10);
  base.topPages = mergeRows<PageRow>(pageLists, ["path", "title"], ["views", "entrances", "engagementSeconds"], "views", 10);
  base.newVsReturning = mergeRows<SegmentRow>(segmentLists, ["segment"], ["users", "newUsers", "sessions", "keyEvents"], "users", 4);
  base.events = mergeRows<EventRow>(eventLists, ["event"], ["count", "keyEvents", "users"], "count", 10);
  base.ecommerce = hasEcom ? { purchaseRevenue: ecomRevenue, transactions: ecomTxns } : null;
  return base;
}
