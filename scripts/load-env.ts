import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnvFile } from "dotenv";

import { isRedactionPlaceholder } from "./env-redaction";

// Side-effect module: import this FIRST, before anything that reads process.env
// at module load (lib/prisma.ts builds its adapter from DATABASE_URL that way).
//
// `import "dotenv/config"` — what every script here used to do — reads only
// `.env`, which this repo does not have: the real values live in `.env.local` (a
// `vercel env pull` export) and `.env.development.local`. So those scripts only
// ran if the caller exported DATABASE_URL by hand first, and otherwise reached
// Prisma with it undefined.
//
// This loads the same files `next dev` does, in the same precedence order.
//
// Paths are resolved against the REPO ROOT, derived from this module's own URL,
// rather than left relative. That is not tidiness. dotenv resolves a relative
// `path` against process.cwd(), and when nothing is there it loads nothing and
// says nothing — no throw, no warning, an empty result that reads exactly like a
// success. So a relative path works only when the caller's cwd happens to be the
// repo root (`npm run ...` from the top) and silently loads NOTHING from
// anywhere else: `cd scripts && npx tsx smoke-rls.ts` would reach Prisma with
// DATABASE_URL unset, presenting as the very bug this module exists to fix.
// Deriving the root from import.meta.url takes cwd out of the equation.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// dotenv defaults to override:false — it never replaces a key already present in
// the target — so loading most-specific-first into one staging object reproduces
// Next's ordering exactly. First value wins.
//
// Staged rather than written straight to process.env so the filter below can see
// each value before it takes effect. Mirrors tests/setup-env.ts, which does the
// same for vitest.
const staged: Record<string, string> = {};
for (const file of [".env.development.local", ".env.local", ".env"]) {
  loadEnvFile({ path: path.join(REPO_ROOT, file), processEnv: staged, quiet: true });
}

// Skipping redaction placeholders — see scripts/env-redaction.ts for why.

for (const [name, value] of Object.entries(staged)) {
  if (process.env[name] !== undefined) continue; // a real shell export wins
  if (isRedactionPlaceholder(value)) continue;
  process.env[name] = value;
}
