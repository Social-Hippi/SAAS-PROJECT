import "server-only";

import { prisma } from "@/lib/prisma";
import { getTokenForApiCall } from "@/lib/token-access";
import { encryptWithAudit } from "@/lib/token-audit";
import {
  runReport,
  refreshAccessToken,
  GaAuthExpiredError,
  GaOAuthError,
  mask,
  type ReportRequest,
  type ReportRow,
} from "@/lib/ga4";

// GA4 daily sync (OAuth). For each ACTIVE connection: refresh the access token if
// it's near expiry, pull the trailing 30 days across a set of THEME-grouped
// reports (see syncGa4Connection), and upsert one Ga4Snapshot per day. Resilient:
// one hotel's failure (or an expired token) never aborts the batch, and a single
// non-auth report failing (incompatible combo, quota, empty ecommerce) is skipped
// without losing the rest of the day's data.
//
// Logs under [GA4-SYNC] / [GA4-TOKEN]; tokens are never logged in full.

const LOG = "[GA4-SYNC]";
const TLOG = "[GA4-TOKEN]";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Pulls Google's machine error code (invalid_grant, invalid_client, …) out of a
// GaOAuthError message for structured logging + the reconnect banner. Falls back
// to a trimmed message when no known code is present.
function googleErrorCode(message: string): string {
  const m = message.match(
    /\b(invalid_grant|invalid_client|invalid_request|unauthorized_client|invalid_scope|access_denied)\b/,
  );
  return m ? m[1] : message.slice(0, 200);
}

// "20260608" → Date(UTC midnight). GA's `date` dimension is YYYYMMDD.
function gaDateToUtc(yyyymmdd: string): Date {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  return new Date(Date.UTC(y, m - 1, d));
}

type Conn = {
  id: string;
  agencyId: string;
  hotelClientId: string;
  propertyId: string;
  tokenExpiresAt: Date;
};

/**
 * Returns a usable access token, refreshing (and re-storing, encrypted) when the
 * current one is within 5 minutes of expiry. On refresh failure marks the
 * connection TOKEN_EXPIRED and rethrows.
 */
async function getValidAccessToken(conn: Conn): Promise<string> {
  if (conn.tokenExpiresAt.getTime() > Date.now() + REFRESH_SKEW_MS) {
    const tok = await getTokenForApiCall("ga4_access", conn.id, {
      agencyId: conn.agencyId,
      hotelClientId: conn.hotelClientId,
      source: "sync:ga4",
    });
    return tok.reveal();
  }

  console.log(`${TLOG} access token near/at expiry for conn ${conn.id} → refreshing`);
  const rt = await getTokenForApiCall("ga4_refresh", conn.id, {
    agencyId: conn.agencyId,
    hotelClientId: conn.hotelClientId,
    source: "refresh:ga4",
  });
  let refreshed: { accessToken: string; expiresAt: Date };
  try {
    refreshed = await refreshAccessToken(rt.reveal());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    const code = googleErrorCode(msg);
    // Refresh tokens are bound to the OAuth client that minted them; the usual
    // cause here is a GOOGLE_OAUTH_CLIENT_ID/SECRET change orphaning this token
    // (invalid_grant / invalid_client). Flag it for a one-click reconnect.
    console.error(
      "[GA4-OAUTH-FAILURE]",
      JSON.stringify({ hotelClientId: conn.hotelClientId, connId: conn.id, googleError: code, message: msg }),
    );
    await prisma.ga4Connection.update({
      where: { id: conn.id },
      data: {
        status: "TOKEN_EXPIRED",
        lastSyncError: `Token refresh failed: ${msg}`,
        requiresReconnect: true,
        lastErrorReason: code,
      },
    });
    throw err instanceof GaOAuthError ? err : new GaOAuthError(msg);
  }
  const enc = await encryptWithAudit(refreshed.accessToken, {
    agencyId: conn.agencyId,
    hotelClientId: conn.hotelClientId,
    tokenType: "ga4",
    source: "refresh:ga4",
  });
  await prisma.ga4Connection.update({
    where: { id: conn.id },
    data: {
      accessToken: enc,
      tokenExpiresAt: refreshed.expiresAt,
      status: "ACTIVE",
      requiresReconnect: false,
      lastErrorReason: null,
    },
  });
  console.log(`${TLOG} refreshed OK conn ${conn.id} (new token ${mask(refreshed.accessToken)}, exp ${refreshed.expiresAt.toISOString()})`);
  return refreshed.accessToken;
}

