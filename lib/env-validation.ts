import "server-only";

// Fail-loud platform-env validation, run once at server startup (imported by
// app/layout.tsx). The diagnostic that prompted this found integration OAuth
// silently broken in production because platform credentials were empty strings.
// This makes that state impossible to ship unnoticed.
//
// Three severities:
//   • ALWAYS-REQUIRED invariants (ENCRYPTION_KEY, AUTH_SECRET, DATABASE_URL):
//     the app cannot function without them → THROW. Crashing here is correct;
//     every request would fail anyway, and a wrong/short ENCRYPTION_KEY would
//     make every stored token undecryptable.
//   • PARTIAL provider config (some of a provider's vars set, others empty):
//     this is the dangerous silent-broken state — OAuth starts then fails mid
//     flow → THROW with a precise message naming the empty var(s).
//   • FULLY-UNSET provider (all of a provider's vars empty/missing): the
//     integration is simply unavailable; the per-use guard in lib/<provider>.ts
//     already throws a clear error at connect time → loud WARN, do not crash
//     (so an unconfigured optional integration can't take down the whole app).
//
// Set STRICT_ENV_VALIDATION=1 to also throw on the fully-unset case.

const HEX_64_PLUS = /^[0-9a-fA-F]{64,}$/;

function isEmpty(v: string | undefined): boolean {
  return v == null || v.trim() === "";
}

/**
 * A provider's CREDENTIAL vars; validated as a group (all-or-partial-or-none).
 *
 * Redirect URIs are deliberately NOT listed here. Every provider derives its
 * callback from NEXT_PUBLIC_APP_URL when the explicit var is absent
 * (metaRedirectUri / instagramRedirectUri / ga4RedirectUri / googleAdsRedirectUri),
 * so an omitted *_REDIRECT_URI is a valid, fully-working configuration. Treating
 * one as a missing group member made the validator report a "partial config"
 * FATAL and refuse to boot a correctly-configured deployment.
 */
type ProviderGroup = { name: string; vars: string[] };

const PROVIDERS: ProviderGroup[] = [
  {
    name: "Instagram",
    vars: ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"],
  },
  {
    name: "Google / GA4",
    vars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
  },
  {
    // Meta Ads (ad ROI). The callback route is /api/auth/meta/callback; the
    // optional override var is META_OAUTH_REDIRECT_URI (see lib/meta.ts).
    name: "Meta",
    vars: ["META_APP_ID", "META_APP_SECRET"],
  },
  {
    // Google Ads reuses the GOOGLE_OAUTH_* client (validated by the GA4 group
    // above), so only its OWN var is grouped here — otherwise a GA4-only
    // deployment would trip the partial-config guard.
    name: "Google Ads",
    vars: ["GOOGLE_ADS_DEVELOPER_TOKEN"],
  },
];

/**
 * Optional redirect-URI overrides. Not required (each is derived), but when one
 * IS set it must be an absolute https URL on the canonical origin — a non-www
 * value against a www-canonical deployment is exactly what produced Meta's
 * "URL Blocked" and Instagram's "Invalid redirect_uri". Warn loudly; never crash.
 */
const REDIRECT_URI_VARS = [
  "META_OAUTH_REDIRECT_URI",
  "INSTAGRAM_REDIRECT_URI",
  "GA4_REDIRECT_URI",
  "GOOGLE_ADS_REDIRECT_URI",
] as const;

function checkRedirectUris(): void {
  const appOrigin = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
  for (const name of REDIRECT_URI_VARS) {
    const raw = process.env[name]?.trim();
    if (!raw) continue; // absent is fine — it is derived
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      console.warn(`[ENV] WARNING: ${name} is not an absolute URL ("${raw}"). OAuth will fail.`);
      continue;
    }
    if (process.env.NODE_ENV === "production" && u.protocol !== "https:") {
      console.warn(`[ENV] WARNING: ${name} must use https in production (got "${u.protocol}").`);
    }
    if (appOrigin && !raw.startsWith(`${appOrigin}/`)) {
      console.warn(
        `[ENV] WARNING: ${name} ("${u.origin}") does not sit on NEXT_PUBLIC_APP_URL ("${appOrigin}"). ` +
          `The provider redirects to the registered URI, so a host mismatch (typically www vs non-www) ` +
          `causes "URL Blocked" / "Invalid redirect_uri". Align both, or unset ${name} to derive it.`,
      );
    }
  }
}

const PLATFORM_WARNING =
  "These are PLATFORM-LEVEL credentials shared by every hotel — set them ONCE and " +
  "NEVER change them once hotels have connected (see INTEGRATIONS.md).";

// Hostnames that are never valid for a production public origin — a snippet
// built from one of these can only beacon back to the deploy itself.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/**
 * Returns a human-readable problem with a candidate NEXT_PUBLIC_APP_URL, or
 * null when it is a usable public origin. Exported for unit testing.
 */
export function appUrlProblem(raw: string): string | null {
  if (isEmpty(raw)) return "is empty";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `is not an absolute URL (got "${raw}")`;
  }
  if (url.protocol !== "https:") return `must use https (got "${url.protocol}")`;
  if (LOCAL_HOSTS.has(url.hostname)) return `points at a local address ("${url.hostname}")`;
  if (url.hostname.endsWith(".vercel.app")) {
    return `points at a preview deployment ("${url.hostname}")`;
  }
  if (url.hostname === "your-domain.com") return "is still the placeholder value";
  return null;
}

