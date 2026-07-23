import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { rateLimit, tooManyRequests, clientIpFromHeaders } from "@/lib/ratelimit";
import { verifyOauthState } from "@/lib/signed-state";
import { encryptWithAudit } from "@/lib/token-audit";
import { queueBackfillJob } from "@/lib/backfill";
import {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  validateToken,
  getAdAccounts,
  metaRedirectUri,
  META_OAUTH_SCOPES,
  META_NEVER_EXPIRES,
} from "@/lib/meta";

// Step 2 of the Meta OAuth flow. Facebook redirects here with ?code&state. The
// signed state (minted by /start for an authenticated agency member) binds this
// callback to exactly one agencyId (and optionally one hotelClientId), with a
// 10-minute expiry — so a callback can't be replayed or pointed at another tenant.
//
// SECURITY: code → short-lived → long-lived token exchanges are server-to-server;
// the long-lived token is AES-256-GCM encrypted (with audit) and stored — it
// never reaches the browser and is never logged. Every step logs under
// "[META-OAUTH]"; tokens/codes are masked (length + first 4 chars). No bare
// try/catch swallows Next's redirect: real errors set a reason and we redirect
// AFTER the try/catch, never inside it.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LOG = "[META-OAUTH]";

function mask(s: string | null | undefined): string {
  if (!s) return "(none)";
  return `${s.slice(0, 4)}…(len ${s.length})`;
}
function settingsUrl(params: Record<string, string>): string {
  return `/agency/settings?${new URLSearchParams(params).toString()}`;
}
function integrationsUrl(hotelClientId: string, params: Record<string, string>): string {
  return `/agency/hotel/${hotelClientId}/integrations?${new URLSearchParams(params).toString()}`;
}
// Agency-level entry (no hotel) returns to Settings; per-hotel entry returns there.
function returnUrl(hotelClientId: string, params: Record<string, string>): string {
  return hotelClientId ? integrationsUrl(hotelClientId, params) : settingsUrl(params);
}