// ── Aggregation ───────────────────────────────────────────────────────────────

// A composite metric tally keyed by a joined dimension string, so the multi-
// metric breakdowns (R2/R3/R4/R6/R7/R8) can carry several metrics per row.
type Tally = {
  sessions: number; users: number; newUsers: number; keyEvents: number;
  engaged: number; count: number; views: number; entrances: number;
};
const emptyTally = (): Tally => ({ sessions: 0, users: 0, newUsers: 0, keyEvents: 0, engaged: 0, count: 0, views: 0, entrances: 0 });
function addTally(m: Map<string, Tally>, key: string, patch: Partial<Tally>) {
  let t = m.get(key);
  if (!t) { t = emptyTally(); m.set(key, t); }
  for (const [k, v] of Object.entries(patch)) t[k as keyof Tally] += v ?? 0;
}

// Aggregation buckets, one per calendar day.
type DayBucket = {
  sessions: number; users: number; newUsers: number; pageViews: number;
  bounceRate: number; avgSessionDuration: number;
  // Engagement (R1)
  engagedSessions: number; engagementRate: number; userEngagementDuration: number; screenPageViewsPerSession: number;
  keyEvents: number; returningUsers: number;
  // Ecommerce (R5) — null-tracked via hasEcom
  purchaseRevenue: number; transactions: number; purchaserRate: number; hasEcom: boolean;
  // Channel buckets (folded from R2)
  organic: number; paid: number; social: number; direct: number; referral: number;
  // Google Ads (best-effort)
  adsClicks: number; adsImpressions: number; adsCost: number; adsConversions: number; hasAds: boolean;
  // Device
  mobile: number; desktop: number; tablet: number;
  // Simple session top-N maps
  countries: Map<string, number>; cities: Map<string, number>; landing: Map<string, number>;
  regions: Map<string, number>; browsers: Map<string, number>; os: Map<string, number>;
  // Composite breakdowns
  sources: Map<string, Tally>; campaigns: Map<string, Tally>; firstUser: Map<string, Tally>;
  events: Map<string, Tally>; pages: Map<string, Tally>; landingSrc: Map<string, Tally>; newReturning: Map<string, Tally>;
};

function emptyBucket(): DayBucket {
  return {
    sessions: 0, users: 0, newUsers: 0, pageViews: 0, bounceRate: 0, avgSessionDuration: 0,
    engagedSessions: 0, engagementRate: 0, userEngagementDuration: 0, screenPageViewsPerSession: 0,
    keyEvents: 0, returningUsers: 0,
    purchaseRevenue: 0, transactions: 0, purchaserRate: 0, hasEcom: false,
    organic: 0, paid: 0, social: 0, direct: 0, referral: 0,
    adsClicks: 0, adsImpressions: 0, adsCost: 0, adsConversions: 0, hasAds: false,
    mobile: 0, desktop: 0, tablet: 0,
    countries: new Map(), cities: new Map(), landing: new Map(),
    regions: new Map(), browsers: new Map(), os: new Map(),
    sources: new Map(), campaigns: new Map(), firstUser: new Map(),
    events: new Map(), pages: new Map(), landingSrc: new Map(), newReturning: new Map(),
  };
}

const num = (v: string | undefined) => Number(v ?? 0) || 0;
const round2 = (x: number) => Math.round(x * 100) / 100;
const topN = (m: Map<string, number>, n: number, key: "name" | "path") =>
  [...m.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, s]) => ({ [key]: k, sessions: s }));

// GA4 returns "(not set)" / "(none)" / "" for absent dimension values. Normalize
// so top-N lists don't fragment across those spellings.
function dim(v: string | undefined, fallback = "(not set)"): string {
  const s = (v ?? "").trim();
  if (!s || s === "(not set)" || s === "(none)") return fallback;
  return s;
}
const disp = (v: string, fallback = "(not set)") => (v ? v : fallback);

// Key delimiter for composite tallies: a control char (US, 0x1F) that never
// appears in GA4 dimension values, so campaign names / paths containing spaces
// survive the join→split round-trip intact.
const SEP = String.fromCharCode(31);
const keyOf = (...parts: (string | undefined)[]) => parts.map((p) => dim(p, "")).join(SEP);

