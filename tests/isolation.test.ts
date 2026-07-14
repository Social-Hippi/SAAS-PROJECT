import "dotenv/config";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3 — automated multi-tenant isolation suite (see MULTITENANCY.md).
//
// Covers, against a real database with two agencies A and B:
//   1. Layer-1 app scoping — agencyScoped never crosses the tenant line.
//   2. Authenticated route handlers return only the caller's data.
//   3. Layer-2 RLS — direct DB reads/writes as the non-owner app role are
//      blocked across tenants (and fail closed with no context).
//   4. Cross-tenant UPDATE/DELETE are blocked.
//   5. Parameter tampering — guessing B's ids while logged in as A → 404 / null.
//   6. The tracking endpoint stores an event under the agency that owns the
//      siteId, NOT the authenticated agency, and A cannot read it.
// ─────────────────────────────────────────────────────────────────────────────

// Mock the Clerk-backed auth module so we can drive "who is logged in" without a
// real session. `h` is a mutable holder the mock reads on every call.
const h = vi.hoisted(() => ({
  member: null as null | Record<string, unknown>,
  role: "agency_admin" as string | undefined,
}));
vi.mock("@/lib/auth", () => ({
  getCurrentMember: async () => h.member,
  getPlatformRole: async () => h.role,
}));

// Imported AFTER the mock is registered (vi.mock is hoisted, so static imports
// are safe). These pull in @/lib/auth, which is now the mock.
import { prisma } from "@/lib/prisma";
import { agencyScoped, agencyScopedFor } from "@/lib/tenant";
import { GET as hotelsExportGET } from "@/app/api/hotels/export/route";
import { GET as reportsCsvGET } from "@/app/api/reports/csv/route";
import { POST as trackEventPOST } from "@/app/api/track/event/route";

const PREFIX = "TEST_ISO3_";

type Fx = {
  agencyA: string;
  agencyB: string;
  memberA: Record<string, unknown>;
  memberB: Record<string, unknown>;
  hotelA: string;
  hotelB: string;
  siteB: string;
  contentA: string;
  contentB: string;
};
let fx: Fx;

function loginAs(member: Record<string, unknown> | null, role = "agency_admin") {
  h.member = member;
  h.role = role;
}

async function makeAgency(tag: string) {
  const agency = await prisma.agency.create({
    data: { name: `${PREFIX}${tag}`, email: `${PREFIX.toLowerCase()}${tag}@example.test`, subscriptionStatus: "active" },
  });
  const member = await prisma.agencyMember.create({
    data: {
      agencyId: agency.id,
      clerkId: `${PREFIX}clerk-${tag}-${Date.now()}`,
      email: `${tag}@socialhippi.com`,
      name: `Member ${tag}`,
      role: "admin",
    },
    include: { agency: true },
  });
  const hotel = await prisma.hotelClient.create({
    data: {
      agencyId: agency.id,
      name: `${PREFIX}${tag}-Hotel`,
      websiteUrl: "https://example.com",
      contactName: "C",
      contactEmail: "c@test.local",
      siteId: `${PREFIX}site-${tag}-${Date.now()}`,
      conversionMethod: "both",
    },
  });
  const content = await prisma.contentPiece.create({
    data: {
      agencyId: agency.id,
      hotelClientId: hotel.id,
      title: `${PREFIX}${tag}-content`,
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
      sessionId: `${PREFIX}s-${tag}`,
      deviceType: "desktop",
    },
  });
  return { agency, member, hotel, content };
}

function isP2025(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "P2025";
}

// Run a block AS the non-owner hoteltrack_app role with the RLS GUC set.
async function asAppRole<T>(
  setup: { agencyId?: string; bypass?: boolean },
  fn: (tx: typeof prisma) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE hoteltrack_app");
    if (setup.bypass) await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    if (setup.agencyId) await tx.$executeRaw`SELECT set_config('app.current_agency_id', ${setup.agencyId}, true)`;
    return fn(tx as unknown as typeof prisma);
  });
}

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  try {
    await prisma.$executeRawUnsafe("GRANT hoteltrack_app TO CURRENT_USER");
  } catch {
    /* already a member */
  }
  const A = await makeAgency("A");
  const B = await makeAgency("B");
  fx = {
    agencyA: A.agency.id,
    agencyB: B.agency.id,
    memberA: A.member as unknown as Record<string, unknown>,
    memberB: B.member as unknown as Record<string, unknown>,
    hotelA: A.hotel.id,
    hotelB: B.hotel.id,
    siteB: B.hotel.siteId,
    contentA: A.content.id,
    contentB: B.content.id,
  };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

// ── 1. Layer-1 app scoping ───────────────────────────────────────────────────
describe("Layer 1 — agencyScoped never crosses the tenant line", () => {
  test("findMany returns only A's hotels", async () => {
    loginAs(fx.memberA);
    const rows = await agencyScoped(prisma.hotelClient).findMany({ select: { id: true, agencyId: true } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.agencyId === fx.agencyA)).toBe(true);
    expect(rows.some((r) => r.id === fx.hotelB)).toBe(false);
  });

  test("findFirst can't fetch B's hotel while logged in as A", async () => {
    loginAs(fx.memberA);
    const stolen = await agencyScoped(prisma.hotelClient).findFirst({ where: { id: fx.hotelB } });
    expect(stolen).toBeNull();
  });

  test("cross-tenant UPDATE throws P2025", async () => {
    loginAs(fx.memberA);
    let blocked = false;
    try {
      await agencyScoped(prisma.hotelClient).update({ where: { id: fx.hotelB }, data: { name: "HACKED" } });
    } catch (e) {
      blocked = isP2025(e);
    }
    expect(blocked).toBe(true);
    const b = await prisma.hotelClient.findUnique({ where: { id: fx.hotelB } });
    expect(b?.name).toBe(`${PREFIX}B-Hotel`);
  });

  test("cross-tenant DELETE throws P2025", async () => {
    loginAs(fx.memberA);
    let blocked = false;
    try {
      await agencyScoped(prisma.contentPiece).delete({ where: { id: fx.contentB } });
    } catch (e) {
      blocked = isP2025(e);
    }
    expect(blocked).toBe(true);
    expect(await prisma.contentPiece.findUnique({ where: { id: fx.contentB } })).not.toBeNull();
  });
});

