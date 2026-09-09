import "dotenv/config";
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

const KEEP_AGENCY = "Coastal Digital Agency";
const NEW_NAME = "Social Hippi";
const NEW_EMAIL = "ashrith@socialhippi.com";
const DELETE_AGENCIES = ["revanth's Agency", "Talari Sunil's Agency"];
const DELETE_HOTELS = ["Taj Backwater Retreat", "Neelakurunji Luxury Plantation Bungalow"];

async function main() {
  // This script DELETES hotels and agency history, and it picks its target by
  // NAME. Agency names are not unique — two live tenants share "Social Hippi" —
  // so findFirst here could delete the wrong tenant's data. It refuses on an
  // ambiguous match rather than choosing, and nothing is deleted.
  const candidates = await prisma.agency.findMany({
    where: { name: KEEP_AGENCY },
    select: { id: true, email: true },
  });
  if (candidates.length === 0) {
    throw new Error(`Agency "${KEEP_AGENCY}" not found — aborting, nothing deleted.`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `"${KEEP_AGENCY}" matches ${candidates.length} agencies ` +
        `(${candidates.map((c) => c.id).join(", ")}) — aborting, nothing deleted. ` +
        `Agency names are not unique; target this script by id.`,
    );
  }
  const agency = candidates[0]!;

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
