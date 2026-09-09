// ./load-env, not "dotenv/config": the latter reads only .env, which is empty in
// this repo, so DATABASE_URL arrived undefined and the production guard below
// had nothing to inspect. A safety check that cannot see the connection string
// is not a safety check.
import "./load-env";
import { databaseHost, destructiveRunRefusal } from "../lib/db-environment";
import { prisma } from "../lib/prisma";

// One-off cleanup agreed with the owner on 2026-06-06:
//   1. Delete the two demo hotels (Taj Backwater Retreat, Neelakurunji) —
//      cascades remove their snapshots, reports, content, share links, etc.
//   2. Delete demo-era agency history (backfill jobs/logs, sync failures,
//      alerts) for the kept agency so the real client starts clean.
//   3. Rename "Coastal Digital Agency" -> "Social Hippi" with the real email.
//      (Keeps the real Meta token + the gmail membership.)
//   4. Delete the two empty leftover agencies (revanth's, Talari Sunil's).
// Token audit logs are kept on purpose (security history of the real token).

// ─────────────────────────────────────────────────────────────────────────────
// THIS SCRIPT DELETES HOTELS AND AGENCY HISTORY. It is therefore built so that
// it CANNOT be pointed at live client data by accident.
//
// Two independent conditions must both hold before it touches anything:
//
//   1. an explicit --agency-id, so the target is never inferred from a name.
//      Agency names are not unique — two live tenants share "Social Hippi", and
//      this very script created that collision by renaming one of them;
//   2. a LOCAL DATABASE_URL. Not "not the production endpoint" — that was the
//      first attempt and it failed open against real production, because the
//      endpoint id it matched came from a stale comment. Anything not confirmed
//      local is refused, including hosts this file has never heard of.
// ─────────────────────────────────────────────────────────────────────────────

const KEEP_AGENCY = "Coastal Digital Agency";
const NEW_NAME = "Social Hippi";
const NEW_EMAIL = "ashrith@socialhippi.com";
const DELETE_AGENCIES = ["revanth's Agency", "Talari Sunil's Agency"];
const DELETE_HOTELS = ["Taj Backwater Retreat", "Neelakurunji Luxury Plantation Bungalow"];

async function main() {
  // ── Refuse before any database work ────────────────────────────────────────
  const argv = process.argv.slice(2);
  const idFlag = argv.indexOf("--agency-id");
  const agencyId = idFlag >= 0 ? argv[idFlag + 1] : undefined;

  const refusal = destructiveRunRefusal(process.env.DATABASE_URL);
  if (refusal) {
    console.error(`REFUSING TO RUN: ${refusal} Nothing was read and nothing was deleted.`);
    process.exit(1);
  }

  if (!agencyId) {
    console.error(
      "REFUSING TO RUN: pass --agency-id <id>. The target is never inferred from a name — " +
        "agency names are not unique, and this script is what made them collide. " +
        "Nothing was read and nothing was deleted.",
    );
    process.exit(1);
  }

  // Verify the id names a real agency. No name lookup at all any more.
  const agency = await prisma.agency.findUnique({
    where: { id: agencyId },
    select: { id: true, name: true },
  });
  if (!agency) {
    console.error(`No agency with id "${agencyId}" — aborting, nothing deleted.`);
    process.exit(1);
  }
  console.log(`Target: ${agency.name} (${agency.id}) on ${databaseHost(process.env.DATABASE_URL)}`);

  await prisma.$transaction(async (tx) => {
    // 1. Demo hotels (cascade removes all hotel-scoped rows).
    for (const name of DELETE_HOTELS) {
      const h = await tx.hotelClient.findFirst({
        where: { agencyId: agency.id, name },
        select: { id: true },
      });
      if (!h) {
        console.log(`hotel "${name}" — not found, skipped`);
        continue;
      }
      const ads = await tx.adSnapshot.count({ where: { hotelClientId: h.id } });
      await tx.hotelClient.delete({ where: { id: h.id } });
      console.log(`deleted hotel "${name}" (${ads} ad snapshots cascaded)`);
    }

    // 2. Demo-era agency history.
    const logs = await tx.backfillLog.deleteMany({ where: { agencyId: agency.id } });
    const jobs = await tx.backfillJob.deleteMany({ where: { agencyId: agency.id } });
    const fails = await tx.syncFailure.deleteMany({ where: { agencyId: agency.id } });
    const alerts = await tx.alert.deleteMany({ where: { agencyId: agency.id } });
    console.log(
      `cleared history: backfillLogs=${logs.count} backfillJobs=${jobs.count} syncFailures=${fails.count} alerts=${alerts.count}`,
    );

    // 3. Rename to the real agency.
    await tx.agency.update({
      where: { id: agency.id },
      data: { name: NEW_NAME, email: NEW_EMAIL },
    });
    console.log(`renamed "${KEEP_AGENCY}" -> "${NEW_NAME}" <${NEW_EMAIL}>`);

    // 4. Empty leftover agencies.
    for (const name of DELETE_AGENCIES) {
      const a = await tx.agency.findFirst({ where: { name }, select: { id: true } });
      if (!a) {
        console.log(`agency "${name}" — not found, skipped`);
        continue;
      }
      const hotels = await tx.hotelClient.count({ where: { agencyId: a.id } });
      if (hotels > 0) throw new Error(`agency "${name}" unexpectedly has ${hotels} hotels — aborting.`);
      await tx.agency.delete({ where: { id: a.id } });
      console.log(`deleted empty agency "${name}"`);
    }
  });

  console.log("\n✅ Cleanup complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
