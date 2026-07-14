import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Agency revenue rollup (Phase R3). Drives the agency-wide revenue-by-source,
// drill-down, and overview routes against a live DB. Covers tenant scoping,
// hotelFilter cross-agency exclusion, soft-deleted exclusion, period-over-period,
// ROAS divide-by-zero, the empty-agency state, and the drill-down breakdown.
//
// Requires the 20260612190000_add_agency_revenue_index migration applied.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ member: null as null | Record<string, unknown>, role: "agency_admin" as string | undefined }));
vi.mock("@/lib/auth", () => ({ getCurrentMember: async () => h.member, getPlatformRole: async () => h.role }));

import { prisma } from "@/lib/prisma";
import { GET as rbsGET } from "@/app/api/agency/revenue-by-source/route";
import { GET as overviewGET } from "@/app/api/agency/overview/route";
import { GET as drillGET } from "@/app/api/agency/revenue-by-source/[sourceKey]/hotels/route";

const PREFIX = "TEST_AGG_";
const loginAs = (m: Record<string, unknown> | null) => { h.member = m; };
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

function rbs(query = "") { return rbsGET(new Request(`http://localhost/api/agency/revenue-by-source?${query}`)); }
function overview(query = "") { return overviewGET(new Request(`http://localhost/api/agency/overview?${query}`)); }
function drill(sourceKey: string, query = "") {
  return drillGET(new Request(`http://localhost/api/agency/revenue-by-source/${sourceKey}/hotels?${query}`), { params: Promise.resolve({ sourceKey }) });
}

function conv(agencyId: string, hotelId: string, source: string | null, value: number, when = daysAgo(5)) {
  return prisma.trackingEvent.create({
    data: {
      agencyId, hotelClientId: hotelId, eventType: "conversion",
      utmSource: source, utmMedium: source ? "reel" : null,
      pageUrl: "https://h/thank-you", conversionValue: value.toFixed(2),
      sessionId: `s_${randomUUID()}`, deviceType: "desktop", createdAt: when,
    },
  });
}

type Fx = {
  agencyA: string; agencyB: string; agencyC: string;
  memberA: Record<string, unknown>; memberB: Record<string, unknown>; memberC: Record<string, unknown>;
  hotelA1: string; hotelA2: string; hotelADeleted: string; hotelB1: string;
};
let fx: Fx;