// Rank a composite Tally map by `by` desc, keep top n, project via `shape`.
function topTally<T>(m: Map<string, Tally>, n: number, shape: (parts: string[], t: Tally) => T, by: keyof Tally = "sessions"): T[] {
  return [...m.entries()]
    .filter(([, t]) => (t[by] || 0) > 0 || (t.count || 0) > 0)
    .sort((a, b) => (b[1][by] || 0) - (a[1][by] || 0))
    .slice(0, n)
    .map(([k, t]) => shape(k.split(SEP), t));
}

function bucketOf(map: Map<string, DayBucket>, dateKey: string): DayBucket {
  let b = map.get(dateKey);
  if (!b) { b = emptyBucket(); map.set(dateKey, b); }
  return b;
}

// Map GA's sessionDefaultChannelGroup into the 5 dashboard buckets.
function addChannel(b: DayBucket, channel: string, sessions: number) {
  const c = channel.toLowerCase();
  if (c === "organic search") b.organic += sessions;
  else if (c === "paid search") b.paid += sessions;
  else if (c.includes("social")) b.social += sessions;
  else if (c === "direct") b.direct += sessions;
  else if (c === "referral") b.referral += sessions;
}

export type Ga4AccountSyncResult = {
  ok: boolean;
  daysSynced?: number;
  tokenExpired?: boolean;
  error?: string;
};

