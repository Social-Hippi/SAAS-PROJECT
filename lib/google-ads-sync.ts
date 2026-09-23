import "server-only";

import { prisma } from "@/lib/prisma";
import { getTokenForApiCall } from "@/lib/token-access";
import { encryptWithAudit } from "@/lib/token-audit";
import {
  searchStream,
  loginCustomerId,
  refreshAccessToken,
  GoogleAdsAuthError,
  GoogleAdsOAuthError,
  mask,
  type GaqlRow,
} from "@/lib/google-ads";

// Google Ads daily sync (STEP 2). For each ACTIVE connection with a selected
// customer account: refresh the access token if near expiry, pull trailing-30-day
// per-campaign metrics via GAQL, and upsert one GoogleAdsCampaignSnapshot per
// campaign-day. Resilient: one hotel's failure (or an expired token) never aborts
// the batch. An account with no campaigns is a SUCCESS (0 rows), not an error.
//
// Logs under [GADS-SYNC] / [GADS-TOKEN]; tokens are never logged in full.

const LOG = "[GADS-SYNC]";
const TLOG = "[GADS-TOKEN]";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function googleErrorCode(message: string): string {
  const m = message.match(
    /\b(invalid_grant|invalid_client|invalid_request|unauthorized_client|invalid_scope|access_denied)\b/,
  );
  return m ? m[1] : message.slice(0, 200);
}

// "YYYY-MM-DD" → Date(UTC midnight). GA's segments.date is ISO date.
function isoDateToUtc(d: string): Date {
  return new Date(`${d}T00:00:00.000Z`);
}

