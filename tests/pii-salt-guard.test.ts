import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// The development PII salt must never reach a real database.
//
// A hash is only useful because ingestion and lookup agree, and the salt is what
// makes them agree. Hash with a different salt and NOTHING ERRORS — the values
// simply never match anything already stored, so every lookup misses and every
// write creates a new row beside the one it should have updated.
//
// That happened. A maintenance script run with only DATABASE_URL set re-imported
// 4,043 Kraya leads against production, silently took the dev fallback, matched
// none of the existing rows, and duplicated every conversation and booking it
// touched — 4,043 conversations and 200 bookings. It reported complete success,
// and the damage was only visible by counting rows afterwards.
//
// A script that forgets the salt must now fail on its first hash.
// ─────────────────────────────────────────────────────────────────────────────

const REMOTE = "postgresql://u:p@ep-something.ap-south-1.aws.neon.tech/neondb?sslmode=require";
const LOCAL = "postgresql://u:p@localhost:5432/hoteltrack";
const CLIENT_HASH = "a".repeat(64);

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    PII_SALT: process.env.PII_SALT,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
  };
  delete process.env.PII_SALT;
  delete process.env.ENCRYPTION_KEY;
  vi.resetModules();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
});

async function saltedHash(clientHash: string) {
  const mod = await import("@/lib/pii");
  return mod.saltedHash(clientHash);
}

describe("the dev salt is refused against a remote database", () => {
  test("throws when no salt is set and DATABASE_URL is remote", async () => {
    process.env.DATABASE_URL = REMOTE;
    await expect(saltedHash(CLIENT_HASH)).rejects.toThrow(/PII_SALT/);
  });

  test("the message says what would go wrong, not just that it is unset", async () => {
    // "unset" sends someone hunting for config. "writes would duplicate rows"
    // tells them what they are about to do to a table.
    process.env.DATABASE_URL = REMOTE;
    await expect(saltedHash(CLIENT_HASH)).rejects.toThrow(/duplicate rows rather than update/);
  });

  test("an unparseable DATABASE_URL is treated as remote", async () => {
    // Guessing "local" is the dangerous direction.
    process.env.DATABASE_URL = "not-a-url";
    await expect(saltedHash(CLIENT_HASH)).rejects.toThrow(/PII_SALT/);
  });
});

describe("local development is unaffected", () => {
  test.each([
    ["localhost", LOCAL],
    ["127.0.0.1", "postgresql://u:p@127.0.0.1:5432/db"],
    ["a .local host", "postgresql://u:p@db.local:5432/db"],
    ["no DATABASE_URL at all", ""],
  ])("%s still uses the dev fallback", async (_n, url) => {
    if (url) process.env.DATABASE_URL = url;
    else delete process.env.DATABASE_URL;
    await expect(saltedHash(CLIENT_HASH)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a configured salt always wins", () => {
  test.each([["PII_SALT"], ["ENCRYPTION_KEY"]])("%s set, remote database, no throw", async (key) => {
    process.env.DATABASE_URL = REMOTE;
    process.env[key] = "a-real-salt-value";
    await expect(saltedHash(CLIENT_HASH)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  test("PII_SALT takes precedence over ENCRYPTION_KEY", async () => {
    process.env.DATABASE_URL = LOCAL;
    process.env.PII_SALT = "one";
    const a = await saltedHash(CLIENT_HASH);
    vi.resetModules();
    process.env.PII_SALT = "two";
    const b = await saltedHash(CLIENT_HASH);
    expect(a).not.toBe(b);
  });
});
