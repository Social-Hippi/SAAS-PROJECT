import "server-only";

import { createHash } from "node:crypto";

// Server-side PII salting for visitor identity (snippet v2.2 / Phase 3).
//
// The snippet and the dashboard search box both hash an email/phone in the
// browser (lib/pii-client.ts) so the RAW value never reaches us. The server then
// applies THIS salted layer before storing or querying, so:
//   • the stored emailHash/phoneHash can't be reversed with a rainbow table of
//     known emails (the salt is a server-only secret), and
//   • ingestion and search produce identical values, so a lookup matches.
//
// The salt is PII_SALT, falling back to ENCRYPTION_KEY, then a dev default so
// local and test runs work without extra config. NEVER log raw PII; we only ever
// hold these one-way hashes plus the (less sensitive) name / customerId.
//
// THE DEV FALLBACK MUST NEVER REACH A REAL DATABASE.
//
// A hash is only useful because ingestion and lookup agree, and the salt is what
// makes them agree. Hash with a different salt and nothing errors — the values
// simply never match anything already stored, so every lookup misses and every
// write creates a new row beside the one it should have updated.
//
// That is not theoretical. A maintenance script run with only DATABASE_URL set
// re-imported 4,043 Kraya leads against production, silently took this fallback,
// matched none of the existing rows, and duplicated every conversation and
// booking it touched. It reported complete success.
//
// So the fallback is now refused whenever the database is not local. A script
// that forgets the salt fails on its first hash instead of corrupting a table.

/** True when DATABASE_URL points somewhere that is not a local database. */
function targetsRemoteDatabase(): boolean {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Unparseable: assume remote. Guessing "local" is the dangerous direction.
    return true;
  }
  return !(
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "host.docker.internal" ||
    host.endsWith(".local")
  );
}

function piiSalt(): string {
  const configured = process.env.PII_SALT || process.env.ENCRYPTION_KEY;
  if (configured) return configured;

  if (targetsRemoteDatabase()) {
    throw new Error(
      "PII_SALT (or ENCRYPTION_KEY) is not set, but DATABASE_URL points at a " +
        "remote database. Hashing with the development salt would not match any " +
        "stored value: lookups would miss and writes would duplicate rows rather " +
        "than update them. Set the real salt, or point at a local database.",
    );
  }

  return "hoteltrack-dev-pii-salt";
}

/**
 * Apply the salted server layer to a client-side SHA-256 hex digest. Returns
 * null unless `clientHash` is a well-formed 64-char hex SHA-256 (so a junk/raw
 * value can never be stored as if it were a hash). Used for both ingestion
 * (store) and lookup (query) so the two always agree.
 */
export function saltedHash(clientHash: string | null | undefined): string | null {
  const v = (clientHash ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(v)) return null;
  return createHash("sha256").update(`${piiSalt()}:${v}`).digest("hex");
}
