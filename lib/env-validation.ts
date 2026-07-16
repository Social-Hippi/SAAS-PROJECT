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

/** A provider's required vars; validated as a group (all-or-partial-or-none). */
type ProviderGroup = { name: string; vars: string[] };

const PROVIDERS: ProviderGroup[] = [
  {
    name: "Instagram",
    vars: ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "INSTAGRAM_REDIRECT_URI"],
  },
  {
    name: "Google / GA4",
    vars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GA4_REDIRECT_URI"],
  },
  {
    // Google Ads reuses the GOOGLE_OAUTH_* client (validated by the GA4 group
    // above), so only its OWN vars are grouped here — otherwise a GA4-only
    // deployment would trip the partial-config guard. Ads-specific: a platform
    // developer token + its dedicated OAuth redirect URI.
    name: "Google Ads",
    vars: ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_REDIRECT_URI"],
  },
];

const PLATFORM_WARNING =
  "These are PLATFORM-LEVEL credentials shared by every hotel — set them ONCE and " +
  "NEVER change them once hotels have connected (see INTEGRATIONS.md).";

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

  const strict =
    process.env.STRICT_ENV_VALIDATION === "1" ||
    process.env.STRICT_ENV_VALIDATION === "true";

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