function fatal(message: string): never {
  // One clear, greppable line. Throwing here aborts module load → the deploy
  // surfaces the misconfiguration instead of silently serving broken OAuth.
  throw new Error(`FATAL ENV MISCONFIGURATION: ${message} ${PLATFORM_WARNING}`);
}

let validated = false;

/**
 * Validates platform env once per server instance. Safe to call repeatedly.
 * Throws on always-required invariants and on partially-configured providers;
 * warns (or throws under STRICT_ENV_VALIDATION) on fully-unset providers.
 */
export function validatePlatformEnv(): void {
  if (validated) return;
  validated = true;

  // ── Always-required invariants ──────────────────────────────────────────────
  if (isEmpty(process.env.DATABASE_URL)) {
    fatal("DATABASE_URL is empty — the app cannot reach its database.");
  }
  if (isEmpty(process.env.AUTH_SECRET)) {
    fatal("AUTH_SECRET is empty — OAuth state signing will fail.");
  }
  const encKey = process.env.ENCRYPTION_KEY;
  if (isEmpty(encKey)) {
    fatal("ENCRYPTION_KEY is empty — stored access tokens cannot be encrypted/decrypted.");
  } else if (!HEX_64_PLUS.test(encKey!.trim())) {
    fatal(
      "ENCRYPTION_KEY must be at least 64 hex chars (32 bytes). Changing it makes " +
        "every already-stored token undecryptable — rotate via a migration script, not by editing this value.",
    );
  }

  // ── Clerk (auth) — required for any PRODUCTION build ─────────────────────────
  // If the publishable/secret key is absent, @clerk/nextjs silently drops into
  // KEYLESS mode: clerk-js is then requested from the "/__clerk" default proxy path
  // (DEFAULT_PROXY_PATH in @clerk/shared), which is a dev-only handler. In a
  // production build that path 404s → "Failed to load Clerk JS" and a BLANK /sign-in.
  // NEXT_PUBLIC_* is inlined at BUILD time, so this must be present in the BUILD
  // environment (on Vercel: BOTH the Production and Preview scopes). Gated to
  // production so intentional keyless local dev still works.
  if (process.env.NODE_ENV === "production") {
    const clerkEmpty = ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"].filter(
      (v) => isEmpty(process.env[v]),
    );
    if (clerkEmpty.length > 0) {
      throw new Error(
        `FATAL ENV MISCONFIGURATION: ${clerkEmpty.join(", ")} ${clerkEmpty.length === 1 ? "is" : "are"} ` +
          `empty in a production build. @clerk/nextjs falls back to keyless mode and clerk-js 404s from the ` +
          `/__clerk proxy path, blanking /sign-in. Set ${clerkEmpty.length === 1 ? "it" : "them"} in the ` +
          `deployment's env (Vercel: Production AND Preview scopes) and REDEPLOY — NEXT_PUBLIC_ vars are ` +
          `inlined at build time, so adding them without a rebuild does nothing.`,
      );
    }
  }

  // ── Public app URL — required for any PRODUCTION build ──────────────────────
  // Every tracking snippet handed to a hotel is built from this value (the
  // welcome email in lib/hotel-invite.ts, plus the install + integrations
  // pages), and public/t.js derives its own ingest origin from the src it was
  // loaded with. A wrong or missing value therefore ships a snippet that
  // beacons to the wrong host — or to localhost — and the hotel records zero
  // traffic with no visible error. Same NEXT_PUBLIC_ build-time inlining caveat
  // as the Clerk keys above: it must be set in the BUILD env, and changing it
  // requires a REDEPLOY.
  if (process.env.NODE_ENV === "production") {
    const raw = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
    const reason = appUrlProblem(raw);
    if (reason) {
      throw new Error(
        `FATAL ENV MISCONFIGURATION: NEXT_PUBLIC_APP_URL ${reason} in a production build. ` +
          `It is the base of every hotel's tracking snippet, so an unset or non-production value ` +
          `silently breaks booking attribution. Set it to the public https origin (e.g. ` +
          `https://hoteltrack.in) in the deployment's env (Vercel: Production AND Preview scopes) ` +
          `and REDEPLOY — NEXT_PUBLIC_ vars are inlined at build time, so adding it without a ` +
          `rebuild does nothing.`,
      );
    }
  }

  const strict =
    process.env.STRICT_ENV_VALIDATION === "1" ||
    process.env.STRICT_ENV_VALIDATION === "true";

  // ── Optional redirect-URI overrides (warn-only) ─────────────────────────────
  checkRedirectUris();

  // ── Per-provider groups ─────────────────────────────────────────────────────
  for (const provider of PROVIDERS) {
    const empties = provider.vars.filter((v) => isEmpty(process.env[v]));

    if (empties.length === 0) continue; // fully configured — good

    if (empties.length < provider.vars.length) {
      // Partial: the silent-broken state. Name the empty var(s) precisely.
      const list = empties.join(", ");
      fatal(
        `${list} ${empties.length === 1 ? "is" : "are"} empty while other ${provider.name} ` +
          `credentials are set — ${provider.name} OAuth will start then fail mid-flow. ` +
          `Set ${empties.length === 1 ? "it" : "them"} in Vercel env vars and redeploy.`,
      );
    }

    // Fully unset: integration unavailable but not broken.
    const msg =
      `[ENV] WARNING: ${provider.name} is not configured (${provider.vars.join(", ")} all empty). ` +
      `${provider.name} connections will fail until these are set. ${PLATFORM_WARNING}`;
    if (strict) fatal(msg);
    console.warn(msg);
  }
}
