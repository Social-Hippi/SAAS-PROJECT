import "server-only";

// ─────────────────────────────────────────────────────────────────────────────
// SURVIVING A MIGRATION THAT HAS NOT BEEN APPLIED YET.
//
// Migrations are applied by hand, deliberately and separately from the deploy.
// That means there is always a window — a preview deployment pointed at the
// production database, or a production deploy that lands before someone runs
// the migration — where the CODE knows about a table the DATABASE does not.
//
// Without this, that window is a total outage. The first thing that happened on
// this branch's preview deployment was every dashboard page returning
// "Something went wrong loading this page", because loading a hotel called
// prisma.propertySegment.findMany() and Prisma threw P2021.
//
// A NEW, OPTIONAL FEATURE MUST NEVER TAKE DOWN THE PAGE IT WAS ADDED TO. The
// property split and the operations tracker are additive; a report without them
// is the report as it was last week, which is a perfectly good report. So a
// missing table degrades to "this feature is not set up yet" and everything
// else renders.
//
// SCOPE IS DELIBERATELY NARROW. This swallows exactly two Prisma error codes —
// P2021 (table does not exist) and P2022 (column does not exist) — and nothing
// else. A connection failure, a constraint violation or a timeout still throws,
// because those are real faults and hiding them would turn this into the silent
// failure it exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────

/** Prisma: the table / column this query needs is not in the database. */
const SCHEMA_BEHIND_CODES = new Set(["P2021", "P2022"]);

function isSchemaBehind(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    SCHEMA_BEHIND_CODES.has((err as { code: string }).code)
  );
}

/**
 * Run a query that depends on a pending migration.
 *
 * Returns `fallback` when the table or column is not there yet, and rethrows
 * everything else. Logs once, loudly enough to grep, because a pending
 * migration is a real thing someone has to go and do — it should be visible in
 * the logs, not merely absorbed.
 */
export async function whenMigrated<T>(
  label: string,
  fallback: T,
  query: () => Promise<T>,
): Promise<T> {
  try {
    return await query();
  } catch (err) {
    if (!isSchemaBehind(err)) throw err;
    console.warn(
      "[MIGRATION-PENDING]",
      JSON.stringify({
        feature: label,
        code: (err as { code: string }).code,
        detail:
          "The database is missing a table or column this feature needs. The feature is " +
          "rendering as not-configured; everything else is unaffected. Apply the pending " +
          "Prisma migration to enable it.",
      }),
    );
    return fallback;
  }
}
