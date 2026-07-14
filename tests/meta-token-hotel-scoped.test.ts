import "dotenv/config";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// MetaToken is HOTEL-scoped (one per hotel, @@unique([hotelClientId])). This
// suite proves, against a real database with two agencies:
//   1. Saving a token for Hotel A1 stamps A1's hotelClientId.
//   2. Saving a token for Hotel A2 does NOT overwrite A1 — both coexist.
//   3. A second token for the SAME hotel violates the unique constraint.
//   4. Disconnecting A1's token leaves A2's untouched.
//   5. Cross-agency isolation: agency B can't read or mutate A1's token.
//   6. A hotel with no token reads as metaState "not_connected" (no zeros).
//   7. The cron's hotel-filter only selects hotels whose own token is connected;
//      a broken (expired) token is excluded while connected siblings remain.
// ─────────────────────────────────────────────────────────────────────────────

// Mock the Clerk-backed auth module so we can drive "who is logged in".
const h = vi.hoisted(() => ({
  member: null as null | Record<string, unknown>,
  role: "agency_admin" as string | undefined,
}));
vi.mock("@/lib/auth", () => ({
  getCurrentMember: async () => h.member,
  getPlatformRole: async () => h.role,
}));

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { metaState } from "@/lib/integration-status";

const PREFIX = "TEST_MTHS_";

function loginAs(member: Record<string, unknown> | null, role = "agency_admin") {
  h.member = member;
  h.role = role;
}

function isP2025(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "P2025";
}

async function makeAgency(tag: string) {
  const agency = await prisma.agency.create({
    data: {
      name: `${PREFIX}${tag}`,
      email: `${PREFIX.toLowerCase()}${tag}@example.test`,
      subscriptionStatus: "active",
    },
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
  return { agency, member };
}

async function makeHotel(agencyId: string, tag: string) {
  return prisma.hotelClient.create({
    data: {
      agencyId,
      name: `${PREFIX}${tag}-Hotel`,
      websiteUrl: "https://example.com",
      contactName: "C",
      contactEmail: "c@test.local",
      siteId: `${PREFIX}site-${tag}-${Date.now()}-${Math.round(performance.now())}`,
      conversionMethod: "both",
      metaAdAccountId: `act_${tag}`,
    },
  });
}

const FUTURE = new Date(Date.now() + 60 * 86_400_000);

async function connectToken(agencyId: string, hotelClientId: string) {
  return prisma.metaToken.create({
    data: {
      agencyId,
      hotelClientId,
      encryptedToken: `ciphertext-${hotelClientId}`,
      tokenExpiresAt: FUTURE,
      status: "connected",
    },
  });
}

type Fx = {
  agencyA: string;
  agencyB: string;
  memberA: Record<string, unknown>;
  memberB: Record<string, unknown>;
  hotelA1: string;
  hotelA2: string;
  hotelB1: string;
};
let fx: Fx;

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const A = await makeAgency("A");
  const B = await makeAgency("B");
  const a1 = await makeHotel(A.agency.id, "A1");
  const a2 = await makeHotel(A.agency.id, "A2");
  const b1 = await makeHotel(B.agency.id, "B1");
  fx = {
    agencyA: A.agency.id,
    agencyB: B.agency.id,
    memberA: A.member as unknown as Record<string, unknown>,
    memberB: B.member as unknown as Record<string, unknown>,
    hotelA1: a1.id,
    hotelA2: a2.id,
    hotelB1: b1.id,
  };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe("MetaToken is hotel-scoped", () => {
  test("saving a token for A1 stamps A1's hotelClientId", async () => {
    const t = await connectToken(fx.agencyA, fx.hotelA1);
    expect(t.hotelClientId).toBe(fx.hotelA1);
    expect(t.agencyId).toBe(fx.agencyA);
  });

  test("saving a token for A2 does NOT overwrite A1 — both coexist", async () => {
    await connectToken(fx.agencyA, fx.hotelA2);
    const rows = await prisma.metaToken.findMany({
      where: { hotelClientId: { in: [fx.hotelA1, fx.hotelA2] } },
      select: { hotelClientId: true, status: true },
    });
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.hotelClientId))).toEqual(
      new Set([fx.hotelA1, fx.hotelA2]),
    );
    expect(rows.every((r) => r.status === "connected")).toBe(true);
  });

  test("a second token for the SAME hotel violates the unique constraint", async () => {
    let violated = false;
    try {
      await connectToken(fx.agencyA, fx.hotelA1); // A1 already has one
    } catch (e) {
      violated = (e as { code?: string }).code === "P2002";
    }
    expect(violated).toBe(true);
  });

  test("disconnecting A1's token leaves A2's untouched", async () => {
    loginAs(fx.memberA);
    // Disconnect A1 the same way the server action does (scoped, by hotel).
    const a1 = await agencyScoped(prisma.metaToken).findFirst({
      where: { hotelClientId: fx.hotelA1 },
      select: { id: true },
    });
    await agencyScoped(prisma.metaToken).update({
      where: { id: a1!.id },
      data: { status: "disconnected", disconnectedAt: new Date() },
    });

    const a1After = await prisma.metaToken.findUnique({ where: { hotelClientId: fx.hotelA1 } });
    const a2After = await prisma.metaToken.findUnique({ where: { hotelClientId: fx.hotelA2 } });
    expect(a1After?.status).toBe("disconnected");
    expect(a2After?.status).toBe("connected"); // unaffected
  });
});

