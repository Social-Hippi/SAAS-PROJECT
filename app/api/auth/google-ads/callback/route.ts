
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { rateLimit, tooManyRequests, clientIpFromHeaders } from "@/lib/ratelimit";
import { verifyOauthState } from "@/lib/signed-state";
import { encryptWithAudit } from "@/lib/token-audit";
import { getTokenForApiCall } from "@/lib/token-access";
import {
  exchangeCodeForTokens,
  listCustomersWithDetails,
  mask,
  type AdsCustomer,
} from "@/lib/google-ads";

// Step 2 of the Google Ads OAuth flow (mirrors /api/auth/ga4/callback). Google
// redirects here with ?code&state. The signed state binds this callback to one
// (agencyId, hotelClientId), 10-minute expiry.
//
// SECURITY: tokens are exchanged server-to-server, AES-256-GCM encrypted, and
// stored — never reaching the browser, never logged. Every step logs under
// "[GADS-OAUTH]"; tokens/codes are masked.
//
// Account selection: 0 accessible customers → error; exactly 1 → auto-select;
// 2+ → save tokens with an empty customerId and send the user back to pick one.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LOG = "[GADS-OAUTH]";

function integrationsUrl(hotelClientId: string, params: Record<string, string>): string {
  return `/agency/hotel/${hotelClientId}/integrations?${new URLSearchParams(params).toString()}`;
}