// Trailing window ending yesterday (UTC), inclusive of `days` days.
function dateRange(days: number): { start: string; end: string } {
  const end = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

export type Conn = {
  id: string;
  agencyId: string;
  hotelClientId: string;
  customerId: string;
  loginCustomerId: string | null;
  tokenExpiresAt: Date;
};

/** Returns a usable access token, refreshing + re-storing (encrypted) near expiry. */
export async function getValidAccessToken(conn: Conn): Promise<string> {
  if (conn.tokenExpiresAt.getTime() > Date.now() + REFRESH_SKEW_MS) {
    const tok = await getTokenForApiCall("google_ads_access", conn.id, {
      agencyId: conn.agencyId,
      hotelClientId: conn.hotelClientId,
      source: "sync:google-ads",
    });
    return tok.reveal();
  }

  console.log(`${TLOG} access token near/at expiry for conn ${conn.id} → refreshing`);
  const rt = await getTokenForApiCall("google_ads_refresh", conn.id, {
    agencyId: conn.agencyId,
    hotelClientId: conn.hotelClientId,
    source: "refresh:google-ads",
  });
  let refreshed: { accessToken: string; expiresAt: Date };
  try {
    refreshed = await refreshAccessToken(rt.reveal());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    const code = googleErrorCode(msg);
    console.error(
      "[GADS-OAUTH-FAILURE]",
      JSON.stringify({ hotelClientId: conn.hotelClientId, connId: conn.id, googleError: code, message: msg }),
    );
    await prisma.googleAdsConnection.update({
      where: { id: conn.id },
      data: {
        status: "TOKEN_EXPIRED",
        lastSyncError: `Token refresh failed: ${msg}`,
        requiresReconnect: true,
        lastErrorReason: code,
      },
    });
    throw err instanceof GoogleAdsOAuthError ? err : new GoogleAdsOAuthError(msg);
  }
  const enc = await encryptWithAudit(refreshed.accessToken, {
    agencyId: conn.agencyId,
    hotelClientId: conn.hotelClientId,
    tokenType: "google_ads",
    source: "refresh:google-ads",
  });
  await prisma.googleAdsConnection.update({
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

const numStr = (v: unknown): number => Number(v ?? 0) || 0;
const money2 = (n: number): number => Math.round(n * 100) / 100;

export type GoogleAdsAccountSyncResult = {
  ok: boolean;
  campaignDays?: number;
  tokenExpired?: boolean;
  error?: string;
};

/** Syncs the trailing `days` (default 30) of campaign metrics for one connection. Never throws. */
export async function syncGoogleAdsConnection(conn: Conn, days = 30): Promise<GoogleAdsAccountSyncResult> {
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(conn);
  } catch (err) {
    return { ok: false, tokenExpired: true, error: err instanceof Error ? err.message : "token error" };
  }

  const { start, end } = dateRange(days);
  // Per-campaign metrics MUST come FROM campaign. Selecting campaign.* FROM customer
  // is rejected with PROHIBITED_RESOURCE_TYPE_IN_SELECT_CLAUSE (the campaign resource
  // is incompatible with the customer resource in the FROM clause). Verified against
  // the Google Ads API v24 GAQL grammar.
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      segments.date,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${start}' AND '${end}'
  `;

  let rows: GaqlRow[];
  try {
    // login-customer-id is per-connection (derived from the account hierarchy at
    // OAuth time). Fall back to the legacy platform MCC env var ONLY here, for
    // connections stored before that derivation existed or whose derivation was
    // skipped by the catch in selectGoogleAdsCustomer — without it those rows
    // would start failing USER_PERMISSION_DENIED. Account DISCOVERY deliberately
    // does not use this fallback: sending one agency's MCC on another agency's
    // lookup is what made a valid account look inaccessible.
    const login = conn.loginCustomerId ?? loginCustomerId();
    rows = await searchStream(accessToken, conn.customerId, query, login);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown Google Ads sync error.";
    const tokenExpired = err instanceof GoogleAdsAuthError;
    console.error(`${LOG} ${conn.hotelClientId} FAILED: ${msg}`);
    await prisma.googleAdsConnection.update({
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

  // ── Calls, from two separate best-effort queries ──────────────────────────
  //
  // BEST-EFFORT, AND SEPARATE FROM THE MAIN QUERY ON PURPOSE. Adding these
  // fields to the query above would mean one unsupported field costs the whole
  // sync — spend, impressions and clicks included — for every hotel at once.
  // Here a failure costs only the call figures, which then stay null and render
  // as "not available" rather than as zero calls.
  //
  // TWO MEASUREMENTS, NEVER SUMMED. A call from a call asset that the advertiser
  // also tracks as a conversion appears in both, so one total would count it
  // twice and nothing downstream could unpick it.
  //
  // The category is filtered in code rather than in the WHERE clause: an enum
  // value Google renames would turn a filtered query into an error, while an
  // unrecognised value here simply matches nothing.
  const callConversionsByKey = new Map<string, number>();
  try {
    const callRows = await searchStream(
      accessToken,
      conn.customerId,
      `
    SELECT
      campaign.id,
      segments.date,
      segments.conversion_action_category,
      metrics.all_conversions
    FROM campaign
    WHERE segments.date BETWEEN '${start}' AND '${end}'
  `,
      conn.loginCustomerId ?? loginCustomerId(),
    );
    for (const r of callRows) {
      const campaignId = String(((r.campaign ?? {}) as { id?: string | number }).id ?? "");
      const seg = (r.segments ?? {}) as { date?: string; conversionActionCategory?: string };
      if (!campaignId || !seg.date) continue;
      if (String(seg.conversionActionCategory ?? "").toUpperCase() !== "PHONE_CALL_LEAD") continue;
      const value = numStr(((r.metrics ?? {}) as { allConversions?: number }).allConversions);
      const key = `${campaignId}|${seg.date}`;
      callConversionsByKey.set(key, (callConversionsByKey.get(key) ?? 0) + value);
    }
  } catch (err) {
    console.warn(
      `${LOG} ${conn.hotelClientId} call conversions skipped: ${err instanceof Error ? err.message : err}`,
    );
  }

  const phoneCallsByKey = new Map<string, number>();
  try {
    const phoneRows = await searchStream(
      accessToken,
      conn.customerId,
      `
    SELECT
      campaign.id,
      segments.date,
      metrics.phone_calls
    FROM campaign
    WHERE segments.date BETWEEN '${start}' AND '${end}'
  `,
      conn.loginCustomerId ?? loginCustomerId(),
    );
    for (const r of phoneRows) {
      const campaignId = String(((r.campaign ?? {}) as { id?: string | number }).id ?? "");
      const seg = (r.segments ?? {}) as { date?: string };
      if (!campaignId || !seg.date) continue;
      const value = numStr(((r.metrics ?? {}) as { phoneCalls?: string | number }).phoneCalls);
      phoneCallsByKey.set(`${campaignId}|${seg.date}`, value);
    }
  } catch (err) {
    console.warn(
      `${LOG} ${conn.hotelClientId} phone calls skipped: ${err instanceof Error ? err.message : err}`,
    );
  }

  // TAPS on a call button — "clicks to call". Clicks segmented by click type,
  // keeping only the types Google describes as calls (enum ClickType, API v24):
  //   CALLS                 "Phone calls"
  //   MOBILE_CALL_TRACKING  "Mobile phone calls"
  //   LOCATION_FORMAT_CALL  "Call" (from a location asset)
  // CALL_TRACKING — "Manually dialed phone calls" — is left out on purpose: a
  // number typed into a phone is not a tap on the ad.
  //
  // Each click carries exactly one click type, so summing these types cannot
  // count a tap twice. They are NEVER summed with phone_calls: a guest who taps
  // and connects is in both, and one total would count them twice.
  //
  // THE ZERO PROBLEM. Segmenting by click type makes Google return no row at all
  // for a day with no call taps, which would look exactly like a failed query.
  // So success is tracked separately: when the query ran, every campaign-day gets
  // a number (0 where Google recorded no call taps); only a failed query leaves
  // the column null. A genuine zero is a finding; a gap must never be written as
  // one.
  const CALL_CLICK_TYPES = new Set(["CALLS", "MOBILE_CALL_TRACKING", "LOCATION_FORMAT_CALL"]);
  const callClicksByKey = new Map<string, number>();
  let callClicksQueried = false;
  try {
    const clickRows = await searchStream(
      accessToken,
      conn.customerId,
      `
    SELECT
      campaign.id,
      segments.date,
      segments.click_type,
      metrics.clicks
    FROM campaign
    WHERE segments.date BETWEEN '${start}' AND '${end}'
  `,
      conn.loginCustomerId ?? loginCustomerId(),
    );
    for (const r of clickRows) {
      const campaignId = String(((r.campaign ?? {}) as { id?: string | number }).id ?? "");
      const seg = (r.segments ?? {}) as { date?: string; clickType?: string };
      if (!campaignId || !seg.date) continue;
      if (!CALL_CLICK_TYPES.has(String(seg.clickType ?? "").toUpperCase())) continue;
      const value = numStr(((r.metrics ?? {}) as { clicks?: string | number }).clicks);
      const key = `${campaignId}|${seg.date}`;
      callClicksByKey.set(key, (callClicksByKey.get(key) ?? 0) + value);
    }
    callClicksQueried = true;
  } catch (err) {
    console.warn(
      `${LOG} ${conn.hotelClientId} call clicks skipped: ${err instanceof Error ? err.message : err}`,
    );
  }

  // Parse + upsert one row per campaign-day. Metrics rows only exist for days with
  // activity, so an account with no active campaigns simply yields 0 rows (success).
  let campaignDays = 0;
  try {
    for (const r of rows) {
      const campaign = (r.campaign ?? {}) as {
        id?: string | number;
        name?: string;
        status?: string;
        advertisingChannelType?: string;
      };
      const metrics = (r.metrics ?? {}) as {
        costMicros?: string | number; impressions?: string | number; clicks?: string | number;
        conversions?: number; conversionsValue?: number;
      };
      const segments = (r.segments ?? {}) as { date?: string };
      const campaignId = String(campaign.id ?? "");
      const dateStr = segments.date ?? "";
      if (!campaignId || !dateStr) continue;

      const date = isoDateToUtc(dateStr);
      const data = {
        agencyId: conn.agencyId,
        customerId: conn.customerId,
        campaignName: campaign.name ?? "(unnamed campaign)",
        status: campaign.status ?? "UNKNOWN",
        advertisingChannelType: campaign.advertisingChannelType ?? null,
        spend: money2(numStr(metrics.costMicros) / 1_000_000),
        impressions: Math.round(numStr(metrics.impressions)),
        clicks: Math.round(numStr(metrics.clicks)),
        conversions: numStr(metrics.conversions),
        conversionsValue: money2(numStr(metrics.conversionsValue)),
        // `?? null` rather than `?? 0`: a day whose extra query failed has NOT
        // had zero calls, and writing 0 would report a measurement gap as a
        // finding on the hotel's own report.
        callConversions: callConversionsByKey.get(`${campaignId}|${dateStr}`) ?? null,
        phoneCalls: (() => {
          const v = phoneCallsByKey.get(`${campaignId}|${dateStr}`);
          return v == null ? null : Math.round(v);
        })(),
        // 0 when the query ran and found no call taps; null only if it failed.
        callClicks: callClicksQueried
          ? Math.round(callClicksByKey.get(`${campaignId}|${dateStr}`) ?? 0)
          : null,
      };
      await prisma.googleAdsCampaignSnapshot.upsert({
        where: { hotelClientId_campaignId_date: { hotelClientId: conn.hotelClientId, campaignId, date } },
        create: { hotelClientId: conn.hotelClientId, campaignId, date, ...data },
        update: data,
      });
      campaignDays += 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown DB error during Google Ads upsert.";
    console.error(`${LOG} ${conn.hotelClientId} UPSERT FAILED: ${msg}`);
    await prisma.googleAdsConnection.update({
      where: { id: conn.id },
      data: { status: "ERROR", lastSyncError: msg },
    });
    return { ok: false, error: msg };
  }

  await prisma.googleAdsConnection.update({
    where: { id: conn.id },
    data: {
      lastSyncedAt: new Date(),
      status: "ACTIVE",
      lastSyncError: null,
      requiresReconnect: false,
      lastErrorReason: null,
    },
  });
  console.log(`${LOG} ${conn.hotelClientId}: ${campaignDays} campaign-days upserted`);
  return { ok: true, campaignDays };
}

export type GoogleAdsSyncResult = {
  processed: number;
  synced: number;
  campaignDays: number;
  tokenExpired: number;
  errors: { hotelClientId: string; error: string }[];
};

/** Syncs every ACTIVE Google Ads connection (optionally one agency / one hotel). Never throws. */
export async function runGoogleAdsSync(
  opts: { agencyId?: string; hotelClientId?: string; days?: number; accountDelayMs?: number } = {},
): Promise<GoogleAdsSyncResult> {
  const delay = opts.accountDelayMs ?? 500;
  const conns = await prisma.googleAdsConnection.findMany({
    where: {
      // ERROR is a RETRYABLE state, not a terminal one: it is set by a transient
      // data failure (a Google 5xx, a quota blip, a bad SELECT clause), and a
      // successful sync clears it back to ACTIVE below. Excluding it here would
      // mean a single bad day silently stops this hotel syncing forever, and
      // "Sync now" would report "Pick an account first" for an account that is
      // already picked. TOKEN_EXPIRED / REVOKED stay excluded — those genuinely
      // require the user to reconnect.
      status: { in: ["ACTIVE", "ERROR"] },
      customerId: { not: "" }, // skip connections still awaiting account selection
      hotelClient: { deletedAt: null }, // never sync soft-deleted hotels
      ...(opts.agencyId ? { agencyId: opts.agencyId } : {}),
      ...(opts.hotelClientId ? { hotelClientId: opts.hotelClientId } : {}),
    },
    orderBy: { lastSyncedAt: "asc" },
    select: { id: true, agencyId: true, hotelClientId: true, customerId: true, loginCustomerId: true, tokenExpiresAt: true },
  });

  const result: GoogleAdsSyncResult = { processed: 0, synced: 0, campaignDays: 0, tokenExpired: 0, errors: [] };
  for (let i = 0; i < conns.length; i++) {
    if (i > 0 && delay > 0) await sleep(delay);
    result.processed += 1;
    const res = await syncGoogleAdsConnection(conns[i], opts.days ?? 30);
    if (res.ok) {
      result.synced += 1;
      result.campaignDays += res.campaignDays ?? 0;
    } else {
      if (res.tokenExpired) result.tokenExpired += 1;
      result.errors.push({ hotelClientId: conns[i].hotelClientId, error: res.error ?? "unknown" });
    }
  }
  return result;
}