describe("Cross-agency isolation", () => {
  test("agency B cannot read A1's token via the scoped wrapper", async () => {
    loginAs(fx.memberB);
    const stolen = await agencyScoped(prisma.metaToken).findFirst({
      where: { hotelClientId: fx.hotelA1 },
    });
    expect(stolen).toBeNull();
  });

  test("agency B's scoped UPDATE of A2's token throws P2025", async () => {
    loginAs(fx.memberB);
    const a2 = await prisma.metaToken.findUnique({
      where: { hotelClientId: fx.hotelA2 },
      select: { id: true },
    });
    let blocked = false;
    try {
      await agencyScoped(prisma.metaToken).update({
        where: { id: a2!.id },
        data: { status: "disconnected" },
      });
    } catch (e) {
      blocked = isP2025(e);
    }
    expect(blocked).toBe(true);
    const still = await prisma.metaToken.findUnique({ where: { hotelClientId: fx.hotelA2 } });
    expect(still?.status).toBe("connected"); // B couldn't touch A's token
  });
});

describe("Disconnected / missing token surfaces as not_connected", () => {
  test("metaState(null) is not_connected (a hotel with no token shows no data)", () => {
    expect(metaState(null, new Date())).toBe("not_connected");
  });

  test("a connected, non-expired token reads as connected", () => {
    expect(metaState({ status: "connected", tokenExpiresAt: FUTURE }, new Date())).toBe(
      "connected",
    );
  });
});

describe("Cron hotel-filter only selects hotels with a connected token", () => {
  test("expired/disconnected/no-token hotels are excluded; connected siblings remain", async () => {
    // State after the tests above: A1 = disconnected, A2 = connected, B1 = no token.
    // Mark A1 expired to also cover the broken-token case.
    await prisma.metaToken.update({
      where: { hotelClientId: fx.hotelA1 },
      data: { status: "expired" },
    });

    // The exact filter the cron (/api/meta/sync) and backfill use.
    const syncable = await prisma.hotelClient.findMany({
      where: {
        agencyId: fx.agencyA,
        metaAdAccountId: { not: null },
        deletedAt: null,
        metaToken: { is: { status: "connected" } },
      },
      select: { id: true },
    });
    const ids = new Set(syncable.map((s) => s.id));
    expect(ids.has(fx.hotelA2)).toBe(true); // connected → synced
    expect(ids.has(fx.hotelA1)).toBe(false); // expired → skipped, not synced
    expect(ids.has(fx.hotelB1)).toBe(false); // no token → skipped cleanly
  });
});
