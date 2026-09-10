import "./load-env";
import { prisma } from "../lib/prisma";

// READ-ONLY: inspect what's left that could be fake/test data after the
// 2026-06-06 demo purge. Writes nothing.

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "—");

async function main() {
  // All hotels, to pin down the duplicate.
  const hotels = await prisma.hotelClient.findMany({
    select: { id: true, name: true, agencyId: true, websiteUrl: true, metaAdAccountId: true, createdAt: true, siteId: true },
    orderBy: { createdAt: "asc" },
  });
  console.log("HOTELS:");
  for (const h of hotels) {
    const ads = await prisma.adSnapshot.count({ where: { hotelClientId: h.id } });
    const events = await prisma.trackingEvent.count({ where: { hotelClientId: h.id } });
    console.log(
      `  ${h.id} "${h.name}" url=${h.websiteUrl} adAcct=${h.metaAdAccountId ?? "none"} ` +
        `created=${iso(h.createdAt)} adSnapshots=${ads} events=${events}`,
    );
  }

  // The tracking events — every single one, with provenance fields.
  console.log("\nTRACKING EVENTS (all):");
  const events = await prisma.trackingEvent.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true, hotelClientId: true, eventType: true, utmSource: true, utmMedium: true,
      utmCampaign: true, pageUrl: true, conversionValue: true, sessionId: true, createdAt: true,
    },
  });
  for (const e of events) {
    console.log(
      `  ${iso(e.createdAt)} ${e.eventType} src=${e.utmSource ?? "—"} med=${e.utmMedium ?? "—"} ` +
        `camp=${e.utmCampaign ?? "—"} value=${e.conversionValue ?? "—"} page=${e.pageUrl}`,
    );
  }

  // Remaining agencies + everything attached to the second one.
  console.log("\nAGENCIES:");
  const agencies = await prisma.agency.findMany({
    select: { id: true, name: true, email: true, plan: true, subscriptionStatus: true, createdAt: true },
  });
  for (const a of agencies) {
    const [hotelCount, members, alerts, reports] = await Promise.all([
      prisma.hotelClient.count({ where: { agencyId: a.id } }),
      prisma.agencyMember.count({ where: { agencyId: a.id } }),
      prisma.alert.count({ where: { agencyId: a.id } }),
      prisma.report.count({ where: { agencyId: a.id } }),
    ]);
    console.log(
      `  ${a.id} "${a.name}" <${a.email}> plan=${a.plan}/${a.subscriptionStatus} ` +
        `created=${iso(a.createdAt)} hotels=${hotelCount} members=${members} alerts=${alerts} reports=${reports}`,
    );
  }

  // Alerts content (could be demo-seeded).
  const alerts = await prisma.alert.findMany({
    select: { id: true, agencyId: true, type: true, message: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nALERTS (${alerts.length}):`);
  for (const al of alerts) console.log(`  ${iso(al.createdAt)} [${al.type}] ${al.message}`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