export async function GET(request: Request) {
  // Per-IP cap to slow brute-forcing of the signed state token. Fails CLOSED.
  const rl = await rateLimit("oauthCallback", clientIpFromHeaders(request.headers));
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const url = new URL(request.url);
  const state = (url.searchParams.get("state") ?? "").trim();
  const code = (url.searchParams.get("code") ?? "").trim();
  const oauthError = url.searchParams.get("error");

  console.log(
    `${LOG} callback hit:`,
    JSON.stringify({
      hasCode: !!code,
      code: mask(code),
      hasState: !!state,
      oauthError: oauthError ?? null,
      GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID ? "(set)" : "(unset)",
      GOOGLE_ADS_REDIRECT_URI: process.env.GOOGLE_ADS_REDIRECT_URI ?? "(unset)",
      GOOGLE_ADS_DEVELOPER_TOKEN_present: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    }),
  );

  const payload = state ? verifyOauthState(state) : null;
  if (!payload) {
    console.error(`${LOG} STATE INVALID — verifyOauthState returned null. Failing 400.`);
    return Response.json(
      { error: "Invalid or expired state. Please restart the Google Ads connection." },
      { status: 400 },
    );
  }
  const { hotelClientId, agencyId } = payload;
  console.log(`${LOG} state OK:`, JSON.stringify({ hotelClientId, agencyId }));

  if (oauthError || !code) {
    console.warn(`${LOG} no code / oauth error (${oauthError ?? "missing code"}) → access_denied`);
    redirect(integrationsUrl(hotelClientId, { gads_error: "access_denied" }));
  }

  const hotel = await prisma.hotelClient.findFirst({
    where: { id: hotelClientId, agencyId },
    select: { id: true },
  });
  if (!hotel) {
    console.error(`${LOG} hotel ${hotelClientId} not found for agency ${agencyId} → 404`);
    return Response.json({ error: "Hotel not found." }, { status: 404 });
  }

  // ── Exchange code → tokens, then list the user's accessible Ads accounts ──
  let accessToken: string;
  let refreshToken: string | null;
  let tokenExpiresAt: Date;
  let scope: string;
  let customers: AdsCustomer[];
  try {
    console.log(`${LOG} step 1/2 exchangeCodeForTokens …`);
    const tokens = await exchangeCodeForTokens(code);
    accessToken = tokens.accessToken;
    refreshToken = tokens.refreshToken;
    tokenExpiresAt = tokens.expiresAt;
    scope = tokens.scope;
    console.log(
      `${LOG} step 1/2 OK:`,
      JSON.stringify({ access: mask(accessToken), refresh: mask(refreshToken), expiresAt: tokenExpiresAt.toISOString(), scope }),
    );

    console.log(`${LOG} step 2/2 listCustomersWithDetails …`);
    customers = await listCustomersWithDetails(accessToken);
    console.log(`${LOG} step 2/2 OK: ${customers.length} customer(s):`, JSON.stringify(customers.map((c) => c.customerId)));
  } catch (err) {
    console.error(`${LOG} EXCHANGE/CUSTOMERS FAILED:`, err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.error(`${LOG} stack:`, err.stack);
    redirect(integrationsUrl(hotelClientId, { gads_error: "exchange_failed" }));
  }

  if (customers.length === 0) {
    console.warn(`${LOG} user has no accessible Ads accounts → no_account`);
    redirect(integrationsUrl(hotelClientId, { gads_error: "no_account" }));
  }

  // listCustomersWithDetails returns only NON-manager advertiser accounts (managers
  // are expanded into their client accounts and can't be synced). Auto-select when
  // there's exactly one; otherwise send the user to the picker.
  const selected = customers.length === 1 ? customers[0] : null;

  // ── Encrypt tokens. Google only returns a refresh_token on the FIRST consent;
  // prompt=consent forces one, but if it's ever absent reuse the stored one. ──
  console.log(`${LOG} encrypting tokens + upserting GoogleAdsConnection …`);
  const accessCipher = await encryptWithAudit(accessToken, {
    agencyId, hotelClientId, tokenType: "google_ads", source: "oauth:google-ads-callback",
  });

  let refreshCipher: string;
  if (refreshToken) {
    refreshCipher = await encryptWithAudit(refreshToken, {
      agencyId, hotelClientId, tokenType: "google_ads", source: "oauth:google-ads-callback",
    });
  } else {
    const existing = await prisma.googleAdsConnection.findUnique({ where: { hotelClientId }, select: { id: true } });
    if (!existing) {
      console.error(`${LOG} no refresh_token returned and no existing connection → no_refresh`);
      redirect(integrationsUrl(hotelClientId, { gads_error: "no_refresh" }));
    }
    // Reuse the stored refresh token (decrypt out-of-band, re-encrypt).
    const stored = await getTokenForApiCall("google_ads_refresh", existing!.id, {
      agencyId, hotelClientId, source: "oauth:google-ads-callback-reuse",
    });
    refreshCipher = await encryptWithAudit(stored.reveal(), {
      agencyId, hotelClientId, tokenType: "google_ads", source: "oauth:google-ads-callback",
    });
  }

  // The login-customer-id header the sync must send: the MCC the selected advertiser
  // is reached through (set during manager expansion), or null for a directly-owned
  // account. This is per-account — never a single platform-wide env value.
  const login = selected?.loginCustomerId ?? null;

  try {
    const saved = await prisma.googleAdsConnection.upsert({
      where: { hotelClientId },
      create: {
        agencyId,
        hotelClientId,
        customerId: selected?.customerId ?? "",
        customerName: selected?.descriptiveName ?? null,
        currencyCode: selected?.currencyCode ?? null,
        loginCustomerId: login,
        accessToken: accessCipher,
        refreshToken: refreshCipher,
        tokenExpiresAt,
        scope,
        status: "ACTIVE",
        lastSyncError: null,
        requiresReconnect: false,
        lastErrorReason: null,
      },
      update: {
        customerId: selected?.customerId ?? "",
        customerName: selected?.descriptiveName ?? null,
        currencyCode: selected?.currencyCode ?? null,
        loginCustomerId: login,
        accessToken: accessCipher,
        refreshToken: refreshCipher,
        tokenExpiresAt,
        scope,
        status: "ACTIVE",
        lastSyncError: null,
        requiresReconnect: false,
        lastErrorReason: null,
      },
      select: { id: true },
    });
    console.log(`${LOG} DB write OK:`, JSON.stringify({ connectionId: saved.id, hotelClientId, customerId: selected?.customerId ?? "(pick)" }));
  } catch (err) {
    console.error(`${LOG} DB WRITE FAILED:`, err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.error(`${LOG} stack:`, err.stack);
    throw err;
  }

  if (!selected) {
    console.log(`${LOG} multiple accounts → redirect to account picker`);
    redirect(integrationsUrl(hotelClientId, { gads_select: "1" }));
  }

  console.log(`${LOG} success → integrations (gads_connected=success)`);
  redirect(integrationsUrl(hotelClientId, { gads_connected: "success" }));
}
