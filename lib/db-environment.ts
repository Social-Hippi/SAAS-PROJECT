// Which database is this connection string pointing at?
//
// Pure predicates, deliberately in lib/ rather than in the destructive script
// that uses them. A guard has to be testable, and a test that imported
// scripts/cleanup-demo-data.ts would EXECUTE it — the script calls main() on
// import, so merely asserting on its behaviour would run the deletions.
//
// ── WHY THIS FAILS CLOSED ────────────────────────────────────────────────────
//
// The first version of this matched a hardcoded production endpoint id and
// refused only on that. It FAILED OPEN, and it did so in production: the id was
// taken from a stale commented-out line in .env.local, and the live database is
// a different endpoint entirely. Against the real production URL the guard
// returned "not production" and would have let a script that deletes hotels
// run.
//
// An allowlist keyed on identity is only as good as your knowledge of every
// host, and that knowledge goes stale silently. So the rule is inverted: a
// destructive script may run against LOCAL databases only, and anything it does
// not recognise as local — a Neon branch, a staging box, a host that did not
// exist when this was written — is refused. Being wrong then costs an
// inconvenient refusal instead of deleted client data.

/** Hosts that are unambiguously a developer's own machine. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/**
 * Deliberate opt-in for a destructive run against a non-local database — a
 * staging cleanup, say. An environment variable rather than a flag, so it cannot
 * be reached by tab-completing a command someone half-remembers.
 */
export const DESTRUCTIVE_REMOTE_OVERRIDE = "ALLOW_DESTRUCTIVE_ON_REMOTE";

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
 * True only for a database on this machine.
 *
 * An absent or unparseable URL is NOT local. That is the whole point: the
 * unknown case must land on the safe side, and previously it did not.
 */
export function isLocalDatabase(url: string | undefined): boolean {
  const host = databaseHost(url).toLowerCase();
  return host !== "" && LOCAL_HOSTS.has(host.replace(/:\d+$/, ""));
}

/**
 * Why a destructive script must not run against this database, or null when it
 * may. The message is written to be shown to whoever ran the command.
 */
export function destructiveRunRefusal(
  url: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (isLocalDatabase(url)) return null;

  const override = env[DESTRUCTIVE_REMOTE_OVERRIDE];
  if (override === "1" || override === "true") return null;

  const host = databaseHost(url);
  return (
    `DATABASE_URL points at ${host || "an unreadable host"}, which is not a local database. ` +
    `This script deletes hotels and rewrites agency history, so it refuses anything it cannot ` +
    `confirm is local — including hosts it has never heard of. Set ` +
    `${DESTRUCTIVE_REMOTE_OVERRIDE}=1 only if you intend this.`
  );
}
