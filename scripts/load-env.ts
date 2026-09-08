import { config as loadEnvFile } from "dotenv";

// Side-effect module: import this FIRST, before anything that reads process.env
// at module load (lib/prisma.ts builds its adapter from DATABASE_URL that way).
//
// `import "dotenv/config"` — what the other scripts use — reads only `.env`,
// which in this repo is empty: the real values live in `.env.local` (a redacted
// `vercel env pull`) and `.env.development.local`. So those scripts only work if
// the caller exports DATABASE_URL by hand first.
//
// This loads the same files `next dev` does, in the same precedence order.
// dotenv's override:false means the first file to define a key wins, which
// reproduces Next's ordering exactly, and a real shell export still beats all of
// them. Mirrors tests/setup-env.ts, which does this for vitest.
for (const file of [".env.development.local", ".env.local", ".env"]) {
  loadEnvFile({ path: file, quiet: true });
}