/** Syncs the trailing `days` (default 30) for one connection. Never throws. */
export async function syncGa4Connection(conn: Conn, days = 30): Promise<Ga4AccountSyncResult> {
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(conn);
  } catch (err) {
    return { ok: false, tokenExpired: true, error: err instanceof Error ? err.message : "token error" };
  }

  const startDate = `${days}daysAgo`;
  const endDate = "yesterday";
  const dateRanges = [{ startDate, endDate }];
  const run = (req: ReportRequest) => runReport(accessToken, conn.propertyId, req);

  // Swap a metric name in a request (for the keyEvents→conversions fallback).
  const swapMetric = (req: ReportRequest, from: string, to: string): ReportRequest => ({
    ...req,
    metrics: req.metrics.map((m) => (m.name === from ? { name: to } : m)),
  });

  // Runs one themed report. Auth failures bubble up (so the connection is flagged
  // for reconnect); any other GA API failure — incompatible dim/metric pairing,
  // quota, or an empty ecommerce property — is logged and skipped, returning [].
  // `keyEvents` (the 2024 rename of "conversions") is retried as "conversions" on
  // older properties that only expose the legacy name.
  const safeRun = async (label: string, req: ReportRequest): Promise<ReportRow[]> => {
    try {
      return await run(req);
    } catch (err) {
      if (err instanceof GaAuthExpiredError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/keyEvents/i.test(msg) && JSON.stringify(req.metrics).includes('"keyEvents"')) {
        try {
          return await run(swapMetric(req, "keyEvents", "conversions"));
        } catch (e2) {
          if (e2 instanceof GaAuthExpiredError) throw e2;
        }
      }
      console.warn(`${LOG} report ${label} skipped for ${conn.hotelClientId}: ${msg.slice(0, 200)}`);
      return [];
    }
  };

  try {
    // ── Group A: core traffic + acquisition + geo (session/user scoped) ──────
    // R1 traffic+engagement, R2 session acquisition, R3 first-user acquisition,
    // country, city, device. (Old standalone channel + landing calls are FOLDED
    // into R2 / R7 respectively.)
    const [traffic, acquisition, firstUser, countries, cities, devices] = await Promise.all([
      safeRun("R1-traffic", { dateRanges, dimensions: [{ name: "date" }], metrics: [
        { name: "sessions" }, { name: "totalUsers" }, { name: "newUsers" }, { name: "screenPageViews" },
        { name: "bounceRate" }, { name: "averageSessionDuration" }, { name: "engagedSessions" },
        { name: "engagementRate" }, { name: "userEngagementDuration" }, { name: "screenPageViewsPerSession" },
      ] }),
      safeRun("R2-acquisition", { dateRanges, dimensions: [
        { name: "date" }, { name: "sessionSource" }, { name: "sessionMedium" },
        { name: "sessionCampaignName" }, { name: "sessionDefaultChannelGroup" },
      ], metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "engagedSessions" }, { name: "keyEvents" }],
        // High cardinality: raise the 10k default + order by sessions so folded
        // channel totals stay accurate even if GA4 truncates the tail.
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 50000 }),
      safeRun("R3-firstUser", { dateRanges, dimensions: [
        { name: "date" }, { name: "firstUserSource" }, { name: "firstUserMedium" }, { name: "firstUserDefaultChannelGroup" },
      ], metrics: [{ name: "totalUsers" }, { name: "newUsers" }, { name: "sessions" }, { name: "keyEvents" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 50000 }),
      safeRun("country", { dateRanges, dimensions: [{ name: "date" }, { name: "country" }], metrics: [{ name: "sessions" }] }),
      safeRun("city", { dateRanges, dimensions: [{ name: "date" }, { name: "city" }], metrics: [{ name: "sessions" }] }),
      safeRun("device", { dateRanges, dimensions: [{ name: "date" }, { name: "deviceCategory" }], metrics: [{ name: "sessions" }] }),
    ]);

    // ── Group B: events, pages, landing×source, audience, tech, ecommerce ────
    const [events, pages, landingSrc, newReturning, regions, browsers, osRows, ecom] = await Promise.all([
      safeRun("R4-events", { dateRanges, dimensions: [{ name: "date" }, { name: "eventName" }],
        metrics: [{ name: "eventCount" }, { name: "keyEvents" }, { name: "totalUsers" }],
        orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: 20000 }),
      safeRun("R6-pages", { dateRanges, dimensions: [{ name: "date" }, { name: "pagePath" }, { name: "pageTitle" }],
        metrics: [{ name: "screenPageViews" }, { name: "entrances" }],
        orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }], limit: 50000 }),
      safeRun("R7-landingBySource", { dateRanges, dimensions: [
        { name: "date" }, { name: "landingPagePlusQueryString" }, { name: "sessionSource" }, { name: "sessionMedium" },
      ], metrics: [{ name: "sessions" }, { name: "keyEvents" }, { name: "engagedSessions" }, { name: "totalUsers" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 50000 }),
      safeRun("R8-newVsReturning", { dateRanges, dimensions: [{ name: "date" }, { name: "newVsReturning" }],
        metrics: [{ name: "totalUsers" }, { name: "newUsers" }, { name: "sessions" }] }),
      safeRun("R9a-region", { dateRanges, dimensions: [{ name: "date" }, { name: "region" }], metrics: [{ name: "sessions" }] }),
      safeRun("R9b-browser", { dateRanges, dimensions: [{ name: "date" }, { name: "browser" }], metrics: [{ name: "sessions" }] }),
      safeRun("R9c-os", { dateRanges, dimensions: [{ name: "date" }, { name: "operatingSystem" }], metrics: [{ name: "sessions" }] }),
      safeRun("R5-ecommerce", { dateRanges, dimensions: [{ name: "date" }],
        metrics: [{ name: "purchaseRevenue" }, { name: "transactions" }, { name: "purchaserRate" }, { name: "totalUsers" }] }),
    ]);

    const byDate = new Map<string, DayBucket>();

    // R1 traffic + engagement
    for (const r of traffic) {
      const b = bucketOf(byDate, r.dimensionValues[0].value);
      b.sessions = num(r.metricValues[0]?.value);
      b.users = num(r.metricValues[1]?.value);
      b.newUsers = num(r.metricValues[2]?.value);
      b.pageViews = num(r.metricValues[3]?.value);
      b.bounceRate = num(r.metricValues[4]?.value);
      b.avgSessionDuration = Math.round(num(r.metricValues[5]?.value));
      b.engagedSessions = num(r.metricValues[6]?.value);
      b.engagementRate = num(r.metricValues[7]?.value);
      b.userEngagementDuration = Math.round(num(r.metricValues[8]?.value));
      b.screenPageViewsPerSession = round2(num(r.metricValues[9]?.value));
    }

    // R2 acquisition → channel buckets (folded) + source/campaign breakdowns
    for (const r of acquisition) {
      const b = bucketOf(byDate, r.dimensionValues[0].value);
      const source = r.dimensionValues[1]?.value ?? "";
      const medium = r.dimensionValues[2]?.value ?? "";
      const campaign = r.dimensionValues[3]?.value ?? "";
      const channel = r.dimensionValues[4]?.value ?? "";
      const sessions = num(r.metricValues[0]?.value);
      const users = num(r.metricValues[1]?.value);
      const engaged = num(r.metricValues[2]?.value);
      const keyEvents = num(r.metricValues[3]?.value);
      addChannel(b, channel, sessions);
      addTally(b.sources, keyOf(source, medium), { sessions, users, engaged, keyEvents });
      addTally(b.campaigns, keyOf(campaign), { sessions, users, keyEvents });
    }

    // R3 first-user acquisition
    for (const r of firstUser) {
      const b = bucketOf(byDate, r.dimensionValues[0].value);
      const source = r.dimensionValues[1]?.value ?? "";
      const medium = r.dimensionValues[2]?.value ?? "";
      const channel = r.dimensionValues[3]?.value ?? "";
      addTally(b.firstUser, keyOf(source, medium, channel), {
        users: num(r.metricValues[0]?.value), newUsers: num(r.metricValues[1]?.value),
        sessions: num(r.metricValues[2]?.value), keyEvents: num(r.metricValues[3]?.value),
      });
    }

    // country / city / device
    for (const r of countries) {
      const b = bucketOf(byDate, r.dimensionValues[0].value);
      const c = r.dimensionValues[1]?.value || "(unknown)";
      b.countries.set(c, (b.countries.get(c) ?? 0) + num(r.metricValues[0]?.value));
    }
    for (const r of cities) {
      const b = bucketOf(byDate, r.dimensionValues[0].value);
      const c = r.dimensionValues[1]?.value || "(unknown)";
      b.cities.set(c, (b.cities.get(c) ?? 0) + num(r.metricValues[0]?.value));
    }
    for (const r of devices) {
      const b = bucketOf(byDate, r.dimensionValues[0].value);
      const d = (r.dimensionValues[1]?.value ?? "").toLowerCase();
      const s = num(r.metricValues[0]?.value);
      if (d === "mobile") b.mobile += s;
      else if (d === "desktop") b.desktop += s;
      else if (d === "tablet") b.tablet += s;
    }

    // R4 events
    for (const r of events) {
      const b = bucketOf(byDate, r.dimensionValues[0].value);
      addTally(b.events, keyOf(r.dimensionValues[1]?.value), {
        count: num(r.metricValues[0]?.value), keyEvents: num(r.metricValues[1]?.value), users: num(r.metricValues[2]?.value),
      });
    }

    // R6 pages
    for (const r of pages) {
      const b = bucketOf(byDate, r.dimensionValues[0].value);
      const path = r.dimensionValues[1]?.value || "/";
      const title = r.dimensionValues[2]?.value ?? "";
      addTally(b.pages, keyOf(path, title), { views: num(r.metricValues[0]?.value), entrances: num(r.metricValues[1]?.value) });
    }

    // R7 landing × source (also folds the plain landing-page top-N)
    for (const r of landingSrc) {
      const b = bucketOf(byDate, r.dimensionValues[0].value);
      const landing = r.dimensionValues[1]?.value || "/";
      const source = r.dimensionValues[2]?.value ?? "";
      const medium = r.dimensionValues[3]?.value ?? "";
      const sessions = num(r.metricValues[0]?.value);
      addTally(b.landingSrc, keyOf(landing, source, medium), {
        sessions, keyEvents: num(r.metricValues[1]?.value), engaged: num(r.metricValues[2]?.value), users: num(r.metricValues[3]?.value),
      });
      b.landing.set(landing, (b.landing.get(landing) ?? 0) + sessions);
    }

    // R8 new vs returning
    for (const r of newReturning) {
      const b = bucketOf(byDate, r.dimensionValues[0].value);
      const seg = r.dimensionValues[1]?.value ?? "";
      const users = num(r.metricValues[0]?.value);
      addTally(b.newReturning, keyOf(seg), { users, newUsers: num(r.metricValues[1]?.value), sessions: num(r.metricValues[2]?.value) });
      if (seg.toLowerCase() === "returning") b.returningUsers += users;
    }

    // R9 region / browser / operatingSystem
    for (const r of regions) {
      const b = bucketOf(byDate, r.dimensionValues[0].value);
      const k = r.dimensionValues[1]?.value || "(unknown)";
      b.regions.set(k, (b.regions.get(k) ?? 0) + num(r.metricValues[0]?.value));
    }
    for (const r of browsers) {
      const b = bucketOf(byDate, r.dimensionValues[0].value);
      const k = r.dimensionValues[1]?.value || "(unknown)";
      b.browsers.set(k, (b.browsers.get(k) ?? 0) + num(r.metricValues[0]?.value));
    }
    for (const r of osRows) {
      const b = bucketOf(byDate, r.dimensionValues[0].value);
      const k = r.dimensionValues[1]?.value || "(unknown)";
      b.os.set(k, (b.os.get(k) ?? 0) + num(r.metricValues[0]?.value));
    }

    // R5 ecommerce (only flagged present when there's real revenue/transactions)
    for (const r of ecom) {
      const b = bucketOf(byDate, r.dimensionValues[0].value);
      const revenue = num(r.metricValues[0]?.value);
      const txns = num(r.metricValues[1]?.value);
      b.purchaseRevenue = Math.round(revenue * 100); // currency → paise
      b.transactions = Math.round(txns);
      b.purchaserRate = num(r.metricValues[2]?.value); // 0..1
      if (revenue > 0 || txns > 0) b.hasEcom = true;
    }

    // R10 Google Ads (best-effort: needs a Google Ads ↔ GA4 link; on error skip).
    try {
      const ads = await run({
        dateRanges, dimensions: [{ name: "date" }],
        metrics: [{ name: "advertiserAdClicks" }, { name: "advertiserAdImpressions" }, { name: "advertiserAdCost" }, { name: "conversions" }],
        dimensionFilter: { andGroup: { expressions: [
          { filter: { fieldName: "sessionSource", stringFilter: { value: "google" } } },
          { filter: { fieldName: "sessionMedium", stringFilter: { value: "cpc" } } },
        ] } },
      });
      for (const r of ads) {
        const b = bucketOf(byDate, r.dimensionValues[0].value);
        b.adsClicks = num(r.metricValues[0]?.value);
        b.adsImpressions = num(r.metricValues[1]?.value);
        b.adsCost = Math.round(num(r.metricValues[2]?.value) * 100); // currency → paise
        b.adsConversions = Math.round(num(r.metricValues[3]?.value));
        b.hasAds = b.adsClicks > 0 || b.adsImpressions > 0 || b.adsCost > 0;
      }
    } catch (err) {
      if (err instanceof GaAuthExpiredError) throw err;
      console.warn(`${LOG} Google Ads query skipped for ${conn.hotelClientId}: ${err instanceof Error ? err.message : err}`);
    }

    // Upsert one Ga4Snapshot per day.
    let daysSynced = 0;
    for (const [dateKey, b] of byDate) {
      const date = gaDateToUtc(dateKey);
      const data = {
        sessions: b.sessions, users: b.users, newUsers: b.newUsers, pageViews: b.pageViews,
        bounceRate: b.bounceRate, avgSessionDuration: b.avgSessionDuration,
        engagedSessions: b.engagedSessions, engagementRate: b.engagementRate,
        userEngagementDuration: b.userEngagementDuration, screenPageViewsPerSession: b.screenPageViewsPerSession,
        keyEvents: b.keyEvents, returningUsers: b.returningUsers,
        purchaseRevenue: b.hasEcom ? b.purchaseRevenue : null,
        transactions: b.hasEcom ? b.transactions : null,
        purchaserRate: b.hasEcom ? b.purchaserRate : null,
        organicSessions: b.organic, paidSessions: b.paid, socialSessions: b.social,
        directSessions: b.direct, referralSessions: b.referral,
        googleAdsClicks: b.hasAds ? b.adsClicks : null,
        googleAdsImpressions: b.hasAds ? b.adsImpressions : null,
        googleAdsCost: b.hasAds ? b.adsCost : null,
        googleAdsConversions: b.hasAds ? b.adsConversions : null,
        mobileSessions: b.mobile, desktopSessions: b.desktop, tabletSessions: b.tablet,
        topCountries: topN(b.countries, 5, "name"),
        topCities: topN(b.cities, 5, "name"),
        topLandingPages: topN(b.landing, 10, "path"),
        topRegions: topN(b.regions, 10, "name"),
        topBrowsers: topN(b.browsers, 10, "name"),
        topOperatingSystems: topN(b.os, 10, "name"),
        topSources: topTally(b.sources, 20, (p, t) => ({ source: disp(p[0]), medium: disp(p[1]), sessions: t.sessions, users: t.users, keyEvents: t.keyEvents })),
        topCampaigns: topTally(b.campaigns, 20, (p, t) => ({ campaign: disp(p[0]), sessions: t.sessions, users: t.users, keyEvents: t.keyEvents })),
        firstUserChannels: topTally(b.firstUser, 20, (p, t) => ({ source: disp(p[0]), medium: disp(p[1]), channel: disp(p[2]), users: t.users, newUsers: t.newUsers, sessions: t.sessions, keyEvents: t.keyEvents })),
        topEvents: topTally(b.events, 30, (p, t) => ({ event: disp(p[0]), count: t.count, keyEvents: t.keyEvents, users: t.users }), "count"),
        topPages: topTally(b.pages, 25, (p, t) => ({ path: disp(p[0], "/"), title: p[1] ?? "", views: t.views, entrances: t.entrances }), "views"),
        landingBySource: topTally(b.landingSrc, 25, (p, t) => ({ landing: disp(p[0], "/"), source: disp(p[1]), medium: disp(p[2]), sessions: t.sessions, keyEvents: t.keyEvents, engagedSessions: t.engaged, users: t.users })),
        newVsReturning: topTally(b.newReturning, 4, (p, t) => ({ segment: disp(p[0]), users: t.users, newUsers: t.newUsers, sessions: t.sessions }), "users"),
      };
      await prisma.ga4Snapshot.upsert({
        where: { hotelClientId_date: { hotelClientId: conn.hotelClientId, date } },
        create: { agencyId: conn.agencyId, hotelClientId: conn.hotelClientId, date, ...data },
        update: data,
      });
      daysSynced += 1;
    }

    await prisma.ga4Connection.update({
      where: { id: conn.id },
      data: {
        lastSyncedAt: new Date(),
        status: "ACTIVE",
        lastSyncError: null,
        requiresReconnect: false,
        lastErrorReason: null,
      },
    });
    console.log(`${LOG} ${conn.hotelClientId}: ${daysSynced} days upserted`);
    return { ok: true, daysSynced };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown GA4 sync error.";
    const tokenExpired = err instanceof GaAuthExpiredError;
    console.error(`${LOG} ${conn.hotelClientId} FAILED: ${msg}`);
    if (tokenExpired) {
      console.error(
        "[GA4-OAUTH-FAILURE]",
        JSON.stringify({ hotelClientId: conn.hotelClientId, connId: conn.id, googleError: "auth_expired", message: msg }),
      );
    }
    await prisma.ga4Connection.update({
      where: { id: conn.id },
      data: {
        status: tokenExpired ? "TOKEN_EXPIRED" : "ERROR",
        lastSyncError: msg,
        // Only an auth failure means the user must reconnect; a transient data
        // error keeps the connection usable, so don't flag it.
        ...(tokenExpired ? { requiresReconnect: true, lastErrorReason: googleErrorCode(msg) } : {}),
      },
    });
    return { ok: false, tokenExpired, error: msg };
  }
}

