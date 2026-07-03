import "server-only";

import { mask } from "@/lib/ga4";

// Google Ads via Google OAuth (user consent). Low-level client: build the consent
// URL, exchange/refresh tokens, list accessible customer accounts, and run GAQL
// reports (searchStream). All over plain REST so no SDK is needed.
//
// SEPARATE FROM GA4: this API is googleads.googleapis.com, needs the `adwords`
// OAuth scope, AND a platform developer token (GOOGLE_ADS_DEVELOPER_TOKEN) sent
// as the `developer-token` header on every call. It reuses the SAME Google OAuth
// client (GOOGLE_OAUTH_CLIENT_ID/SECRET) as GA4 — that client's consent screen
// must have the adwords scope added. Every path logs under [GADS-*]; tokens are
// masked (length + first 4 chars only) via ga4's shared mask().
//
// re-export mask so callers (routes/sync) don't import from two google modules.
export { mask };

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ADS_HOST = "https://googleads.googleapis.com";

/** Google Ads OAuth scope (all we need; we never edit Ads config). */
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

// ── Error taxonomy (mirrors lib/ga4.ts) ──────────────────────────────────────
/** OAuth/token endpoint failure (exchange or refresh). */
export class GoogleAdsOAuthError extends Error {}
/** Ads API returned 401/403 — token expired or access revoked. */
export class GoogleAdsAuthError extends Error {}
/** Any other Ads API failure (bad request, quota, config, GAQL error). */
export class GoogleAdsApiError extends Error {}

// ── Config ───────────────────────────────────────────────────────────────────
// The OAuth client is SHARED with GA4 (same Google Cloud project + consent
// screen), so we deliberately reuse GOOGLE_OAUTH_CLIENT_ID/SECRET here.
function clientId(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!v) throw new GoogleAdsOAuthError("GOOGLE_OAUTH_CLIENT_ID is not configured.");
  return v;
}
function clientSecret(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!v) throw new GoogleAdsOAuthError("GOOGLE_OAUTH_CLIENT_SECRET is not configured.");
  return v;
}
function developerToken(): string {
  const v = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!v) throw new GoogleAdsApiError("GOOGLE_ADS_DEVELOPER_TOKEN is not configured.");
  return v;
}
/** Manager (MCC) account id for the login-customer-id header, digits only. Optional. */
export function loginCustomerId(): string | null {
  const v = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/\D/g, "");
  return v || null;
}
/** Pinned Ads API version; overridable so a version bump is a config change. */
function apiVersion(): string {
  return process.env.GOOGLE_ADS_API_VERSION || "v18";
}
export function googleAdsRedirectUri(): string {
  return (
    process.env.GOOGLE_ADS_REDIRECT_URI ||
    `${(process.env.NEXT_PUBLIC_APP_URL || "https://www.hoteltrack.in").replace(/\/+$/, "")}/api/auth/google-ads/callback`
  );
}

/** Builds the Google consent URL for the adwords scope. `prompt=consent` +
 *  `access_type=offline` guarantees a refresh token on first authorization. */
export function buildGoogleAdsAuthUrl(state: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", clientId());
  u.searchParams.set("redirect_uri", googleAdsRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_ADS_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

export type GoogleAdsTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope: string;
};

/** Exchanges an authorization code for access + refresh tokens. */
export async function exchangeCodeForTokens(code: string): Promise<GoogleAdsTokens> {
  const body = new URLSearchParams({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: googleAdsRedirectUri(),
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new GoogleAdsOAuthError(
      `token exchange failed (${res.status}): ${String(json.error ?? "")} ${String(json.error_description ?? "")}`.trim(),
    );
  }
  return {
    accessToken: String(json.access_token),
    refreshToken: json.refresh_token ? String(json.refresh_token) : null,
    expiresAt: new Date(Date.now() + Number(json.expires_in ?? 3600) * 1000),
    scope: String(json.scope ?? GOOGLE_ADS_SCOPE),
  };
}

/** Refreshes the access token from a refresh token. */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: Date; scope?: string }> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new GoogleAdsOAuthError(
      `token refresh failed (${res.status}): ${String(json.error ?? "")} ${String(json.error_description ?? "")}`.trim(),
    );
  }
  return {
    accessToken: String(json.access_token),
    expiresAt: new Date(Date.now() + Number(json.expires_in ?? 3600) * 1000),
    scope: json.scope ? String(json.scope) : undefined,
  };
}

// ── Ads API helpers ──────────────────────────────────────────────────────────

