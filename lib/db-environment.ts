// Which database is this connection string pointing at?
//
// Pure predicates, deliberately in lib/ rather than in the destructive script
// that uses them. A guard has to be testable, and a test that imports
// scripts/cleanup-demo-data.ts would EXECUTE it — the script calls main() on
// import, so merely asserting on its behaviour would run the deletions.

/**
 * The production Neon endpoint id. Matched as a substring so it catches both the
 * pooled and direct hostnames, which differ only by a `-pooler` infix.
 */
export const PRODUCTION_NEON_ENDPOINT = "ep-sweet-river-apbl49f2";

/**
 * HOSTNAME of a connection string, without the port, or "" when unreadable.
 *
 * Port-less on purpose: the endpoint identity is in the hostname, and a pooled
 * and a direct connection to the same database differ by host and port both.
 */
export function databaseHost(url: string | undefined): string {
  return (String(url ?? "").match(/@([^/:?]+)/) ?? [])[1] ?? "";
}

/**
 * True when this connection string points at the production database.
 *
 * An absent or unparseable URL reports FALSE — it is not evidence of production.
 * Callers that need to fail closed pair this with a second, independent
 * condition rather than reading "not production" as "safe".
 */
export function isProductionDatabase(url: string | undefined): boolean {
  return databaseHost(url).includes(PRODUCTION_NEON_ENDPOINT);
}
