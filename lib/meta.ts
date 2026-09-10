import "server-only";

// Meta (Facebook) Graph API client for the Ads ROI integration.
//
// SECURITY (see CLAUDE.md): the decrypted access token is a secret. It is passed
// in the `Authorization: Bearer` header (never the query string) so it can't end
// up in request logs, and this module is `server-only` so it can never be
// bundled into client code. Callers must NEVER log the token or pass it to the
// frontend.

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION ?? "v19.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * The token is invalid, expired, or revoked — the agency must reconnect by
 * pasting a fresh token. Callers catch this to set the connection
 * `disconnected` and surface a reconnect message.
 */
export class MetaAuthError extends Error {
  constructor(message = "Your Meta access token is invalid or has expired. Please reconnect.") {
    super(message);
    this.name = "MetaAuthError";
  }
}

/** Any other Graph API failure (bad request, rate limit, Meta outage, …). */
export class MetaApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaApiError";
  }
}

type GraphParams = Record<string, string>;

/**
 * GET against the Graph API with the token in the Authorization header. Throws
 * {@link MetaAuthError} for OAuth/expiry failures (Graph error code 190 or
 * type `OAuthException`) and {@link MetaApiError} for everything else.
 */
async function graphGet<T>(
  path: string,
  accessToken: string,
  params: GraphParams = {},
): Promise<T> {
  const url = new URL(`${GRAPH_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    // These are per-token, per-agency calls — never serve them from Next's cache.
    cache: "no-store",
  });

  const json = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; type?: string; code?: number };
  } & T;

  if (!res.ok || json?.error) {
    const err = json?.error ?? {};
    // Only treat the token itself as dead for code 190 (invalid/expired token)
    // or 102 (session expired). Meta also reports PERMISSION errors (e.g. #200
    // "ad account owner has not granted ads_read") with type "OAuthException" —
    // those mean "no access to this asset", not "token expired", and must NOT
    // flip the agency's valid token to expired.
    if (err.code === 190 || err.code === 102) {
      throw new MetaAuthError(err.message || undefined);
    }
    throw new MetaApiError(
      err.message || `Meta API request failed (HTTP ${res.status}).`,
    );
  }

  return json;
}

// ─────────────────────────────────────────────────────────────────────────────
// validateToken
// ─────────────────────────────────────────────────────────────────────────────

export type TokenValidation = {
  valid: boolean;
  /** When the token expires, or null if it never expires / expiry is unknown. */
  expiresAt: Date | null;
  scopes?: string[];
  userId?: string;
  userName?: string;
  /** Set when valid is false — a human-readable reason. */
  error?: string;
};

/**
 * Confirms a token works by calling `/me`, then reads its real expiry from
 * `/debug_token` (a token can inspect itself). If `/me` succeeds the token is
 * valid even when debug_token is unavailable — expiry just stays null.
 */
export async function validateToken(accessToken: string): Promise<TokenValidation> {
  try {
    const me = await graphGet<{ id: string; name?: string }>("me", accessToken, {
      fields: "id,name",
    });

    let expiresAt: Date | null = null;
    let scopes: string[] | undefined;
    try {
      const debug = await graphGet<{
        data?: { expires_at?: number; is_valid?: boolean; scopes?: string[] };
      }>("debug_token", accessToken, { input_token: accessToken });

      const expiresUnix = debug.data?.expires_at;
      // expires_at === 0 means a non-expiring token (e.g. a system-user token).
      if (typeof expiresUnix === "number" && expiresUnix > 0) {
        expiresAt = new Date(expiresUnix * 1000);
      }
      scopes = debug.data?.scopes;
    } catch {
      // Best-effort: /me already proved validity; leave expiry unknown.
    }

    return { valid: true, expiresAt, scopes, userId: me.id, userName: me.name };
  } catch (err) {
    if (err instanceof MetaAuthError) {
      return { valid: false, expiresAt: null, error: err.message };
    }
    return {
      valid: false,
      expiresAt: null,
      error:
        err instanceof Error
          ? err.message
          : "Could not reach Meta to validate the token.",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getAdAccounts
// ─────────────────────────────────────────────────────────────────────────────

export type AdAccount = {
  /** Graph object id, e.g. "act_1234567890". Use this when calling insights. */
  id: string;
  /** Numeric id without the act_ prefix, e.g. "1234567890". */
  accountId: string;
  name: string;
  /** Meta account_status: 1 = active, 2 = disabled, 3 = unsettled, … */
  accountStatus: number;
  currency?: string;
  timezone?: string;
};

type RawAdAccount = {
  id: string;
  account_id: string;
  name?: string;
  account_status?: number;
  currency?: string;
  timezone_name?: string;
};

/** Lists every ad account the token can access, following pagination. */
export async function getAdAccounts(accessToken: string): Promise<AdAccount[]> {
  const accounts: AdAccount[] = [];
  let params: GraphParams = {
    fields: "id,account_id,name,account_status,currency,timezone_name",
    limit: "100",
  };

  // Cap the page walk so a misbehaving cursor can never loop forever.
  for (let page = 0; page < 20; page++) {
    const res = await graphGet<{
      data?: RawAdAccount[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>("me/adaccounts", accessToken, params);

    for (const a of res.data ?? []) {
      accounts.push({
        id: a.id,
        accountId: a.account_id,
        name: a.name ?? a.id,
        accountStatus: a.account_status ?? 0,
        currency: a.currency,
        timezone: a.timezone_name,
      });
    }

    const after = res.paging?.cursors?.after;
    if (!after || !res.paging?.next) break;
    params = { ...params, after };
  }

  return accounts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ad-account funding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What Meta will and will not tell us about money left to spend.
 *
 * `balance` is NOT available funds — it is the amount DUE on the account, which
 * for a credit-line account grows as you spend. There is no field anywhere in
 * the Marketing API that reports "prepaid rupees remaining"; Meta simply does
 * not publish it to apps.
 *
 * The one genuinely usable figure is a SPEND CAP: when an account has one,
 * `spend_cap - amount_spent` is real headroom, and running out of it stops the
 * ads exactly like running out of money. So `availableMinor` is derived only in
 * that case and is null otherwise — which the UI renders as "Balance
 * unavailable" rather than as zero.
 *
 * All amounts are minor units (paise for an INR account) as Meta returns them.
 */
export type AdAccountFunding = {
  accountId: string;
  currency: string | null;
  /** spend_cap − amount_spent, when a cap exists. Null when it does not. */
  availableMinor: number | null;
  amountDueMinor: number | null;
  amountSpentMinor: number | null;
  spendCapMinor: number | null;
  /** funding_source_details.type, verbatim, for display. */
  fundingType: string | null;
};

type RawFunding = {
  id?: string;
  account_id?: string;
  currency?: string;
  balance?: string;
  amount_spent?: string;
  spend_cap?: string;
  funding_source_details?: { type?: number | string; display_string?: string };
};

/** Minor-unit string → integer, or null when absent/unparseable. */
function minorOrNull(v: string | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Read one ad account's funding state.
 *
 * Never throws on a missing field: Meta omits `spend_cap` entirely for accounts
 * without one, and omits `funding_source_details` unless the token has the
 * permission to see it. Each absence becomes a null, not a zero.
 */
export async function getAdAccountFunding(
  accessToken: string,
  adAccountId: string,
): Promise<AdAccountFunding> {
  const act = normalizeAccountId(adAccountId);
  const res = await graphGet<RawFunding>(act, accessToken, {
    fields: "account_id,currency,balance,amount_spent,spend_cap,funding_source_details",
  });

  const spendCapMinor = minorOrNull(res.spend_cap);
  const amountSpentMinor = minorOrNull(res.amount_spent);

  // A cap of 0 means "no cap set" in Meta's encoding, not "nothing left".
  const hasCap = spendCapMinor != null && spendCapMinor > 0;
  const availableMinor =
    hasCap && amountSpentMinor != null
      ? Math.max(0, spendCapMinor - amountSpentMinor)
      : null;

  const rawType = res.funding_source_details?.display_string
    ?? (res.funding_source_details?.type != null ? String(res.funding_source_details.type) : null);

  return {
    accountId: res.account_id ?? act.replace(/^act_/, ""),
    currency: res.currency ?? null,
    availableMinor,
    amountDueMinor: minorOrNull(res.balance),
    amountSpentMinor,
    spendCapMinor,
    fundingType: rawType,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getInsights
// ─────────────────────────────────────────────────────────────────────────────

export type DateRange = {
  /** Inclusive start, "YYYY-MM-DD". */
  since: string;
  /** Inclusive end, "YYYY-MM-DD". */
  until: string;
};

export type ActionStat = { actionType: string; value: number };

export type AdInsights = {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  /** Conversion counts by action_type (e.g. purchases, leads, page views). */
  actions: ActionStat[];
  /** Monetary value per action_type (e.g. purchase revenue). */
  actionValues: ActionStat[];
};

type RawAction = { action_type: string; value: string };
type RawInsights = {
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  actions?: RawAction[];
  action_values?: RawAction[];
};

/**
 * Account-level insights for a date range: spend, impressions, reach, clicks,
 * ctr, cpc, cpm, plus actions/action_values. Returns one row (account level).
 */
export async function getInsights(
  accessToken: string,
  adAccountId: string,
  range: DateRange,
): Promise<AdInsights[]> {
  const act = normalizeAccountId(adAccountId);
  const res = await graphGet<{ data?: RawInsights[] }>(`${act}/insights`, accessToken, {
    fields: "spend,impressions,reach,clicks,ctr,cpc,cpm,actions,action_values",
    time_range: JSON.stringify({ since: range.since, until: range.until }),
    level: "account",
  });

  return (res.data ?? []).map((row) => ({
    spend: toNumber(row.spend),
    impressions: toNumber(row.impressions),
    reach: toNumber(row.reach),
    clicks: toNumber(row.clicks),
    ctr: toNumber(row.ctr),
    cpc: toNumber(row.cpc),
    cpm: toNumber(row.cpm),
    actions: mapActions(row.actions),
    actionValues: mapActions(row.action_values),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// getDailyInsights — one row per day, shaped for an AdSnapshot
// ─────────────────────────────────────────────────────────────────────────────

/** A single day's metrics for an ad account, mapped to AdSnapshot columns. */
export type DailyAdRow = {
  /** "YYYY-MM-DD" (Meta's date_start for the day). */
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  /** Booking conversions = pixel purchases. */
  conversions: number;
  /** Purchase value / spend for the day. */
  roas: number;
  pixelPurchases: number;
  pixelLeads: number;
  pixelPageViews: number;
};

type RawDailyInsights = RawInsights & {
  date_start?: string;
  date_stop?: string;
};

/**
 * Daily account insights (`time_increment=1`) over a date range — one row per
 * day with the fields an AdSnapshot needs. Used by the scheduled sync to write
 * idempotent per-day rows. Pixel conversions are derived from `actions` the
 * same way {@link getPixelEvents} does.
 */
export async function getDailyInsights(
  accessToken: string,
  adAccountId: string,
  range: DateRange,
): Promise<DailyAdRow[]> {
  const act = normalizeAccountId(adAccountId);
  const raw: RawDailyInsights[] = [];
  let params: GraphParams = {
    fields: "spend,impressions,reach,clicks,ctr,cpc,cpm,actions,action_values",
    time_range: JSON.stringify({ since: range.since, until: range.until }),
    time_increment: "1",
    level: "account",
    // One row per day. Without an explicit limit Meta pages insights at ~25
    // rows, which silently truncated ranges longer than ~a month before
    // pagination was added here.
    limit: "500",
  };

  // Follow pagination like getAdAccounts does, with the same runaway-cursor cap.
  // 20 pages × 500 rows is far beyond any range the app requests.
  for (let page = 0; page < 20; page++) {
    const res = await graphGet<{
      data?: RawDailyInsights[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>(`${act}/insights`, accessToken, params);

    raw.push(...(res.data ?? []));

    const after = res.paging?.cursors?.after;
    if (!after || !res.paging?.next) break;
    params = { ...params, after };
  }

  return raw.map((row) => {
    const actions = mapActions(row.actions);
    const values = mapActions(row.action_values);
    const spend = toNumber(row.spend);
    const purchases = Math.round(pickFirst(actions, PIXEL_MATCHERS.purchase));
    const purchaseValue = pickFirst(values, PIXEL_MATCHERS.purchase);
    return {
      date: row.date_start ?? "",
      spend,
      impressions: Math.round(toNumber(row.impressions)),
      reach: Math.round(toNumber(row.reach)),
      clicks: Math.round(toNumber(row.clicks)),
      ctr: toNumber(row.ctr),
      cpc: toNumber(row.cpc),
      cpm: toNumber(row.cpm),
      conversions: purchases,
      roas: spend > 0 ? purchaseValue / spend : 0,
      pixelPurchases: purchases,
      pixelLeads: Math.round(pickFirst(actions, PIXEL_MATCHERS.lead)),
      pixelPageViews: Math.round(pickFirst(actions, PIXEL_MATCHERS.pageView)),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// getDailyCampaignInsights — one row per CAMPAIGN per day
// ─────────────────────────────────────────────────────────────────────────────

/** A single campaign-day's metrics, mapped to AdCampaignSnapshot columns. */
export type DailyCampaignRow = {
  /** "YYYY-MM-DD" (Meta's date_start for the day). */
  date: string;
  campaignId: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
  /** Meta-reported pixel purchases (same matcher set as getDailyInsights). */
  conversions: number;
  /** Meta-reported purchase value. */
  purchaseValue: number;
  /**
   * Meta's campaign objective, verbatim (OUTCOME_SALES, OUTCOME_LEADS, …).
   * Null when the API omits it — normalisation happens at read time, never here,
   * so an unrecognised objective is stored faithfully rather than bucketed.
   */
  objective: string | null;
  /** People reached, as distinct from impressions. */
  reach: number;
  /** Messaging conversations started — the "messages generated" figure. */
  messagingStarted: number;
  /** Lead-form and pixel leads. Never added to messagingStarted. */
  leads: number;
  /** Meta delivery rankings, or null while Meta still has too little data. */
  qualityRanking: string | null;
  engagementRateRanking: string | null;
  conversionRateRanking: string | null;
};

type RawCampaignInsights = RawDailyInsights & {
  campaign_id?: string;
  campaign_name?: string;
  objective?: string;
  quality_ranking?: string;
  engagement_rate_ranking?: string;
  conversion_rate_ranking?: string;
};

/** Meta withholds a ranking until an ad has enough impressions, and says so. */
function ranking(v: string | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  // "UNKNOWN" is Meta's "not enough data yet" — storing it as a value would put
  // a rank-shaped word in a column that is meant to hold a rank.
  return t === "" || t.toUpperCase() === "UNKNOWN" ? null : t;
}

/**
 * Daily insights at `level=campaign` — the campaign_name dimension is what
 * utm_campaign↔booking attribution joins on (lib/campaign-attribution.ts).
 * Same pagination + pixel-action mapping as {@link getDailyInsights}.
 */
export async function getDailyCampaignInsights(
  accessToken: string,
  adAccountId: string,
  range: DateRange,
): Promise<DailyCampaignRow[]> {
  const act = normalizeAccountId(adAccountId);
  const raw: RawCampaignInsights[] = [];
  let params: GraphParams = {
    // `objective` is a campaign-level insights field; it is simply absent from
    // the response for campaigns Meta does not report one for, which the
    // nullable column and read-time normalisation both handle.
    // reach is a campaign-level field; the three *_ranking fields are Meta's
    // delivery diagnostics. `actions` was already being fetched — the messaging
    // and lead counts below were sitting in it unread.
    fields:
      "campaign_id,campaign_name,objective,spend,impressions,reach,clicks,actions,action_values," +
      "quality_ranking,engagement_rate_ranking,conversion_rate_ranking",
    time_range: JSON.stringify({ since: range.since, until: range.until }),
    time_increment: "1",
    level: "campaign",
    limit: "500",
  };

  // campaigns × days can exceed one page fast — follow pagination with the
  // same runaway-cursor cap as getDailyInsights.
  for (let page = 0; page < 20; page++) {
    const res = await graphGet<{
      data?: RawCampaignInsights[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>(`${act}/insights`, accessToken, params);

    raw.push(...(res.data ?? []));

    const after = res.paging?.cursors?.after;
    if (!after || !res.paging?.next) break;
    params = { ...params, after };
  }

  return raw
    .filter((row) => row.campaign_id && row.date_start)
    .map((row) => {
      const actions = mapActions(row.actions);
      const values = mapActions(row.action_values);
      return {
        date: row.date_start!,
        campaignId: row.campaign_id!,
        campaignName: row.campaign_name ?? row.campaign_id!,
        objective: row.objective ?? null,
        spend: toNumber(row.spend),
        impressions: Math.round(toNumber(row.impressions)),
        clicks: Math.round(toNumber(row.clicks)),
        conversions: Math.round(pickFirst(actions, PIXEL_MATCHERS.purchase)),
        purchaseValue: pickFirst(values, PIXEL_MATCHERS.purchase),
        reach: Math.round(toNumber(row.reach)),
        messagingStarted: Math.round(pickFirst(actions, MESSAGING_MATCHERS)),
        leads: Math.round(pickFirst(actions, LEAD_MATCHERS)),
        qualityRanking: ranking(row.quality_ranking),
        engagementRateRanking: ranking(row.engagement_rate_ranking),
        conversionRateRanking: ranking(row.conversion_rate_ranking),
      };
    });
}

/**
 * Campaign objectives, from the CAMPAIGNS endpoint rather than from insights.
 *
 * Insights is asked for `objective` and returns it as null for these accounts —
 * verified against production, where every row including today's has a null
 * objective while the campaigns themselves plainly have one. The objective is a
 * property of the campaign, not of a day's delivery, so this is where it lives.
 *
 * Best-effort: a failure here leaves objectives unknown, which reads as "Not
 * available" — it must never cost the day's spend and delivery figures.
 */
export async function getCampaignObjectives(
  accessToken: string,
  adAccountId: string,
): Promise<Map<string, string>> {
  const act = normalizeAccountId(adAccountId);
  const out = new Map<string, string>();
  let params: GraphParams = { fields: "id,objective", limit: "500" };

  for (let page = 0; page < 20; page++) {
    const res = await graphGet<{
      data?: { id?: string; objective?: string }[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>(`${act}/campaigns`, accessToken, params);

    for (const c of res.data ?? []) {
      if (c.id && c.objective) out.set(c.id, c.objective);
    }

    const after = res.paging?.cursors?.after;
    if (!after || !res.paging?.next) break;
    params = { ...params, after };
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// getPixelEvents
// ─────────────────────────────────────────────────────────────────────────────

export type PixelEventStat = { count: number; value: number };
export type PixelEvents = {
  purchase: PixelEventStat;
  lead: PixelEventStat;
  pageView: PixelEventStat;
};

// Meta reports the same conversion under several action_type aliases. We take
// the FIRST match in priority order (pixel-specific first) to avoid double
// counting the generic + offsite variants of one event.
/**
 * Action types for a messaging conversation and for a lead.
 *
 * KEPT SEPARATE, and never added together. A WhatsApp conversation and a lead
 * form submission are different events; a campaign running both would be
 * double-counted by a single "results" figure, and "cost per result" would then
 * be understated by exactly the overlap.
 *
 * Several spellings per row because Meta returns different action types by
 * placement and by campaign age, and only one of them is ever present.
 */
export const MESSAGING_MATCHERS = [
  "onsite_conversion.messaging_conversation_started_7d",
  "onsite_conversion.total_messaging_connection",
  "messaging_conversation_started_7d",
];

export const LEAD_MATCHERS = [
  "onsite_conversion.lead_grouped",
  "offsite_conversion.fb_pixel_lead",
  "lead",
];

const PIXEL_MATCHERS: Record<keyof PixelEvents, string[]> = {
  purchase: ["offsite_conversion.fb_pixel_purchase", "purchase", "omni_purchase"],
  lead: ["offsite_conversion.fb_pixel_lead", "lead", "onsite_conversion.lead_grouped"],
  pageView: [
    "offsite_conversion.fb_pixel_view_content",
    "view_content",
    "landing_page_view",
    "page_view",
  ],
};

/** Pixel conversion counts + values for purchase, lead, and page_view events. */
export async function getPixelEvents(
  accessToken: string,
  adAccountId: string,
  range: DateRange,
): Promise<PixelEvents> {
  const rows = await getInsights(accessToken, adAccountId, range);

  const totals: PixelEvents = {
    purchase: { count: 0, value: 0 },
    lead: { count: 0, value: 0 },
    pageView: { count: 0, value: 0 },
  };

  for (const row of rows) {
    for (const key of Object.keys(PIXEL_MATCHERS) as (keyof PixelEvents)[]) {
      const matchers = PIXEL_MATCHERS[key];
      totals[key].count += pickFirst(row.actions, matchers);
      totals[key].value += pickFirst(row.actionValues, matchers);
    }
  }

  return totals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalizeAccountId(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
}

function toNumber(value: string | number | undefined): number {
  const n = typeof value === "number" ? value : parseFloat(value ?? "");
  return Number.isFinite(n) ? n : 0;
}

function mapActions(actions?: RawAction[]): ActionStat[] {
  return (actions ?? []).map((a) => ({
    actionType: a.action_type,
    value: toNumber(a.value),
  }));
}

/** Value of the first action whose type appears in `matchers`, else 0. */
function pickFirst(actions: ActionStat[], matchers: string[]): number {
  for (const matcher of matchers) {
    const hit = actions.find((a) => a.actionType === matcher);
    if (hit) return hit.value;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth — Facebook Login for Business
//
// The OAuth path produces the SAME end state as the manual paste: a validated,
// encrypted, agency-scoped token. It only adds the authorize-URL builder and the
// two server-to-server exchanges. Ad-account identity + expiry are read with the
// existing validateToken()/getAdAccounts() so there's one Graph client.
//
// Scopes: ads_read (read ad insights) + business_management (enumerate
// Business-Manager-owned ad accounts, which agency accounts almost always are).
// We deliberately do NOT request pages_show_list — HotelTrack's Meta integration
// is ad-ROI only and never touches Pages — nor any Instagram scope (that lives in
// a separate Meta app). Fewer scopes ⇒ faster App Review.
// ─────────────────────────────────────────────────────────────────────────────

export const META_OAUTH_SCOPES = ["ads_read", "business_management"] as const;

// A non-expiring token reports no expiry; the non-null tokenExpiresAt column
// stores this far-future sentinel for those (mirrors the manual flow).
export const META_NEVER_EXPIRES = new Date("2999-12-31T00:00:00.000Z");

/**
 * The OAuth callback URL, derived the SAME way as Google Ads / GA4
 * (lib/google-ads.ts googleAdsRedirectUri, lib/ga4.ts). Explicit env wins;
 * otherwise it is built from the canonical public origin.
 *
 * WHY THE FALLBACK MATTERS: Meta previously *threw* when
 * META_OAUTH_REDIRECT_URI was unset, while Google Ads silently fell back to
 * the correct origin — which is precisely why Google Ads worked and Meta did
 * not. Deriving from one canonical origin also removes the www/non-www skew:
 * hoteltrack.in 308-redirects to www.hoteltrack.in, so the registered URI (and
 * therefore this value) MUST be the www form. A non-www value produces Meta's
 * "URL Blocked" / Instagram's "Invalid redirect_uri".
 */
export function metaRedirectUri(): string {
  const explicit = process.env.META_OAUTH_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const origin = (process.env.NEXT_PUBLIC_APP_URL || "https://www.hoteltrack.in").replace(/\/+$/, "");
  return `${origin}/api/auth/meta/callback`;
}

function oauthEnv(): { appId: string; appSecret: string; redirectUri: string } {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId) throw new Error("META_APP_ID is not configured.");
  if (!appSecret) throw new Error("META_APP_SECRET is not configured.");
  return { appId, appSecret, redirectUri: metaRedirectUri() };
}

/**
 * Optional Facebook Login for Business configuration id. When set, the login
 * dialog is driven by the Configuration created in the App Dashboard
 * (Login product → Configurations) and `config_id` REPLACES `scope` — that is
 * Meta's documented contract, and mixing the two is explicitly discouraged.
 * When unset we fall back to classic Facebook Login with `scope`, preserving
 * the previous behaviour exactly.
 */
function metaLoginConfigId(): string | null {
  return process.env.META_LOGIN_CONFIG_ID?.trim() || null;
}

/**
 * Builds the Facebook authorize URL for the given signed state. The redirect_uri
 * is the EXACT one registered in the Meta app (no dynamic redirects) — Meta
 * rejects the request on its own screen if it doesn't match a whitelisted URI.
 * Throws if the Meta app env vars are missing.
 *
 * Two modes, decided by META_LOGIN_CONFIG_ID:
 *   set   → Facebook Login for Business (config_id, no scope)
 *   unset → classic Facebook Login (scope)
 * The mode MUST match the product configured on the Meta app, or the dialog
 * fails to load / reports the app as inaccessible.
 */
export function buildMetaAuthorizeUrl(state: string): string {
  const { appId, redirectUri } = oauthEnv();
  const configId = metaLoginConfigId();
  const u = new URL(`https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`);
  u.searchParams.set("client_id", appId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  if (configId) {
    // Facebook Login for Business: permissions come from the Configuration.
    u.searchParams.set("config_id", configId);
  } else {
    u.searchParams.set("scope", META_OAUTH_SCOPES.join(","));
  }
  u.searchParams.set("state", state);
  return u.toString();
}

export type TokenExchange = {
  accessToken: string;
  /** Expiry derived from expires_in, or null when Meta returns a non-expiring token. */
  expiresAt: Date | null;
};

// Both exchanges hit /oauth/access_token with client creds in the query string
// (these are token-MINTING calls, so there's no bearer token yet — that's how
// Meta's OAuth endpoint works). NEVER log the returned access_token.
async function oauthTokenFetch(params: GraphParams): Promise<TokenExchange> {
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: { message?: string; code?: number; type?: string };
  };

  if (!res.ok || json.error || !json.access_token) {
    const err = json.error ?? {};
    if (err.code === 190 || err.code === 102) throw new MetaAuthError(err.message || undefined);
    throw new MetaApiError(err.message || `Meta OAuth token request failed (HTTP ${res.status}).`);
  }

  const expiresAt =
    typeof json.expires_in === "number" && json.expires_in > 0
      ? new Date(Date.now() + json.expires_in * 1000)
      : null;
  return { accessToken: json.access_token, expiresAt };
}

/** Exchanges an authorization code for a short-lived user access token. */
export function exchangeCodeForToken(code: string): Promise<TokenExchange> {
  const { appId, appSecret, redirectUri } = oauthEnv();
  return oauthTokenFetch({
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: redirectUri,
    code,
  });
}

/**
 * Exchanges a short-lived token for a long-lived (~60-day) one. Also used by the
 * refresh cron: passing a still-valid long-lived token returns a fresh 60-day
 * token, which is how Meta "refreshes" user tokens.
 */
export function exchangeForLongLivedToken(currentToken: string): Promise<TokenExchange> {
  const { appId, appSecret } = oauthEnv();
  return oauthTokenFetch({
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: currentToken,
  });
}

/**
 * Best-effort revoke of our app's access for a Facebook user (used on disconnect
 * of an OAuth connection). Never throws — disconnect must always succeed locally.
 */
export async function revokeAppAccess(
  facebookUserId: string,
  accessToken: string,
): Promise<void> {
  try {
    await fetch(new URL(`${GRAPH_BASE}/${facebookUserId}/permissions`), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
  } catch {
    // Revoking is courtesy cleanup at Meta's end; failure is non-fatal.
  }
}

export type ExpiryWarning = "14d" | "7d" | "expired";

/**
 * Decides which manual-token expiry warning (if any) is due now, given days to
 * expiry and the last stage already sent. Pure + monotonic so the daily cron
 * sends each stage at most once. Order of severity: expired > 7d > 14d.
 */
export function nextExpiryWarning(
  daysToExpiry: number,
  currentStage: string | null,
): ExpiryWarning | null {
  const sent = currentStage ?? "";
  if (daysToExpiry <= 0) return sent === "expired" ? null : "expired";
  if (daysToExpiry <= 7) return sent === "7d" || sent === "expired" ? null : "7d";
  if (daysToExpiry <= 14) {
    return sent === "14d" || sent === "7d" || sent === "expired" ? null : "14d";
  }
  return null;
}
