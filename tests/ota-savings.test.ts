import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// OTA commission savings. Pure calculateSavings edge cases + the per-hotel and
// agency-wide savings routes against a live DB: correct sums, per-hotel rates,
// tenant isolation, soft-deleted exclusion, period boundaries, and the 12-month
// zero-filled trend. Requires the 20260613000000_add_ota_commission_rate migration.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ member: null as null | Record<string, unknown>, role: "agency_admin" as string | undefined }));
vi.mock("@/lib/auth", () => ({ getCurrentMember: async () => h.member, getPlatformRole: async () => h.role }));

import { prisma } from "@/lib/prisma";
import { calculateSavings } from "@/lib/savings";
import { GET as hotelSavingsGET } from "@/app/api/agency/hotels/[hotelId]/savings/route";
import { GET as agencySavingsGET } from "@/app/api/agency/savings/route";

const PREFIX = "TEST_OTA_";
const loginAs = (m: Record<string, unknown> | null) => { h.member = m; };
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

function hotelSavings(hotelId: string, query = "") {
  return hotelSavingsGET(new Request(`http://localhost/api/agency/hotels/${hotelId}/savings?${query}`), { params: Promise.resolve({ hotelId }) });
}
function agencySavings(query = "") {
  return agencySavingsGET(new Request(`http://localhost/api/agency/savings?${query}`));
}
function conv(agencyId: string, hotelId: string, value: number, when = daysAgo(5)) {
  return prisma.trackingEvent.create({
    data: { agencyId, hotelClientId: hotelId, eventType: "conversion", pageUrl: "https://h/thx", conversionValue: value.toFixed(2), sessionId: `s_${randomUUID()}`, deviceType: "desktop", createdAt: when },
  });
}

type Fx = {
  agencyA: string; memberA: Record<string, unknown>; memberB: Record<string, unknown>;
  hotelA1: string; hotelA2: string; hotelDel: string; hotelBoundary: string; hotelB1: string;
};
let fx: Fx;

async function mkAgency(t: string) { return prisma.agency.create({ data: { name: `${PREFIX}${t}`, email: `${PREFIX.toLowerCase()}${t}@x.test`, subscriptionStatus: "active" } }); }
async function mkMember(a: string, t: string) { return prisma.agencyMember.create({ data: { agencyId: a, clerkId: `${PREFIX}c-${t}-${Date.now()}-${Math.round(performance.now())}`, email: `${t}@socialhippi.com`, name: t, role: "admin" } }); }
async function mkHotel(a: string, t: string, rate: number | null, deleted = false) {
  return prisma.hotelClient.create({ data: { agencyId: a, name: `${PREFIX}${t}`, websiteUrl: "https://h.example", contactName: "C", contactEmail: "c@t.local", siteId: `${PREFIX}s-${t}-${Date.now()}-${Math.round(performance.now())}`, conversionMethod: "both", otaCommissionRate: rate, ...(deleted ? { deletedAt: new Date() } : {}) } });
}

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const A = await mkAgency("A"), B = await mkAgency("B");
  const mA = await mkMember(A.id, "A"), mB = await mkMember(B.id, "B");
  const a1 = await mkHotel(A.id, "A1", 18), a2 = await mkHotel(A.id, "A2", 22), del = await mkHotel(A.id, "Del", 18, true), bnd = await mkHotel(A.id, "Bnd", 10), b1 = await mkHotel(B.id, "B1", 18);

  await conv(A.id, a1.id, 100000); // savings @18% = 18,000
  await conv(A.id, a2.id, 50000);  // savings @22% = 11,000
  await conv(A.id, del.id, 99000); // soft-deleted → excluded
  await conv(B.id, b1.id, 77000);  // other agency → excluded
  // Boundary booking at noon on a fixed day (outside the default 30-day window,
  // so it only surfaces in its own narrow-day query) for the period-edge test.
  await conv(A.id, bnd.id, 20000, new Date(Date.UTC(2026, 4, 4, 12, 0, 0)));

  fx = { agencyA: A.id, memberA: mA as unknown as Record<string, unknown>, memberB: mB as unknown as Record<string, unknown>, hotelA1: a1.id, hotelA2: a2.id, hotelDel: del.id, hotelBoundary: bnd.id, hotelB1: b1.id };
});

