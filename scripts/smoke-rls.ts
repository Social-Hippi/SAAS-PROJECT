import "./load-env";
import { prisma } from "../lib/prisma";

// Proves the Layer-2 RLS policies actually enforce isolation at the DATABASE
// level — independent of any application code. It runs queries AS the non-owner
// `hoteltrack_app` role (via SET LOCAL ROLE inside a transaction) with the
// tenant GUC set, exactly as the app will once it connects as that role.
//
// Run: npx tsx scripts/smoke-rls.ts

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

async function makeAgency(tag: string) {
  const agency = await prisma.agency.create({
    data: { name: `RLS Smoke ${tag}`, email: `rls-smoke-${tag}-${Date.now()}@test.local` },
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
  return { agency, hotel, content };
}

// Run a callback inside a transaction AS hoteltrack_app with the given GUC.
async function asAppRole<T>(
  setup: { agencyId?: string; bypass?: boolean },
  fn: (tx: typeof prisma) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE hoteltrack_app");
    if (setup.bypass) {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    }
    if (setup.agencyId) {
      await tx.$executeRaw`SELECT set_config('app.current_agency_id', ${setup.agencyId}, true)`;
    }
    return fn(tx as unknown as typeof prisma);
  });
}

async function main() {
  console.log("\n▶ Layer-2 RLS enforcement smoke test (as hoteltrack_app role)\n");

  // The smoke runs `SET LOCAL ROLE`, which requires the current (owner) role to
  // be a member of hoteltrack_app. The migration's creator has admin on it.
  try {
    await prisma.$executeRawUnsafe("GRANT hoteltrack_app TO CURRENT_USER");
  } catch {
    /* already a member — fine */
  }

  const A = await makeAgency("A");
  const B = await makeAgency("B");
  console.log(`Agency A=${A.agency.id}  B=${B.agency.id}\n`);

  try {
    // 1. Reads are filtered by the RLS policy to agency A.
    console.log("1) RLS filters reads to the GUC agency");
    const aRows = await asAppRole({ agencyId: A.agency.id }, (tx) =>
      tx.$queryRaw<Array<{ id: string; agencyId: string }>>`
        SELECT id, "agencyId" FROM "HotelClient"`,
    );
    check("only A's hotels are visible", aRows.every((r) => r.agencyId === A.agency.id));
    check("A's hotel is visible", aRows.some((r) => r.id === A.hotel.id));
    check("B's hotel is NOT visible", !aRows.some((r) => r.id === B.hotel.id));

    // 2. Direct cross-tenant SELECT of B by id returns nothing.
    const bDirect = await asAppRole({ agencyId: A.agency.id }, (tx) =>
      tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "HotelClient" WHERE id = ${B.hotel.id}`,
    );
    check("SELECT of B's hotel id under A returns 0 rows", bDirect.length === 0);

    // 3. Cross-tenant UPDATE affects 0 rows (B's row is invisible to the policy).
    console.log("\n2) RLS blocks cross-tenant writes");
    const updCount = await asAppRole({ agencyId: A.agency.id }, (tx) =>
      tx.$executeRaw`UPDATE "HotelClient" SET name = 'HACKED' WHERE id = ${B.hotel.id}`,
    );
    check("UPDATE of B's hotel under A affects 0 rows", updCount === 0, `count=${updCount}`);
    const bAfter = await prisma.hotelClient.findUnique({ where: { id: B.hotel.id } });
    check("B's hotel name unchanged", bAfter?.name === "Hotel B", bAfter?.name);

    // 4. Cross-tenant DELETE affects 0 rows.
    const delCount = await asAppRole({ agencyId: A.agency.id }, (tx) =>
      tx.$executeRaw`DELETE FROM "ContentPiece" WHERE id = ${B.content.id}`,
    );
    check("DELETE of B's content under A affects 0 rows", delCount === 0, `count=${delCount}`);
    check("B's content still exists", !!(await prisma.contentPiece.findUnique({ where: { id: B.content.id } })));

    // 5. WITH CHECK blocks inserting a row for another agency.
    let insertBlocked = false;
    try {
      await asAppRole({ agencyId: A.agency.id }, (tx) =>
        tx.$executeRaw`
          INSERT INTO "HotelClient"
            ("id","agencyId","name","websiteUrl","contactName","contactEmail","conversionMethod","siteId")
          VALUES
            (${"smoke-bad-" + Date.now()}, ${B.agency.id}, 'x', 'https://e.com', 'c', 'c@e.com', 'both'::"ConversionMethod", ${"sid-" + Date.now()})`,
      );
    } catch {
      insertBlocked = true;
    }
    check("INSERT for agency B under A is blocked by WITH CHECK", insertBlocked);

    // 6. Same role with NO GUC set sees nothing (fail-closed).
    console.log("\n3) Fail-closed + super-admin bypass");
    const noCtx = await asAppRole({}, (tx) =>
      tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::int AS n FROM "HotelClient"`,
    );
    check("no agency GUC → 0 rows visible", Number(noCtx[0].n) === 0, `n=${noCtx[0].n}`);

    // 7. Super-admin bypass sees across agencies.
    const bypass = await asAppRole({ bypass: true }, (tx) =>
      tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "HotelClient" WHERE id IN (${A.hotel.id}, ${B.hotel.id})`,
    );
    check("bypass GUC sees BOTH A and B", bypass.length === 2, `saw ${bypass.length}`);
  } finally {
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