async function makeAgency(tag: string) { return prisma.agency.create({ data: { name: `${PREFIX}${tag}`, email: `${PREFIX.toLowerCase()}${tag}@x.test`, subscriptionStatus: "active" } }); }
async function makeMember(agencyId: string, tag: string) { return prisma.agencyMember.create({ data: { agencyId, clerkId: `${PREFIX}clerk-${tag}-${Date.now()}-${Math.round(performance.now())}`, email: `${tag}@socialhippi.com`, name: `M ${tag}`, role: "admin" } }); }
async function makeHotel(agencyId: string, tag: string, deleted = false) {
  return prisma.hotelClient.create({ data: { agencyId, name: `${PREFIX}${tag}`, websiteUrl: "https://h.example", contactName: "C", contactEmail: "c@t.local", siteId: `${PREFIX}site-${tag}-${Date.now()}-${Math.round(performance.now())}`, conversionMethod: "both", ...(deleted ? { deletedAt: new Date() } : {}) } });
}

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const A = await makeAgency("A"), B = await makeAgency("B"), C = await makeAgency("C");
  const mA = await makeMember(A.id, "A"), mB = await makeMember(B.id, "B"), mC = await makeMember(C.id, "C");
  const hA1 = await makeHotel(A.id, "A1"), hA2 = await makeHotel(A.id, "A2"), hADel = await makeHotel(A.id, "ADel", true), hB1 = await makeHotel(B.id, "B1");

  // Current period (5 days ago): A1 instagram 50k + google 20k; A2 instagram 30k.
  await conv(A.id, hA1.id, "instagram", 50000);
  await conv(A.id, hA1.id, "google", 20000);
  await conv(A.id, hA2.id, "instagram", 30000);
  // Excluded: soft-deleted hotel + another agency.
  await conv(A.id, hADel.id, "instagram", 99000);
  await conv(B.id, hB1.id, "instagram", 77000);
  // Previous period (40 days ago): A1 40k — for period-over-period.
  await conv(A.id, hA1.id, "instagram", 40000, daysAgo(40));

  fx = {
    agencyA: A.id, agencyB: B.id, agencyC: C.id,
    memberA: mA as unknown as Record<string, unknown>, memberB: mB as unknown as Record<string, unknown>, memberC: mC as unknown as Record<string, unknown>,
    hotelA1: hA1.id, hotelA2: hA2.id, hotelADeleted: hADel.id, hotelB1: hB1.id,
  };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe("agency revenue-by-source (Part 2/9)", () => {
  test("returns only this agency's hotels' data; soft-deleted + other agencies excluded", async () => {
    loginAs(fx.memberA);
    const body = await (await rbs("granularity=source")).json();
    expect(body.totals.revenue).toBe(100000); // 50k+20k+30k — not 99k (deleted) or 77k (agency B)
    const bySource = Object.fromEntries(body.groups.map((g: { key: string; revenue: number }) => [g.key, g.revenue]));
    expect(bySource.instagram).toBe(80000); // A1 50k + A2 30k
    expect(bySource.google).toBe(20000);
    const insta = body.groups.find((g: { key: string }) => g.key === "instagram");
    expect(insta.hotelCount).toBe(2); // two hotels contributed instagram
    expect(body.totals.activeHotels).toBe(2);
    expect(body.totals.hotelCount).toBe(2); // 2 non-deleted hotels in scope (the deleted one is excluded)
  });

  test("hotelFilter naming another agency's hotel is silently excluded (not 403)", async () => {
    loginAs(fx.memberA);
    const res = await rbs(`granularity=source&hotel=${fx.hotelB1}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totals.revenue).toBe(0); // B's hotel filtered out at the DB level
  });

  test("hotelFilter restricts to the chosen hotel", async () => {
    loginAs(fx.memberA);
    const body = await (await rbs(`granularity=source&hotel=${fx.hotelA1}`)).json();
    expect(body.totals.revenue).toBe(70000); // A1 only: 50k instagram + 20k google
  });

  test("agency B sees only its own revenue", async () => {
    loginAs(fx.memberB);
    const body = await (await rbs("granularity=source")).json();
    expect(body.totals.revenue).toBe(77000);
  });
});

describe("agency overview (Part 4/9)", () => {
  test("period-over-period growth, ROAS divide-by-zero, active/total hotels, top source/hotel", async () => {
    loginAs(fx.memberA);
    const body = await (await overview()).json();
    expect(body.totalRevenue).toBe(100000);
    expect(body.totalBookings).toBe(3);
    expect(body.roas).toBeNull(); // no ad spend in period → divide-by-zero safe
    expect(body.activeHotelsCount).toBe(2);
    expect(body.totalHotelsCount).toBe(2); // A1 + A2; excludes the soft-deleted hotel
    // PoP: current 100k vs previous 40k = +150%.
    expect(body.periodOverPeriodGrowth).toBeCloseTo(150, 1);
    expect(body.topSource.key).toBe("instagram");
    expect(body.topSource.revenue).toBe(80000);
    expect(body.topHotel.hotelClientId).toBe(fx.hotelA1); // 70k, the biggest
    expect(body.hotels.length).toBe(2);
    expect(body.hotels[0].hotelClientId).toBe(fx.hotelA1);
  });

  test("empty agency returns a valid empty state, not an error", async () => {
    loginAs(fx.memberC);
    const res = await overview();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalRevenue).toBe(0);
    expect(body.totalHotelsCount).toBe(0);
    expect(body.roas).toBeNull();
    expect(body.hotels).toEqual([]);
    expect(body.periodOverPeriodGrowth).toBeNull();

    const rbsBody = await (await rbs("granularity=source")).json();
    expect(rbsBody.groups).toEqual([]);
    expect(rbsBody.totals.revenue).toBe(0);
  });
});

describe("source drill-down (Part 3/9)", () => {
  test("instagram drill-down lists both contributing hotels, sorted by revenue", async () => {
    loginAs(fx.memberA);
    const body = await (await drill("instagram")).json();
    expect(body.total.revenue).toBe(80000);
    expect(body.hotels.length).toBe(2);
    expect(body.hotels[0].hotelClientId).toBe(fx.hotelA1); // 50k first
    expect(body.hotels[0].revenue).toBe(50000);
    expect(body.hotels[0].percentOfSource).toBeCloseTo(62.5, 1);
    expect(body.hotels[1].revenue).toBe(30000);
    // Agency B's instagram booking never appears.
    expect(body.hotels.some((x: { hotelClientId: string }) => x.hotelClientId === fx.hotelB1)).toBe(false);
  });

  test("unauthenticated is rejected", async () => {
    loginAs(null);
    expect((await rbs()).status).toBe(401);
    expect((await overview()).status).toBe(401);
  });
});