export type Ga4SyncResult = {
  processed: number;
  synced: number;
  daysSynced: number;
  tokenExpired: number;
  errors: { hotelClientId: string; error: string }[];
};

/** Syncs every ACTIVE GA4 connection (optionally one agency / one hotel). Never throws. */
export async function runGa4Sync(
  opts: { agencyId?: string; hotelClientId?: string; days?: number; accountDelayMs?: number } = {},
): Promise<Ga4SyncResult> {
  const delay = opts.accountDelayMs ?? 500;
  const conns = await prisma.ga4Connection.findMany({
    where: {
      status: "ACTIVE",
      propertyId: { not: "" }, // skip connections still awaiting property selection
      hotelClient: { deletedAt: null }, // never sync soft-deleted hotels
      ...(opts.agencyId ? { agencyId: opts.agencyId } : {}),
      ...(opts.hotelClientId ? { hotelClientId: opts.hotelClientId } : {}),
    },
    orderBy: { lastSyncedAt: "asc" },
    select: { id: true, agencyId: true, hotelClientId: true, propertyId: true, tokenExpiresAt: true },
  });

  const result: Ga4SyncResult = { processed: 0, synced: 0, daysSynced: 0, tokenExpired: 0, errors: [] };
  for (let i = 0; i < conns.length; i++) {
    if (i > 0 && delay > 0) await sleep(delay);
    result.processed += 1;
    const res = await syncGa4Connection(conns[i], opts.days ?? 30);
    if (res.ok) {
      result.synced += 1;
      result.daysSynced += res.daysSynced ?? 0;
    } else {
      if (res.tokenExpired) result.tokenExpired += 1;
      result.errors.push({ hotelClientId: conns[i].hotelClientId, error: res.error ?? "unknown" });
    }
  }
  return result;
}
