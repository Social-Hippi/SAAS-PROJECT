import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnvFile } from "dotenv";

// Vitest does not read .env files. Vite only exposes VITE_-prefixed values, and
// only on import.meta.env — nothing reaches process.env. So without this file
// lib/prisma.ts reads DATABASE_URL as undefined and the pg adapter silently
// falls back to libpq defaults, which is why every DB-backed suite failed unless
// the caller exported the variables by hand first.
//
// Registered as `setupFiles` in vitest.config.ts so it runs before the test
// file's module graph is imported — which matters, because lib/prisma.ts builds
// its adapter from process.env.DATABASE_URL at module load time.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Next's precedence: .env.local beats .env, and a real shell export beats both.
// dotenv defaults to override:false — it never replaces a key already present in
// the target — so loading most-specific-first into one staging object reproduces
// exactly that ordering. First value wins.
//
// Staged rather than written straight to process.env so the filter below can see
// each value before it takes effect.
const staged: Record<string, string> = {};
for (const file of [".env.local", ".env"]) {
  loadEnvFile({ path: path.join(REPO_ROOT, file), processEnv: staged, quiet: true });
}

/**
 * A redaction placeholder, not a value: "[SENSITIVE]", "[REDACTED]".
 *
 * This repo's .env.local is a redacted export — at the time of writing 28 of its
 * ~30 entries are bracketed placeholders rather than real credentials. Promoting
 * those into process.env does not just fail to configure anything, it actively
 * misconfigures: ALLOWED_ADMIN_EMAIL_DOMAIN="[SENSITIVE]" made
 * allowedAdminEmailDomain() (lib/access.ts:13) return "[sensitive]", so
 * isAllowedStaffEmail() rejected the @socialhippi.com members that 20 test files
 * seed, getAgencyContext() threw TenantAuthError, and every route that catches it
 * answered 503 — 95 tests across 16 suites, all from that one line.
 *
 * No real secret is shaped like this, so skipping them loses nothing and keeps a
 * partially-redacted .env.local from quietly reconfiguring the suite.
 */
const REDACTION_PLACEHOLDER = /^\[[A-Z][A-Z_ -]*\]$/;

for (const [name, value] of Object.entries(staged)) {
  if (process.env[name] !== undefined) continue; // a real shell export wins
  if (REDACTION_PLACEHOLDER.test(value.trim())) continue;
  process.env[name] = value;
}

/** lib/encryption.ts wants a 32-byte key, written as 64 hex characters. */
const HEX_64 = /^[0-9a-fA-F]{64}$/;

function isUsableKey(value: string | undefined): boolean {
  return value !== undefined && HEX_64.test(value.trim());
}

// A throwaway key for tests, mirroring the CI job that mints one at runtime
// (commit 1c570c7) rather than depending on a secret holding a valid value.
// Two deliberate differences from CI:
//
//   • Derived, not random. vitest runs each file in its own fork, so a random
//     key would differ per fork; a derived one also makes a failing run
//     reproduce byte-for-byte.
//   • It lives in process.env and is never written to disk. A throwaway sitting
//     in .env.local would read like a credential, and the next person would have
//     no way to tell it was safe to replace.
//
// The encryption tests only round-trip within the process — no production
// ciphertext is ever read with this key.
const TEST_ONLY_KEY = createHash("sha256")
  .update("hoteltrack:test-only-encryption-key:v1")
  .digest("hex"); // sha256 as hex is exactly 64 characters

// Fill a gap; never shadow a real key. If ENCRYPTION_KEY is genuinely set we
// leave it alone, and ENCRYPTION_KEY_V1 then points at that same real key rather
// than at the throwaway — which is also what lib/encryption.ts's legacy v1
// fallback would have done on its own.
//
// V1 is set as well as the legacy name because tests/encryption.test.ts snapshots
// ENCRYPTION_KEY_V1 in beforeAll and restores it in afterEach: tests 2 and 6
// overwrite it, and tests 1, 5 and 7 need a working v1 key after that restore.
if (!isUsableKey(process.env.ENCRYPTION_KEY)) {
  process.env.ENCRYPTION_KEY = TEST_ONLY_KEY;
}
if (!isUsableKey(process.env.ENCRYPTION_KEY_V1)) {
  process.env.ENCRYPTION_KEY_V1 = process.env.ENCRYPTION_KEY;
}