function adsHeaders(accessToken: string, login?: string | null): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": developerToken(),
    "Content-Type": "application/json",
  };
  const lc = login ?? loginCustomerId();
  if (lc) h["login-customer-id"] = lc;
  return h;
}

/** Extracts a human-readable message from a Google Ads API error body. */
function adsErrorMessage(body: unknown, status: number): string {
  const b = body as {
    error?: { message?: string; status?: string; details?: unknown };
  } | Array<{ error?: { message?: string } }>;
  const err = Array.isArray(b) ? b[0]?.error : b?.error;
  return err?.message ?? `HTTP ${status}`;
}

export type AdsCustomer = { customerId: string; descriptiveName: string | null; currencyCode: string | null; manager: boolean };

/**
 * Lists the customer accounts the consenting user can directly access. Returns
 * bare 10-digit ids (from resourceNames like "customers/1234567890"). Names and
 * currency come from describeCustomer() — this endpoint returns ids only.
 */
export async function listAccessibleCustomers(accessToken: string): Promise<string[]> {
  const res = await fetch(`${ADS_HOST}/${apiVersion()}/customers:listAccessibleCustomers`, {
    method: "GET",
    headers: adsHeaders(accessToken),
  });
  const json = (await res.json().catch(() => ({}))) as { resourceNames?: string[] };
  if (!res.ok) {
    const msg = adsErrorMessage(json, res.status);
    if (res.status === 401 || res.status === 403) throw new GoogleAdsAuthError(`listAccessibleCustomers unauthorized: ${msg}`);
    throw new GoogleAdsApiError(`listAccessibleCustomers failed (${res.status}): ${msg}`);
  }
  return (json.resourceNames ?? []).map((r) => r.split("/").pop() ?? "").filter(Boolean);
}

export type GaqlRow = Record<string, unknown>;

/**
 * Runs one GAQL query against a customer via googleAds:searchStream. Returns the
 * flattened result rows (each a nested object keyed by the top-level resource,
 * e.g. { campaign: {...}, metrics: {...}, segments: {...} }). Throws
 * GoogleAdsAuthError on 401/403 so the caller can flag a reconnect.
 */
export async function searchStream(
  accessToken: string,
  customerId: string,
  query: string,
  login?: string | null,
): Promise<GaqlRow[]> {
  const cid = customerId.replace(/\D/g, "");
  const res = await fetch(`${ADS_HOST}/${apiVersion()}/customers/${cid}/googleAds:searchStream`, {
    method: "POST",
    headers: adsHeaders(accessToken, login),
    body: JSON.stringify({ query }),
  });
  const json = (await res.json().catch(() => ({}))) as
    | Array<{ results?: GaqlRow[] }>
    | { error?: unknown };
  if (!res.ok) {
    const msg = adsErrorMessage(json, res.status);
    if (res.status === 401 || res.status === 403) throw new GoogleAdsAuthError(`searchStream unauthorized: ${msg}`);
    throw new GoogleAdsApiError(`searchStream failed (${res.status}): ${msg}`);
  }
  // searchStream returns a JSON ARRAY of batches, each with a `results` array.
  const batches = Array.isArray(json) ? json : [];
  return batches.flatMap((b) => b.results ?? []);
}

/**
 * Fetches a customer's descriptive name, currency, and manager flag. Best-effort:
 * accounts reachable only through a manager may require a login-customer-id; on
 * any non-auth error we return the id with null name so the picker still lists it.
 */
export async function describeCustomer(
  accessToken: string,
  customerId: string,
  login?: string | null,
): Promise<AdsCustomer> {
  const cid = customerId.replace(/\D/g, "");
  const fallback: AdsCustomer = { customerId: cid, descriptiveName: null, currencyCode: null, manager: false };
  try {
    const rows = await searchStream(
      accessToken,
      cid,
      "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1",
      login,
    );
    const c = (rows[0]?.customer ?? {}) as { descriptiveName?: string; currencyCode?: string; manager?: boolean };
    return {
      customerId: cid,
      descriptiveName: c.descriptiveName ?? null,
      currencyCode: c.currencyCode ?? null,
      manager: Boolean(c.manager),
    };
  } catch (err) {
    if (err instanceof GoogleAdsAuthError) throw err;
    return fallback;
  }
}

/** Lists accessible customers with names/currency resolved (best-effort per account). */
export async function listCustomersWithDetails(accessToken: string): Promise<AdsCustomer[]> {
  const ids = await listAccessibleCustomers(accessToken);
  const out: AdsCustomer[] = [];
  for (const id of ids) {
    out.push(await describeCustomer(accessToken, id));
  }
  return out;
}
