import "./load-env";
import { prisma } from "../lib/prisma";
import { agencyScopedFor } from "../lib/tenant-scope";

// Validates the Layer-1 agency-scoped wrapper (agencyScopedFor) against the real
// database with two agencies A and B. It proves the wrapper injects the agency
// filter on reads AND blocks cross-tenant update/delete — the security property
// the whole refactor relies on. Creates throwaway data and deletes it at the end.
//
// Run: npx tsx scripts/smoke-tenant.ts

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ""}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}
function isP2025(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "P2025";
}

async function makeAgency(tag: string) {
  const agency = await prisma.agency.create({
    data: { name: `Tenant Smoke ${tag}`, email: `tenant-smoke-${tag}-${Date.now()}@test.local` },
  });
  const hotel = await prisma.hotelClient.create({
    data: {
      agencyId: agency.id,
      name: `Hotel ${tag}`,
      websiteUrl: "https://example.com",
      contactName: "C",
      contactEmail: "c@test.local",
      conversionMethod: "both",
    },
  });
  const content = await prisma.contentPiece.create({
    data: {
      agencyId: agency.id,
      hotelClientId: hotel.id,
      title: `Post ${tag}`,
      contentType: "organic",
      platform: "instagram",
      destinationUrl: "https://example.com/rooms",
      utmLink: "https://example.com/rooms?x=1",
    },
  });
  await prisma.trackingEvent.create({
    data: {
      agencyId: agency.id,
      hotelClientId: hotel.id,
      eventType: "visit",
      pageUrl: "https://example.com",
      sessionId: `s-${tag}`,
      deviceType: "desktop",
    },
  });
  return { agency, hotel, content };
}

async function main() {
  console.log("\n▶ Layer-1 tenant wrapper smoke test (agencyScopedFor)\n");
  const A = await makeAgency("A");
  const B = await makeAgency("B");
  console.log(`Agency A=${A.agency.id}  B=${B.agency.id}\n`);

  try {
    // 1. Reads are scoped to A and never see B.
    console.log("1) Reads are agency-scoped");
    const aHotels = await agencyScopedFor(A.agency.id, prisma.hotelClient).findMany({});
    check("findMany returns only A's hotels", aHotels.every((h) => h.agencyId === A.agency.id));
    check("findMany includes A's hotel", aHotels.some((h) => h.id === A.hotel.id));
    check("findMany excludes B's hotel", !aHotels.some((h) => h.id === B.hotel.id));

    const bByAId = await agencyScopedFor(A.agency.id, prisma.hotelClient).findFirst({
      where: { id: B.hotel.id },
    });
    check("findFirst can't fetch B's hotel via A", bByAId === null);

    // findUnique is rerouted to findFirst + scope.
    const bByUnique = await agencyScopedFor(A.agency.id, prisma.hotelClient).findUnique({
      where: { id: B.hotel.id },
    });
    check("findUnique(B id) via A → null", bByUnique === null);
    const aByUnique = await agencyScopedFor(A.agency.id, prisma.hotelClient).findUnique({
      where: { id: A.hotel.id },
    });
    check("findUnique(A id) via A → found", aByUnique?.id === A.hotel.id);

    // 2. count / aggregate scoped.
    console.log("\n2) Aggregates are agency-scoped");
    const aCount = await agencyScopedFor(A.agency.id, prisma.hotelClient).count({});
    const realACount = await prisma.hotelClient.count({ where: { agencyId: A.agency.id } });
    check("count matches A's real count", aCount === realACount, `${aCount}`);
    const evtAgg = await agencyScopedFor(A.agency.id, prisma.trackingEvent).aggregate({
      _count: { _all: true },
    });
    const realEvt = await prisma.trackingEvent.count({ where: { agencyId: A.agency.id } });
    check("aggregate trackingEvent scoped to A", evtAgg._count._all === realEvt);

    // 3. Cross-tenant UPDATE is blocked (the critical property).
    console.log("\n3) Cross-tenant update/delete blocked");
    let updateBlocked = false;
    try {
      await agencyScopedFor(A.agency.id, prisma.hotelClient).update({
        where: { id: B.hotel.id },
        data: { name: "HACKED" },
      });
    } catch (e) {
      updateBlocked = isP2025(e);
    }
    check("update of B's hotel via A throws P2025", updateBlocked);
    const bUnchanged = await prisma.hotelClient.findUnique({ where: { id: B.hotel.id } });
    check("B's hotel name unchanged", bUnchanged?.name === "Hotel B", bUnchanged?.name);

    // Same-tenant update still works.
    const okUpdate = await agencyScopedFor(A.agency.id, prisma.hotelClient).update({
      where: { id: A.hotel.id },
      data: { name: "Hotel A renamed" },
    });
    check("update of A's own hotel via A works", okUpdate.name === "Hotel A renamed");

    // 4. Cross-tenant DELETE blocked; updateMany affects 0 rows.
    let deleteBlocked = false;
    try {
      await agencyScopedFor(A.agency.id, prisma.contentPiece).delete({
        where: { id: B.content.id },
      });
    } catch (e) {
      deleteBlocked = isP2025(e);
    }
    check("delete of B's content via A throws P2025", deleteBlocked);
    const bContentAlive = await prisma.contentPiece.findUnique({ where: { id: B.content.id } });
    check("B's content still exists", !!bContentAlive);

    const upd = await agencyScopedFor(A.agency.id, prisma.contentPiece).updateMany({
      where: { id: B.content.id },
      data: { title: "nope" },
    });
    check("updateMany targeting B via A affects 0 rows", upd.count === 0, `count=${upd.count}`);

    // 5. create stamps A's agencyId even if omitted.
    console.log("\n4) create stamps the agencyId automatically");
    const createdHotel = await agencyScopedFor(A.agency.id, prisma.hotelClient).create({
      // agencyId intentionally OMITTED to prove the wrapper stamps it at runtime.
      // (Prisma's create type requires agencyId, so cast — app code keeps it
      // explicit and lets the wrapper override it.)
      data: {
        name: "Stamped",
        websiteUrl: "https://example.com",
        contactName: "C",
        contactEmail: "c@test.local",
        conversionMethod: "both",
      } as never,
    });
    check("created hotel got agencyId = A", createdHotel.agencyId === A.agency.id);

    // 6. Agency tenant-root is scoped by id, not agencyId.
    console.log("\n5) Agency (tenant root) scoped by id");
    const aSelf = await agencyScopedFor(A.agency.id, prisma.agency).findFirst({});
    check("agency.findFirst via A returns A", aSelf?.id === A.agency.id);
    // For the tenant root, the scope key (`id`) overrides a caller-supplied id,
    // so asking for B returns A's OWN row — never B's. That's the secure outcome.
    const bViaA = await agencyScopedFor(A.agency.id, prisma.agency).findFirst({
      where: { id: B.agency.id },
    });
    check("agency.findFirst never returns B via A", bViaA?.id !== B.agency.id, `got ${bViaA?.id}`);
  } finally {
    // Cleanup (cascade deletes hotels/content/events).
    await prisma.agency.deleteMany({ where: { id: { in: [A.agency.id, B.agency.id] } } });
  }

  console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