afterAll(async () => { await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } }); await prisma.$disconnect(); });

describe("calculateSavings (pure)", () => {
  test("edge cases", () => {
    expect(calculateSavings(null, 18)).toBe(0);
    expect(calculateSavings(1000, null)).toBe(0);
    expect(calculateSavings(1000, 0)).toBe(0);     // 0% → disabled
    expect(calculateSavings(0, 18)).toBe(0);
    expect(calculateSavings(-500, 18)).toBe(0);
    expect(calculateSavings(100000, 18)).toBe(18000);
    expect(calculateSavings(50000, 22)).toBe(11000);
    expect(calculateSavings(1_000_000_000_000, 18)).toBe(180_000_000_000); // very large
  });
});

describe("per-hotel savings endpoint", () => {
  test("returns the correct sum + rate, and a 12-month zero-filled trend", async () => {
    loginAs(fx.memberA);
    const res = await hotelSavings(fx.hotelA1);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.otaRateUsed).toBe(18);
    expect(body.totalRevenue).toBe(100000);
    expect(body.totalSavings).toBe(18000);
    expect(body.bookingCount).toBe(1);
    expect(body.monthlyTrend.length).toBe(12);
    expect(body.monthlyTrend.some((m: { savings: number }) => m.savings === 0)).toBe(true); // zero-filled months
    expect(body.monthlyTrend.reduce((s: number, m: { savings: number }) => s + m.savings, 0)).toBe(18000);
  });

  test("a booking on the last day of the period counts", async () => {
    loginAs(fx.memberA);
    const body = await (await hotelSavings(fx.hotelBoundary, "startDate=2026-05-04&endDate=2026-05-04")).json();
    expect(body.bookingCount).toBe(1);
    expect(body.totalSavings).toBe(2000); // 20,000 × 10%
  });

  test("another agency's hotel returns 404", async () => {
    loginAs(fx.memberB);
    expect((await hotelSavings(fx.hotelA1)).status).toBe(404);
  });

  test("unauthenticated is rejected", async () => {
    loginAs(null);
    expect((await hotelSavings(fx.hotelA1)).status).toBe(401);
  });
});

describe("agency savings endpoint", () => {
  test("sums across all hotels at each hotel's OWN rate; excludes other agencies + soft-deleted", async () => {
    loginAs(fx.memberA);
    const body = await (await agencySavings()).json();
    // 18,000 (A1@18%) + 11,000 (A2@22%) = 29,000. Not 99k (deleted) or 77k (agency B).
    expect(body.totalSavings).toBe(29000);
    expect(body.bookingCount).toBe(2);
    expect(body.activeHotelsCount).toBe(2);
    expect(body.totalHotelsCount).toBe(3); // A1, A2, Boundary (non-deleted); Boundary has no booking in last 30d
    const byHotel = Object.fromEntries(body.hotelBreakdown.map((x: { hotelId: string; savings: number }) => [x.hotelId, x.savings]));
    expect(byHotel[fx.hotelA1]).toBe(18000);
    expect(byHotel[fx.hotelA2]).toBe(11000);
    expect(byHotel[fx.hotelDel]).toBeUndefined();
    expect(byHotel[fx.hotelB1]).toBeUndefined();
    // Sorted by savings desc.
    expect(body.hotelBreakdown[0].hotelId).toBe(fx.hotelA1);
    expect(body.monthlyTrend.length).toBe(12);
  });

  test("agency B sees only its own savings", async () => {
    loginAs(fx.memberB);
    const body = await (await agencySavings()).json();
    expect(body.totalSavings).toBe(77000 * 0.18); // 13,860
  });
});
