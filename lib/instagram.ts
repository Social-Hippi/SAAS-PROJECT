import "server-only";

// Instagram client for the "Instagram API with Instagram Login" (IGAA) flow.
//
// This is the ONLY way HotelTrack connects Instagram. The hotel logs in with
// its own Instagram Business/Creator account via OAuth — no Facebook Page, no
// EAA token, completely separate from the Meta *Ads* integration (lib/meta.ts).
//
//   • OAuth:    api.instagram.com/oauth/*          (code → short-lived token)
//   • Data:     graph.instagram.com/v21.0/*        (IGAA… tokens)
//   • Refresh:  graph.instagram.com/refresh_access_token (rolling 60-day)
//
// SECURITY (see CLAUDE.md): tokens are secrets. Data calls send the token in
// the `Authorization: Bearer` header (never the query string) so it can't land
// in request logs. The OAuth/refresh endpoints REQUIRE query/body credentials
// per Meta's spec — those are server-to-server calls whose URLs are never
// logged. This module is `server-only` and must never reach client code.

const IG_GRAPH = "https://graph.instagram.com";
const IG_OAUTH = "https://api.instagram.com";
const IG_API_VERSION = process.env.INSTAGRAM_API_VERSION ?? "v21.0";

/**
 * The token is invalid, expired, or revoked — the hotel must reconnect via
 * "Log in with Instagram". Callers catch this to set the connection status and
 * surface a reconnect message.
 */
export class InstagramAuthError extends Error {
  constructor(message = "The Instagram connection is invalid or has expired. Please reconnect.") {
    super(message);
    this.name = "InstagramAuthError";
  }
}

/** Any other Instagram API failure (bad request, rate limit, outage, …). */
export class InstagramApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstagramApiError";
  }
}

type GraphError = { error?: { message?: string; type?: string; code?: number } };

