import "dotenv/config";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant-scope";
import { loadAgencyRevenueRows } from "@/lib/agency-revenue";
import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES MUST NOT REACH A CLIENT-FACING AGGREGATE.
//
// Seed and demo rows live in the production database — "Test Agency",
// "HotelTrack Test Resort", "Test Hotel". A fixture hotel sitting inside a REAL
// agency contaminates that agency's revenue, its savings and its hotel picker.
//
// The filter is in the tenant wrapper, not at the call sites, for the same
// reason the soft-delete default is: there are a dozen such queries, the next
// one has not been written yet, and a rule applied per-call-site is a rule
// someone forgets. These tests pin the wrapper, then confirm the highest-value
// rollup inherits it.
// ─────────────────────────────────────────────────────────────────────────────

const PREFIX = "TEST_FIX_";
let agencyId: string;
let realHotelId: string;
let fixtureHotelId: string;

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const agency = await prisma.agency.create({
    data: {
      name: `${PREFIX}Agency`,
      email: `${PREFIX.toLowerCase()}a@x.test`,
      subscriptionStatus: "active",
    },
  });
  agencyId = agency.id;

  const mk = (tag: string, isFixture: boolean) =>
    prisma.hotelClient.create({
      data: {
        agencyId,
        name: `${PREFIX}${tag}`,
        websiteUrl: `https://${tag.toLowerCase()}.example`,
        contactName: "C",
        contactEmail: "c@t.local",
        siteId: `${PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conversionMethod: "url_change",
        isFixture,
      },
    });

  realHotelId = (await mk("Real", false)).id;
  fixtureHotelId = (await mk("Fixture", true)).id;
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe("1. the wrapper excludes fixtures from every read", () => {
  const scoped = () => agencyScopedFor(agencyId, prisma.hotelClient);

  test("findMany omits the fixture hotel", async () => {
    const rows = await scoped().findMany({ select: { id: true } });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(realHotelId);
    expect(ids).not.toContain(fixtureHotelId);
  });

  test("count omits it too — a rollup denominator must match its rows", async () => {
    expect(await scoped().count()).toBe(1);
  });

  test("findFirst cannot reach it by id", async () => {
    expect(await scoped().findFirst({ where: { id: fixtureHotelId } })).toBeNull();
    expect(await scoped().findFirst({ where: { id: realHotelId } })).not.toBeNull();
  });

  test("groupBy and aggregate are filtered as well", async () => {
    const grouped = await scoped().groupBy({ by: ["agencyId"], _count: { _all: true } });
    expect(grouped[0]?._count._all).toBe(1);
  });
});

describe("2. the escape hatch is explicit and does not leak", () => {
  test("includeFixtures: true returns them, for the admin surface", async () => {
    // `includeFixtures` is a wrapper-only flag, stripped before the args reach
    // Prisma, so it is not in Prisma's arg type. Cast the CALL, not the args —
    // `as never` on the args collapses the return type to never[].
    const findMany = agencyScopedFor(agencyId, prisma.hotelClient).findMany as unknown as (
      a: Record<string, unknown>,
    ) => Promise<{ id: string }[]>;
    const rows = await findMany({ includeFixtures: true, select: { id: true } });
    expect(rows.map((r) => r.id)).toContain(fixtureHotelId);
  });

  test("a caller constraining isFixture itself is respected", async () => {
    const rows = await agencyScopedFor(agencyId, prisma.hotelClient).findMany({
      where: { isFixture: true },
      select: { id: true },
    });
    expect(rows.map((r) => r.id)).toEqual([fixtureHotelId]);
  });

  test("the flag never reaches Prisma as a column", async () => {
    // If `includeFixtures` were passed through it would throw an unknown-arg
    // error rather than returning rows.
    await expect(
      (agencyScopedFor(agencyId, prisma.hotelClient).count as unknown as (
        a: Record<string, unknown>,
      ) => Promise<number>)({ includeFixtures: true }),
    ).resolves.toBe(2);
  });
});

describe("3. the client-facing rollup inherits it", () => {
  test("agency revenue rows cover the real hotel only", async () => {
    const { hotelIds, hotelNames } = await loadAgencyRevenueRows(agencyId, {
      start: new Date("2020-01-01T00:00:00.000Z"),
      end: new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(hotelIds).toContain(realHotelId);
    expect(hotelIds).not.toContain(fixtureHotelId);
    expect([...hotelNames.values()].some((n) => n.endsWith("Fixture"))).toBe(false);
  });
});

describe("4. agencies are never resolved by a non-unique name", () => {
  // Two live tenants deliberately share the name "Social Hippi", so any lookup
  // keyed on name is ambiguous. Both remaining call sites must REFUSE rather
  // than silently pick — one of them deletes data.
  test("attach-member refuses an ambiguous name instead of guessing", () => {
    const src = readCode("scripts/attach-member.ts");
    expect(src).toContain("prisma.agency.findMany");
    expect(src).not.toMatch(/agency\s*=\s*await prisma\.agency\.findFirst/);
    expect(src).toMatch(/matches\.length > 1/);
  });

  test("the destructive cleanup script does not resolve an agency by name at all", () => {
    // Stronger than refusing an ambiguous name: it no longer looks a target up
    // by name in any form, and takes an explicit id instead.
    const src = readCode("scripts/cleanup-demo-data.ts");
    expect(src).not.toMatch(/prisma\.agency\.(findFirst|findMany)/);
    expect(src).toContain("prisma.agency.findUnique");
    expect(src).toContain("--agency-id");
  });
});