export async function GET(request: Request) {
  // Per-IP cap to slow brute-forcing of the signed state token. Fails CLOSED.
  // Mirrors the Instagram callback — this route is public (see proxy.ts), so the
  // signed state is the ONLY credential and must be rate-limited like one.
  const rl = await rateLimit("oauthCallback", clientIpFromHeaders(request.headers));
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const url = new URL(request.url);
  const state = (url.searchParams.get("state") ?? "").trim();
  const code = (url.searchParams.get("code") ?? "").trim();
  const oauthError = url.searchParams.get("error");
  const oauthErrorReason = url.searchParams.get("error_reason");
  // Meta puts the ACTIONABLE text here ("App is not active", "Permissions error",
  // App Review / Advanced Access refusals). Previously dropped, which is why the
  // logs showed a bare access_denied with no cause.
  const oauthErrorDescription = url.searchParams.get("error_description");

  console.log(
    `${LOG} callback hit:`,
    JSON.stringify({
      hasCode: !!code,
      code: mask(code),
      hasState: !!state,
      oauthError: oauthError ?? null,
      oauthErrorReason: oauthErrorReason ?? null,
      oauthErrorDescription: oauthErrorDescription ?? null,
      META_APP_ID: process.env.META_APP_ID ? "(set)" : "(unset)",
      // Log the EFFECTIVE value (env or derived), not just the raw env — the raw
      // env being unset is no longer an error, so the raw value alone misleads.
      metaRedirectUri_effective: metaRedirectUri(),
      META_OAUTH_REDIRECT_URI_raw: process.env.META_OAUTH_REDIRECT_URI ?? "(unset → derived)",
      META_LOGIN_CONFIG_ID: process.env.META_LOGIN_CONFIG_ID ? "(set → Business Login)" : "(unset → classic scope)",
      META_APP_SECRET_present: !!process.env.META_APP_SECRET,
    }),
  );

  const payload = state ? verifyOauthState(state) : null;
  if (!payload) {
    console.error(`${LOG} STATE INVALID — verifyOauthState returned null. Failing 400.`);
    return Response.json(
      { error: "Invalid or expired state. Please restart the Meta connection." },
      { status: 400 },
    );
  }
  // Tokens are hotel-scoped now, so the state MUST carry a hotelClientId.
  const { hotelClientId, agencyId } = payload;
  if (!hotelClientId) {
    console.error(`${LOG} STATE missing hotelClientId — hotel-scoped flow requires it. Failing 400.`);
    return Response.json(
      { error: "Invalid state — no hotel selected. Please restart the Meta connection from the hotel's Integrations page." },
      { status: 400 },
    );
  }
  console.log(`${LOG} state OK:`, JSON.stringify({ hotelClientId, agencyId }));

  // User denied on Facebook's screen, or Meta returned an error (no code).
  if (oauthError || !code) {
    console.warn(
      `${LOG} no code / oauth error (${oauthError ?? "missing code"}; reason=${oauthErrorReason ?? "n/a"}; ` +
        `description=${oauthErrorDescription ?? "n/a"}) → access_denied`,
    );
    redirect(returnUrl(hotelClientId, { meta_error: "access_denied" }));
  }

  // Re-verify the hotel still belongs to the (signed) agency before storing.
  {
    const hotel = await prisma.hotelClient.findFirst({
      where: { id: hotelClientId, agencyId },
      select: { id: true },
    });
    if (!hotel) {
      console.error(`${LOG} hotel ${hotelClientId} not found for agency ${agencyId} → 404`);
      return Response.json({ error: "Hotel not found." }, { status: 404 });
    }
  }

  // ── code → short-lived → long-lived; then identify user + count ad accounts ──
  // All work in the try; on ANY failure we set failReason and redirect AFTER the
  // try/catch (so redirect()'s internal throw is never caught here).
  type Identified = {
    longLived: string;
    tokenExpiresAt: Date;
    fbUserId: string | null;
    fbUserName: string | null;
    scopes: string[];
    adAccountCount: number;
  };
  let result: Identified | null = null;
  let failReason: string | null = null;

  try {
    console.log(`${LOG} step 1/4 exchangeCodeForToken …`);
    const short = await exchangeCodeForToken(code);
    console.log(`${LOG} step 1/4 OK:`, JSON.stringify({ token: mask(short.accessToken) }));

    console.log(`${LOG} step 2/4 exchangeForLongLivedToken …`);
    const long = await exchangeForLongLivedToken(short.accessToken);
    console.log(
      `${LOG} step 2/4 OK:`,
      JSON.stringify({
        token: mask(long.accessToken),
        expiresAt: (long.expiresAt ?? META_NEVER_EXPIRES).toISOString(),
      }),
    );

    console.log(`${LOG} step 3/4 validateToken (/me + /debug_token) …`);
    const v = await validateToken(long.accessToken);
    if (!v.valid) {
      console.error(`${LOG} step 3/4 token did not validate: ${v.error}`);
      failReason = "exchange_failed";
    } else {
      console.log(
        `${LOG} step 3/4 OK:`,
        JSON.stringify({ fbUserId: v.userId ?? null, fbUserName: v.userName ?? null, scopes: v.scopes ?? null }),
      );

      console.log(`${LOG} step 4/4 getAdAccounts …`);
      const accounts = await getAdAccounts(long.accessToken);
      console.log(`${LOG} step 4/4 OK: ${accounts.length} ad account(s)`);

      result = {
        longLived: long.accessToken,
        // Prefer debug_token's exact expiry; fall back to expires_in; else sentinel.
        tokenExpiresAt: v.expiresAt ?? long.expiresAt ?? META_NEVER_EXPIRES,
        fbUserId: v.userId ?? null,
        fbUserName: v.userName ?? null,
        scopes: v.scopes && v.scopes.length ? v.scopes : [...META_OAUTH_SCOPES],
        adAccountCount: accounts.length,
      };
    }
  } catch (err) {
    console.error(`${LOG} EXCHANGE/IDENTIFY FAILED:`, err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.error(`${LOG} stack:`, err.stack);
    failReason = "exchange_failed";
  }

  if (failReason || !result) {
    redirect(returnUrl(hotelClientId, { meta_error: failReason ?? "exchange_failed" }));
  }

  // ── Encrypt + upsert the HOTEL token (one row per hotel: hotelClientId is
  // unique, so find-then-update keeps exactly one). ──
  console.log(`${LOG} encrypting long-lived token + upserting MetaToken …`);
  const encryptedToken = await encryptWithAudit(result.longLived, {
    agencyId,
    hotelClientId,
    tokenType: "meta_ads",
    source: "oauth:meta-callback",
  });

  const data = {
    encryptedToken,
    tokenExpiresAt: result.tokenExpiresAt,
    status: "connected",
    tokenSource: "OAUTH" as const,
    oauthScopes: result.scopes,
    refreshableViaOAuth: true,
    connectedFacebookUserId: result.fbUserId,
    connectedFacebookUserName: result.fbUserName,
    disconnectedAt: null,
    lastRefreshedAt: new Date(),
    expiryWarningStage: null,
  };

  try {
    const existing = await prisma.metaToken.findFirst({
      where: { hotelClientId, agencyId },
      select: { id: true },
    });
    if (existing) {
      await prisma.metaToken.update({ where: { id: existing.id }, data });
    } else {
      await prisma.metaToken.create({ data: { agencyId, hotelClientId, ...data } });
    }
    console.log(
      `${LOG} DB write OK:`,
      JSON.stringify({
        agencyId,
        hotelClientId,
        fbUserId: result.fbUserId,
        adAccounts: result.adAccountCount,
        expiresAt: result.tokenExpiresAt.toISOString(),
      }),
    );
  } catch (err) {
    console.error(`${LOG} DB WRITE FAILED:`, err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.error(`${LOG} stack:`, err.stack);
    throw err;
  }

  // A first connect imports trailing history for every mapped hotel; a reconnect
  // refills the gap. Per-hotel ad-account mapping (which also triggers an inline
  // sync) is done on each hotel's Integrations page. Best-effort — never blocks.
  try {
    await queueBackfillJob(agencyId);
  } catch {
    // The scheduled sync still keeps recent days fresh if scheduling hiccups.
  }

  if (result.adAccountCount === 0) {
    console.warn(`${LOG} connected, but this Facebook user can access 0 ad accounts.`);
  }

  console.log(
    `${LOG} success → ${hotelClientId ? "hotel integrations" : "settings"} (meta_connected=success)`,
  );
  redirect(returnUrl(hotelClientId, { meta_connected: "success" }));
}