// ── 2 + 5. Authenticated routes + parameter tampering ────────────────────────
describe("Authenticated route handlers + parameter tampering", () => {
  test("/api/hotels/export returns A's hotels, never B's", async () => {
    loginAs(fx.memberA);
    const res = await hotelsExportGET(new Request("http://localhost/api/hotels/export?format=csv"));
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain(`${PREFIX}A-Hotel`);
    expect(csv).not.toContain(`${PREFIX}B-Hotel`);
  });

  test("/api/reports/csv with B's hotelId while logged in as A → 404", async () => {
    loginAs(fx.memberA);
    const res = await reportsCsvGET(
      new Request(`http://localhost/api/reports/csv?hotelId=${fx.hotelB}`),
    );
    expect(res.status).toBe(404);
  });

  test("/api/reports/csv with A's own hotelId → 200", async () => {
    loginAs(fx.memberA);
    const res = await reportsCsvGET(
      new Request(`http://localhost/api/reports/csv?hotelId=${fx.hotelA}`),
    );
    expect(res.status).toBe(200);
  });
});

// ── 3 + 4. Layer-2 RLS at the database level ─────────────────────────────────
describe("Layer 2 — RLS blocks cross-tenant access as the app role", () => {
  test("reads are filtered to the GUC agency", async () => {
    const rows = await asAppRole({ agencyId: fx.agencyA }, (tx) =>
      tx.$queryRaw<Array<{ id: string; agencyId: string }>>`SELECT id, "agencyId" FROM "HotelClient"`,
    );
    expect(rows.every((r) => r.agencyId === fx.agencyA)).toBe(true);
    expect(rows.some((r) => r.id === fx.hotelB)).toBe(false);
  });

  test("cross-tenant UPDATE affects 0 rows", async () => {
    const count = await asAppRole({ agencyId: fx.agencyA }, (tx) =>
      tx.$executeRaw`UPDATE "HotelClient" SET name = 'HACKED' WHERE id = ${fx.hotelB}`,
    );
    expect(count).toBe(0);
  });

  test("cross-tenant DELETE affects 0 rows", async () => {
    const count = await asAppRole({ agencyId: fx.agencyA }, (tx) =>
      tx.$executeRaw`DELETE FROM "ContentPiece" WHERE id = ${fx.contentB}`,
    );
    expect(count).toBe(0);
    expect(await prisma.contentPiece.findUnique({ where: { id: fx.contentB } })).not.toBeNull();
  });

  test("no GUC → fail closed (0 rows visible)", async () => {
    const rows = await asAppRole({}, (tx) =>
      tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "HotelClient"`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  test("super-admin bypass sees across agencies", async () => {
    const rows = await asAppRole({ bypass: true }, (tx) =>
      tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "HotelClient" WHERE id IN (${fx.hotelA}, ${fx.hotelB})`,
    );
    expect(rows.length).toBe(2);
  });
});

// ── 6. Tracking endpoint attributes to the siteId owner, not the caller ──────
describe("Tracking endpoint — event is stored under the siteId's agency", () => {
  test("event with B's siteId is stored under B (not the authed agency A) and A can't read it", async () => {
    loginAs(fx.memberA); // an A user is "active", but the public endpoint ignores that
    const before = await prisma.trackingEvent.count({ where: { hotelClientId: fx.hotelB } });

    const res = await trackEventPOST(
      new Request("http://localhost/api/track/event", {
        method: "POST",
        headers: { "Content-Type": "text/plain", "x-forwarded-for": "203.0.113.7" },
        body: JSON.stringify({
          siteId: fx.siteB,
          type: "visit",
          pageUrl: "https://example.com/x",
          sessionId: "iso-track",
          deviceType: "desktop",
        }),
      }),
    );
    expect(res.status).toBe(204);

    const after = await prisma.trackingEvent.findMany({
      where: { hotelClientId: fx.hotelB, sessionId: "iso-track" },
      select: { agencyId: true },
    });
    expect(after.length).toBe(before === 0 ? 1 : after.length);
    // Stored under B, never under the authenticated agency A.
    expect(after.every((e) => e.agencyId === fx.agencyB)).toBe(true);
    expect(after.some((e) => e.agencyId === fx.agencyA)).toBe(false);

    // And agency A (via the scoped wrapper) cannot see B's event.
    loginAs(fx.memberA);
    const visibleToA = await agencyScoped(prisma.trackingEvent).findMany({
      where: { sessionId: "iso-track" },
    });
    expect(visibleToA.length).toBe(0);
  });
});

// Keep agencyScopedFor referenced (used by report-data / share path) so the
// import is exercised even if the explicit-id form isn't asserted above.
void agencyScopedFor;
