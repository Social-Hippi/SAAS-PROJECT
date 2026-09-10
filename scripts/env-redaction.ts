/**
 * Is this value a redaction placeholder rather than a real credential?
 *
 * `.env.local` in this repo is a redacted `vercel env pull`: entries Vercel
 * marks Sensitive come back as bracketed text like "[SENSITIVE]" instead of a
 * value. Promoting one into process.env does not merely fail to configure a
 * thing — it MISCONFIGURES it. A caller guarding with
 * `if (!process.env.META_APP_ID)` sees a non-empty string, sails past the check,
 * and calls the Graph API with the literal text, producing an opaque remote
 * error instead of a clear "not set" one. tests/setup-env.ts records the same
 * trap costing 95 tests across 16 suites.
 *
 * No real secret is shaped like this, so skipping them loses nothing.
 *
 * PURE, AND IN ITS OWN MODULE ON PURPOSE. scripts/load-env.ts is a side-effect
 * module — importing it reads files and mutates process.env — so a test that
 * imported it to check this rule would be testing the environment it happened to
 * run in. It lives here so the rule can be tested directly, on every machine,
 * including CI where none of those env files exist.
 */
export function isRedactionPlaceholder(value: string): boolean {
  return /^\[[A-Z][A-Z_ -]*\]$/.test(value.trim());
}