function classify(status: number, err: GraphError["error"]): Error {
  // The token is dead ONLY for a 401 Unauthorized or the token-specific Graph
  // codes 190 (invalid/expired) and 102 (session expired). Everything else —
  // permission errors (also OAuthException), invalid metric (#100), rate limits
  // (#4/#17/#613), outages — is a normal API error that must NOT mark the
  // connection expired (same rule as lib/meta.ts).
  if (status === 401 || err?.code === 190 || err?.code === 102) {
    return new InstagramAuthError(err?.message || undefined);
  }
  return new InstagramApiError(err?.message || `Instagram API request failed (HTTP ${status}).`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Graph rate-limit signals: HTTP 429, or app/user/page throttling codes 4/17/613.
function isRateLimited(status: number, code?: number): boolean {
  return status === 429 || code === 4 || code === 17 || code === 613;
}

/**
 * GET on graph.instagram.com with the token in the Authorization header.
 *
 * Retries on rate limiting (HTTP 429 / codes 4/17/613) with exponential backoff
 * (500ms → 1s → 2s, up to `maxRetries`), then surfaces an InstagramApiError so
 * the caller can record the failure. Auth/other errors are NOT retried.
 */
async function igGet<T>(
  path: string,
  accessToken: string,
  params: Record<string, string> = {},
  maxRetries = 3,
): Promise<T> {
  const url = new URL(`${IG_GRAPH}/${IG_API_VERSION}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store", // per-token, per-hotel calls — never cache
    });
    const json = (await res.json().catch(() => ({}))) as GraphError & T;
    if (res.ok && !json?.error) return json;

    if (isRateLimited(res.status, json?.error?.code) && attempt < maxRetries) {
      await sleep(500 * 2 ** attempt); // 500ms, 1s, 2s
      continue;
    }
    throw classify(res.status, json?.error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth — code exchange, long-lived exchange, refresh
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Instagram OAuth callback URL. Explicit env wins; otherwise derived from
 * the canonical public origin, the same way Google Ads / GA4 / Meta do it.
 *
 * The live "Invalid redirect_uri" failure was caused by this value disagreeing
 * with the URI registered on the Meta app: hoteltrack.in 308-redirects to
 * www.hoteltrack.in, so the registered (and therefore configured) URI must be
 * the www form. Deriving it from ONE origin removes the skew permanently.
 */
export function instagramRedirectUri(): string {
  const explicit = process.env.INSTAGRAM_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const origin = (process.env.NEXT_PUBLIC_APP_URL || "https://www.hoteltrack.in").replace(/\/+$/, "");
  return `${origin}/api/auth/instagram/callback`;
}

function oauthEnv() {
  const clientId = process.env.INSTAGRAM_APP_ID;
  const clientSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!clientId || !clientSecret) {
    throw new InstagramApiError(
      "Instagram Login is not configured — set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET.",
    );
  }
  return { clientId, clientSecret, redirectUri: instagramRedirectUri() };
}

/** The authorize URL the browser is redirected to from /api/auth/instagram/start. */
export function buildAuthorizeUrl(state: string): string {
  const { clientId, redirectUri } = oauthEnv();
  const url = new URL(`${IG_OAUTH}/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "instagram_business_basic,instagram_business_manage_insights");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

/** Exchanges the OAuth ?code for a short-lived IGAA token (+ ig user id). */
export async function exchangeCodeForToken(
  code: string,
): Promise<{ accessToken: string; igUserId: string }> {
  const { clientId, clientSecret, redirectUri } = oauthEnv();
  const res = await fetch(`${IG_OAUTH}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    user_id?: number | string;
    error_message?: string;
    error?: { message?: string };
  };
  if (!res.ok || !json.access_token) {
    throw new InstagramApiError(
      json.error_message || json.error?.message || `Instagram code exchange failed (HTTP ${res.status}).`,
    );
  }
  return { accessToken: json.access_token, igUserId: String(json.user_id ?? "") };
}

/** Exchanges a short-lived token for a long-lived (~60-day) one. */
export async function exchangeLongLivedToken(
  shortLivedToken: string,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const { clientSecret } = oauthEnv();
  const url = new URL(`${IG_GRAPH}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", clientSecret);
  url.searchParams.set("access_token", shortLivedToken);

  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json().catch(() => ({}))) as GraphError & {
    access_token?: string;
    expires_in?: number;
  };
  if (!res.ok || !json.access_token) throw classify(res.status, json?.error);
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 60 * 86_400;
  return { accessToken: json.access_token, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}

/**
 * Rolls a long-lived token forward (IGAA's superpower: a token older than 24h
 * and not yet expired can be refreshed for another ~60 days, indefinitely).
 */
export async function refreshLongLivedToken(
  currentToken: string,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const url = new URL(`${IG_GRAPH}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", currentToken);

  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json().catch(() => ({}))) as GraphError & {
    access_token?: string;
    expires_in?: number;
  };
  if (!res.ok || !json.access_token) throw classify(res.status, json?.error);
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 60 * 86_400;
  return { accessToken: json.access_token, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile
// ─────────────────────────────────────────────────────────────────────────────

export type IgProfile = {
  igUserId: string;
  username: string;
  /** "BUSINESS" | "CREATOR" | "PERSONAL" (PERSONAL is rejected at connect). */
  accountType: string;
  profilePictureUrl: string | null;
  followersCount: number;
};

/** Fetches the logged-in account's profile. Used at connect + test-connection. */
export async function getProfile(accessToken: string): Promise<IgProfile> {
  const me = await igGet<{
    user_id?: number | string;
    id?: string;
    username?: string;
    account_type?: string;
    profile_picture_url?: string;
    followers_count?: number;
  }>("me", accessToken, {
    fields: "user_id,username,account_type,profile_picture_url,followers_count",
  });
  return {
    igUserId: String(me.user_id ?? me.id ?? ""),
    username: me.username ?? "(unknown)",
    accountType: (me.account_type ?? "UNKNOWN").toUpperCase(),
    profilePictureUrl: me.profile_picture_url ?? null,
    followersCount: me.followers_count ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Account insights (daily)
// ─────────────────────────────────────────────────────────────────────────────

export type DailyAccountInsight = {
  /** "YYYY-MM-DD" */
  date: string;
  reach: number;
  impressions: number;
  /** "views" — v22+ successor to impressions (content plays/displays that day). */
  views: number;
  profileViews: number;
  /** Daily website_clicks (link-in-bio taps). Dropped if a version rejects it. */
  websiteClicks: number;
  /** Daily follower_count metric when Meta returns it (new follows that day). */
  followerCount: number;
};

type InsightRow = {
  name?: string;
  period?: string;
  values?: { value?: number; end_time?: string }[];
  /** total_value-shaped metrics (e.g. "views") return a single aggregate here. */
  total_value?: { value?: number };
};

const DAY_MS_IG = 86_400_000;
const ymdUtc = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Per-day account "views" (the impressions successor). Unlike reach/profile_views,
 * `views` is only returned as a `metric_type=total_value` aggregate — `period=day`
 * alone yields nothing — so we fetch one total per single-day window and key it by
 * date. Auth errors propagate; any other per-day error leaves that day at 0.
 */
async function getDailyViews(
  accessToken: string,
  igUserId: string,
  range: { since: Date; until: Date },
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const startMs = Date.parse(`${ymdUtc(range.since)}T00:00:00.000Z`);
  const endMs = range.until.getTime();
  for (let t = startMs; t <= endMs; t += DAY_MS_IG) {
    const dayStart = new Date(t);
    const dayEnd = new Date(t + DAY_MS_IG);
    try {
      const res = await igGet<{ data?: InsightRow[] }>(`${igUserId}/insights`, accessToken, {
        metric: "views",
        period: "day",
        metric_type: "total_value",
        since: String(Math.floor(dayStart.getTime() / 1000)),
        until: String(Math.floor(dayEnd.getTime() / 1000)),
      });
      const value = res.data?.[0]?.total_value?.value ?? 0;
      if (value) out.set(ymdUtc(dayStart), value);
    } catch (err) {
      if (err instanceof InstagramAuthError) throw err;
      // non-auth (metric churn / quirk) — leave this day at 0
    }
  }
  return out;
}

// Newer Graph versions retire individual metrics (impressions is deprecated on
// v22+). Rather than failing the whole sync, retry without the metric Meta
// rejected so the remaining ones still land.
async function insightsWithFallback(
  accessToken: string,
  igUserId: string,
  metrics: string[],
  params: Record<string, string>,
): Promise<InsightRow[]> {
  let current = [...metrics];
  for (let attempt = 0; attempt < metrics.length; attempt++) {
    try {
      const res = await igGet<{ data?: InsightRow[] }>(`${igUserId}/insights`, accessToken, {
        ...params,
        metric: current.join(","),
      });
      return res.data ?? [];
    } catch (err) {
      if (err instanceof InstagramAuthError) throw err;
      const message = err instanceof Error ? err.message : "";
      if (current.length <= 1 || !message.includes("metric")) throw err;
      // "(#100) metric[N] must be one of the following values: <valid list>" —
      // the message lists the VALID metric names, so the REJECTED metric is the
      // one we sent that is NOT mentioned (e.g. a deprecated "impressions").
      // Drop that one and retry. (Falls back to the first metric if every one we
      // sent happens to appear in the message text.)
      const rejected = current.find((m) => !message.includes(m)) ?? current[0];
      current = current.filter((m) => m !== rejected);
    }
  }
  return [];
}

/**
 * Daily account metrics for a date window via
 * `{igUserId}/insights?period=day&since&until` on graph.instagram.com.
 */
export async function getDailyAccountInsights(
  accessToken: string,
  igUserId: string,
  range: { since: Date; until: Date },
): Promise<DailyAccountInsight[]> {
  const rows = await insightsWithFallback(
    accessToken,
    igUserId,
    // Valid current account/day metrics. "impressions" was retired on v22+
    // (replaced by "views") and is no longer accepted here. "website_clicks" is
    // requested too; insightsWithFallback drops it gracefully if a version no
    // longer accepts it, so the rest still land.
    ["reach", "profile_views", "follower_count", "website_clicks"],
    {
      period: "day",
      since: String(Math.floor(range.since.getTime() / 1000)),
      until: String(Math.floor(range.until.getTime() / 1000)),
    },
  );

  // Pivot metric-major rows into one record per day.
  const byDate = new Map<string, DailyAccountInsight>();
  const ensure = (date: string): DailyAccountInsight => {
    let d = byDate.get(date);
    if (!d) {
      d = { date, reach: 0, impressions: 0, views: 0, profileViews: 0, websiteClicks: 0, followerCount: 0 };
      byDate.set(date, d);
    }
    return d;
  };

  for (const row of rows) {
    for (const v of row.values ?? []) {
      if (!v.end_time) continue;
      const date = v.end_time.slice(0, 10);
      const value = typeof v.value === "number" ? v.value : 0;
      switch (row.name) {
        case "reach":
          ensure(date).reach = value;
          break;
        case "impressions":
          ensure(date).impressions = value;
          break;
        case "profile_views":
          ensure(date).profileViews = value;
          break;
        case "website_clicks":
          ensure(date).websiteClicks = value;
          break;
        case "follower_count":
          ensure(date).followerCount = value;
          break;
      }
    }
  }

  // "views" comes from a separate per-day total_value fetch (see getDailyViews).
  const views = await getDailyViews(accessToken, igUserId, range);
  for (const [date, value] of views) ensure(date).views = value;

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ─────────────────────────────────────────────────────────────────────────────
// Media + per-post insights
// ─────────────────────────────────────────────────────────────────────────────

export type IgMedia = {
  mediaId: string;
  caption: string | null;
  /** Normalised: "image" | "video" | "carousel" | "reels". */
  mediaType: string | null;
  mediaUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
  likes: number;
  comments: number;
};

function normaliseMediaType(raw?: string): string | null {
  switch ((raw ?? "").toUpperCase()) {
    case "IMAGE":
      return "image";
    case "VIDEO":
      return "video";
    case "CAROUSEL_ALBUM":
      return "carousel";
    case "REELS":
      return "reels";
    default:
      return raw ? raw.toLowerCase() : null;
  }
}

/** The account's recent media (no insights — those are fetched per media id). */
export async function getRecentMedia(
  accessToken: string,
  igUserId: string,
  limit = 25,
): Promise<IgMedia[]> {
  const res = await igGet<{
    data?: {
      id: string;
      caption?: string;
      media_type?: string;
      media_url?: string;
      permalink?: string;
      timestamp?: string;
      like_count?: number;
      comments_count?: number;
    }[];
  }>(`${igUserId}/media`, accessToken, {
    fields: "id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count",
    limit: String(limit),
  });

  return (res.data ?? []).map((m) => ({
    mediaId: m.id,
    caption: m.caption ?? null,
    mediaType: normaliseMediaType(m.media_type),
    mediaUrl: m.media_url ?? null,
    permalink: m.permalink ?? null,
    timestamp: m.timestamp ?? null,
    likes: m.like_count ?? 0,
    comments: m.comments_count ?? 0,
  }));
}

export type MediaInsights = {
  reach: number;
  impressions: number;
  saved: number;
  engagement: number;
  shares: number;
  /** Reel plays (total play count). 0 for non-reels or when unavailable. */
  plays: number;
};

/**
 * Per-post insights. Tolerant of per-version metric churn: falls back through
 * `engagement` → `total_interactions` and drops `impressions` when rejected. A
 * metric quirk on one post must never kill the sync, so unknown-metric
 * failures resolve to zeros (auth errors still propagate).
 */
export async function getMediaInsights(
  accessToken: string,
  mediaId: string,
): Promise<MediaInsights> {
  const out: MediaInsights = { reach: 0, impressions: 0, saved: 0, engagement: 0, shares: 0, plays: 0 };
  // Valid current post metrics. "views" replaced "impressions" and
  // "total_interactions" replaced "engagement" on v22+; "saved" is still the
  // media-level save metric. "shares" and "plays" (reels) are requested too and
  // degrade out of the set if a version rejects them. Parsing accepts both old
  // and new names, and reads total_value-shaped metrics as well as period values.
  const metricSets = [
    ["reach", "views", "saved", "total_interactions", "shares", "plays"],
    ["reach", "views", "saved", "total_interactions", "shares"],
    ["reach", "views", "saved", "total_interactions"],
    ["reach", "views", "saved"],
    ["reach", "saved"],
    ["reach"],
  ];

  for (const metrics of metricSets) {
    try {
      const res = await igGet<{ data?: InsightRow[] }>(`${mediaId}/insights`, accessToken, {
        metric: metrics.join(","),
      });
      for (const row of res.data ?? []) {
        const value = row.values?.[0]?.value ?? row.total_value?.value ?? 0;
        switch (row.name) {
          case "reach":
            out.reach = value;
            break;
          case "views":
          case "impressions":
            // "views" is the modern impressions-equivalent for a post.
            out.impressions = value;
            break;
          case "saved":
          case "saves":
            out.saved = value;
            break;
          case "engagement":
          case "total_interactions":
            out.engagement = value;
            break;
          case "shares":
            out.shares = value;
            break;
          case "plays":
          case "ig_reels_aggregated_all_plays_count":
            out.plays = value;
            break;
        }
      }
      return out;
    } catch (err) {
      if (err instanceof InstagramAuthError) throw err;
      const message = err instanceof Error ? err.message : "";
      if (!message.includes("metric")) return out; // per-post quirk — keep zeros
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Follower demographics
// ─────────────────────────────────────────────────────────────────────────────

export type AudienceRow = {
  breakdown: "country" | "age" | "gender";
  /** e.g. "IN", "25-34", "F". */
  dimension: string;
  value: number;
};

type DemographicResponse = {
  data?: {
    name?: string;
    total_value?: {
      breakdowns?: {
        dimension_keys?: string[];
        results?: { dimension_values?: string[]; value?: number }[];
      }[];
    };
  }[];
};

/**
 * Follower demographics via the Graph `follower_demographics` insight
 * (metric_type=total_value, period=lifetime), one call per breakdown
 * (country / age / gender). BEST-EFFORT: the API only returns these for accounts
 * with 100+ followers and the exact shape varies by version, so any non-auth
 * failure for a breakdown is skipped (returns what did succeed). Auth errors
 * propagate so the sync can flag an expired token. Never throws on data quirks.
 */
export async function getFollowerDemographics(
  accessToken: string,
  igUserId: string,
): Promise<AudienceRow[]> {
  const breakdowns: AudienceRow["breakdown"][] = ["country", "age", "gender"];
  const out: AudienceRow[] = [];
  for (const breakdown of breakdowns) {
    try {
      const res = await igGet<DemographicResponse>(`${igUserId}/insights`, accessToken, {
        metric: "follower_demographics",
        period: "lifetime",
        metric_type: "total_value",
        timeframe: "this_month",
        breakdown,
      });
      const results = res.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? [];
      for (const r of results) {
        const dim = r.dimension_values?.[0];
        const val = typeof r.value === "number" ? r.value : 0;
        if (dim && val > 0) out.push({ breakdown, dimension: dim, value: val });
      }
    } catch (err) {
      if (err instanceof InstagramAuthError) throw err;
      // <100 followers / metric churn / version quirk — skip this breakdown.
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tagged media — the `/{ig-user-id}/tags` edge: media in which the connected
// hotel account was @-tagged (i.e. posts by OTHER users that tagged the hotel).
// This is the basis for Instagram Reach Split influencer detection.
//
// API REALITY: for other users' media the Graph API exposes the post's basic
// fields (caption/permalink/timestamp/like_count/comments_count) and usually the
// poster `username`, but NOT insights (reach/impressions) — those are only
// available for media the connected account owns. So tagged-media reach is left
// unknown (null) by callers and rendered "Not available".
// ─────────────────────────────────────────────────────────────────────────────

export type IgTaggedMedia = {
  mediaId: string;
  caption: string | null;
  mediaType: string | null; // normalised: image | video | carousel | reels
  permalink: string | null;
  timestamp: string | null;
  likes: number;
  comments: number;
  /** Poster's username when the API exposes it (no leading @). */
  posterUsername: string | null;
  /** Poster's IG user id when the API exposes it (the `owner` field). */
  posterUserId: string | null;
};

type TagsNode = {
  id: string;
  caption?: string;
  media_type?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
  username?: string;
  owner?: { id?: string };
};

/**
 * Media that @-tagged the connected hotel account. Tries to include the poster's
 * `owner{id}` (used to match a known influencer by instagramUserId); if a Graph
 * version rejects the `owner` field we retry without it and fall back to matching
 * by `username`. Auth errors propagate; the caller records other failures.
 */
export async function getTaggedMedia(
  accessToken: string,
  igUserId: string,
  limit = 50,
): Promise<IgTaggedMedia[]> {
  const baseFields = "id,caption,media_type,permalink,timestamp,like_count,comments_count,username";
  let data: TagsNode[];
  try {
    const res = await igGet<{ data?: TagsNode[] }>(`${igUserId}/tags`, accessToken, {
      fields: `${baseFields},owner{id}`,
      limit: String(limit),
    });
    data = res.data ?? [];
  } catch (err) {
    if (err instanceof InstagramAuthError) throw err;
    // `owner` may be disallowed on some versions/permissions — retry without it.
    const res = await igGet<{ data?: TagsNode[] }>(`${igUserId}/tags`, accessToken, {
      fields: baseFields,
      limit: String(limit),
    });
    data = res.data ?? [];
  }

  return data.map((m) => ({
    mediaId: m.id,
    caption: m.caption ?? null,
    mediaType: normaliseMediaType(m.media_type),
    permalink: m.permalink ?? null,
    timestamp: m.timestamp ?? null,
    likes: m.like_count ?? 0,
    comments: m.comments_count ?? 0,
    posterUsername: m.username ? m.username.replace(/^@/, "") : null,
    posterUserId: m.owner?.id ?? null,
  }));
}

/**
 * Resolve a public Business/Creator @handle to its IG user id via the
 * `business_discovery` lookup (run against the connected account's token). Used
 * when an agency adds an influencer's Instagram handle (PART 7). Returns null if
 * the handle can't be resolved (private/personal account, typo, not found, or a
 * version quirk) — the caller surfaces a "couldn't verify" warning, never throws.
 */
export async function resolveBusinessAccountByUsername(
  accessToken: string,
  connectedIgUserId: string,
  username: string,
): Promise<{ id: string; username: string } | null> {
  const handle = username.trim().replace(/^@/, "");
  if (!handle) return null;
  try {
    const res = await igGet<{
      business_discovery?: { id?: string; username?: string };
    }>(connectedIgUserId, accessToken, {
      fields: `business_discovery.username(${handle}){id,username}`,
    });
    const id = res.business_discovery?.id;
    if (!id) return null;
    return { id, username: res.business_discovery?.username ?? handle };
  } catch (err) {
    if (err instanceof InstagramAuthError) throw err;
    return null; // not found / not a business account / version quirk
  }
}
