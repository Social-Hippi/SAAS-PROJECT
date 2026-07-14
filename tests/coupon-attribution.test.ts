import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Influencer coupon attribution (Phase R2). Drives the real ingestion route, the
// manual-redemption API route, the revenue-by-source route, and the
// loadInfluencerPerformance loader against a live DB. Covers tenant isolation,
// snippet auto-capture (valid / invalid / expired), manual entry (role + 404),
// double-counting prevention, and archived-influencer visibility.
//
// Requires the 20260612180000_add_coupon_attribution migration applied.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ member: null as null | Record<string, unknown>, role: "agency_admin" as string | undefined }));
vi.mock("@/lib/auth", () => ({
  getCurrentMember: async () => h.member,
  getPlatformRole: async () => h.role,
}));

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { POST as trackPOST } from "@/app/api/track/event/route";
import { POST as redemptionsPOST } from "@/app/api/agency/hotels/[hotelId]/redemptions/route";
import { GET as rbsGET } from "@/app/api/agency/hotels/[hotelId]/revenue-by-source/route";
import { loadInfluencerPerformance } from "@/lib/influencer-dashboard";

const PREFIX = "TEST_CPN_";
const loginAs = (m: Record<string, unknown> | null, role = "agency_admin") => { h.member = m; h.role = role; };
const sess = () => `sess_${randomUUID()}`;
const vis = () => `vis_${randomUUID()}`;

function postConversion(siteId: string, o: { coupon?: string; value: number; utmSource?: string; utmMedium?: string }) {
  return trackPOST(
    new Request("http://localhost/api/track/event", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({
        siteId, type: "conversion", v: "2.3.0", sessionId: sess(), visitorId: vis(),
        pageUrl: "https://hotel.example/thank-you", value: o.value,
        couponCodeUsed: o.coupon, utmSource: o.utmSource, utmMedium: o.utmMedium,
      }),
    }),
  );
}
function redeem(hotelId: string, body: Record<string, unknown>) {
  return redemptionsPOST(
    new Request(`http://localhost/api/agency/hotels/${hotelId}/redemptions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ hotelId }) },
  );
}
function rbs(hotelId: string, query = "") {
  return rbsGET(new Request(`http://localhost/api/agency/hotels/${hotelId}/revenue-by-source?${query}`), {
    params: Promise.resolve({ hotelId }),
  });
}

type Fx = {
  agencyA: string; agencyB: string;
  adminA: Record<string, unknown>; analystA: Record<string, unknown>; adminB: Record<string, unknown>;
  hotelA1: string; siteA1: string; hotelA2: string; siteA2: string; hotelRev: string; siteRev: string; hotelB1: string;
  priyaId: string; priya10Id: string; oldCodeId: string;
};
let fx: Fx;

async function makeAgency(tag: string) {
  const agency = await prisma.agency.create({ data: { name: `${PREFIX}${tag}`, email: `${PREFIX.toLowerCase()}${tag}@x.test`, subscriptionStatus: "active" } });
  return agency;
}
async function makeMember(agencyId: string, tag: string, role: "admin" | "analyst") {
  return prisma.agencyMember.create({ data: { agencyId, clerkId: `${PREFIX}clerk-${tag}-${Date.now()}-${Math.round(performance.now())}`, email: `${tag}@socialhippi.com`, name: `M ${tag}`, role } });
}
async function makeHotel(agencyId: string, tag: string) {
  return prisma.hotelClient.create({
    data: { agencyId, name: `${PREFIX}${tag}`, websiteUrl: "https://hotel.example", contactName: "C", contactEmail: "c@test.local", siteId: `${PREFIX}site-${tag}-${Date.now()}-${Math.round(performance.now())}`, conversionMethod: "both" },
  });
}

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const A = await makeAgency("A");
  const B = await makeAgency("B");
  const adminA = await makeMember(A.id, "adminA", "admin");
  const analystA = await makeMember(A.id, "analystA", "analyst");
  const adminB = await makeMember(B.id, "adminB", "admin");
  const hotelA1 = await makeHotel(A.id, "A1");
  const hotelA2 = await makeHotel(A.id, "A2");
  const hotelRev = await makeHotel(A.id, "Rev");
  const hotelB1 = await makeHotel(B.id, "B1");

  const priya = await prisma.influencer.create({ data: { agencyId: A.id, hotelClientId: hotelA1.id, name: "Priya Sharma", instagramHandle: "priya" } });
  const priya10 = await prisma.couponCode.create({ data: { agencyId: A.id, hotelClientId: hotelA1.id, influencerId: priya.id, code: "PRIYA10", status: "ACTIVE", discountType: "percentage", discountValue: "10" } });
  const oldCode = await prisma.couponCode.create({ data: { agencyId: A.id, hotelClientId: hotelA1.id, influencerId: priya.id, code: "OLD10", status: "ACTIVE", validUntil: new Date(Date.now() - 86_400_000) } });

  fx = {
    agencyA: A.id, agencyB: B.id,
    adminA: adminA as unknown as Record<string, unknown>, analystA: analystA as unknown as Record<string, unknown>, adminB: adminB as unknown as Record<string, unknown>,
    hotelA1: hotelA1.id, siteA1: hotelA1.siteId, hotelA2: hotelA2.id, siteA2: hotelA2.siteId, hotelRev: hotelRev.id, siteRev: hotelRev.siteId, hotelB1: hotelB1.id,
    priyaId: priya.id, priya10Id: priya10.id, oldCodeId: oldCode.id,
  };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe("snippet auto-capture (Path A)", () => {
  test("a valid code creates a snippet_auto InfluencerRedemption linked to the TrackingEvent", async () => {
    const res = await postConversion(fx.siteA1, { coupon: "PRIYA10", value: 15000 });
    expect(res.status).toBe(204);
    const te = await prisma.trackingEvent.findFirst({ where: { hotelClientId: fx.hotelA1, couponCodeUsed: "PRIYA10" }, orderBy: { createdAt: "desc" } });
    expect(te).not.toBeNull();
    const red = await prisma.influencerRedemption.findFirst({ where: { trackingEventId: te!.id } });
    expect(red).not.toBeNull();
    expect(red!.redemptionSource).toBe("snippet_auto");
    expect(red!.influencerId).toBe(fx.priyaId);
    expect(Number(red!.bookingValue)).toBe(15000);
  });

  test("an unknown code stores couponCodeUsed but creates NO redemption", async () => {
    const before = await prisma.influencerRedemption.count({ where: { hotelClientId: fx.hotelA1 } });
    await postConversion(fx.siteA1, { coupon: "NOPE99", value: 9000 });
    const te = await prisma.trackingEvent.findFirst({ where: { hotelClientId: fx.hotelA1, couponCodeUsed: "NOPE99" } });
    expect(te).not.toBeNull(); // booking still recorded
    const after = await prisma.influencerRedemption.count({ where: { hotelClientId: fx.hotelA1 } });
    expect(after).toBe(before); // no redemption
  });

  test("an expired code stores couponCodeUsed but creates NO redemption", async () => {
    const before = await prisma.influencerRedemption.count({ where: { couponCodeId: fx.oldCodeId } });
    await postConversion(fx.siteA1, { coupon: "OLD10", value: 7000 });
    const te = await prisma.trackingEvent.findFirst({ where: { hotelClientId: fx.hotelA1, couponCodeUsed: "OLD10" } });
    expect(te).not.toBeNull();
    expect(await prisma.influencerRedemption.count({ where: { couponCodeId: fx.oldCodeId } })).toBe(before);
  });
});

describe("manual entry (Path B)", () => {
  test("an ANALYST can log a redemption; their member id is recorded", async () => {
    loginAs(fx.analystA, "agency_admin");
    const res = await redeem(fx.hotelA1, { couponCodeId: fx.priya10Id, bookingValue: 5000, guestName: "Test Guest", bookingReference: "BK-1" });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const red = await prisma.influencerRedemption.findUnique({ where: { id } });
    expect(red!.redemptionSource).toBe("manual_entry");
    expect(red!.enteredByMemberId).toBe((fx.analystA as { id: string }).id);
    expect(red!.guestName).toBe("Test Guest");
    expect(red!.trackingEventId).toBeNull(); // no TrackingEvent for manual entries
  });

  test("logging on another agency's hotel returns 404 (no existence leak)", async () => {
    loginAs(fx.adminB, "agency_admin");
    const res = await redeem(fx.hotelA1, { couponCodeId: fx.priya10Id, bookingValue: 5000 });
    expect(res.status).toBe(404);
  });

  test("unauthenticated is rejected", async () => {
    loginAs(null);
    expect((await redeem(fx.hotelA1, { couponCodeId: fx.priya10Id, bookingValue: 1000 })).status).toBe(401);
  });
});

describe("multi-tenant isolation (Part 8)", () => {
  test("agency B cannot see agency A's influencers / codes / redemptions", async () => {
    loginAs(fx.adminB, "agency_admin");
    expect(await agencyScoped(prisma.influencer).findFirst({ where: { id: fx.priyaId } })).toBeNull();
    expect(await agencyScoped(prisma.couponCode).findFirst({ where: { id: fx.priya10Id } })).toBeNull();
    expect(await agencyScoped(prisma.influencerRedemption).count({ where: { hotelClientId: fx.hotelA1 } })).toBe(0);
    loginAs(fx.adminA, "agency_admin");
    expect(await agencyScoped(prisma.influencer).findFirst({ where: { id: fx.priyaId } })).not.toBeNull();
  });

  test("the same code string on two hotels is isolated; a duplicate per hotel is rejected", async () => {
    // Same code on a different hotel is allowed (unique is per-hotel).
    const dupOther = await prisma.couponCode.create({ data: { agencyId: fx.agencyA, hotelClientId: fx.hotelA2, influencerId: fx.priyaId, code: "PRIYA10", status: "ACTIVE" } });
    expect(dupOther.id).toBeTruthy();
    // Same code on the SAME hotel violates @@unique([hotelClientId, code]).
    await expect(
      prisma.couponCode.create({ data: { agencyId: fx.agencyA, hotelClientId: fx.hotelA1, influencerId: fx.priyaId, code: "PRIYA10", status: "ACTIVE" } }),
    ).rejects.toThrow();
  });
});

describe("revenue-by-source integration (Part 6/7)", () => {
  test("a booking with BOTH a UTM source and a coupon counts ONCE, under influencer", async () => {
    await postConversion(fx.siteRev, { coupon: "PRIYA10", value: 10000, utmSource: "instagram", utmMedium: "reel" });
    loginAs(fx.adminA, "agency_admin");
    const body = await (await rbs(fx.hotelRev, "granularity=source")).json();
    expect(body.totals.revenue).toBe(10000); // not 20000
    const keys = body.groups.map((g: { key: string }) => g.key);
    expect(keys).toContain("influencer");
    expect(keys).not.toContain("instagram"); // no double-count under the UTM source
  });

  test("revenue-by-source includes influencer revenue from manual redemptions too", async () => {
    // Per spec PART 6, ANY couponCodeUsed booking is influencer-attributed (even an
    // unmatched/expired code). hotelA1 influencer revenue:
    //   auto PRIYA10 ₹15,000 + auto NOPE99 ₹9,000 + auto OLD10 ₹7,000 (all
    //   coupon-tagged TrackingEvents) + manual ₹5,000 (unioned, no TrackingEvent) = ₹36,000.
    // The manual ₹5,000 being present proves manual redemptions are included; the
    // snippet_auto redemption is NOT double-counted (its TrackingEvent already counts it).
    loginAs(fx.adminA, "agency_admin");
    const body = await (await rbs(fx.hotelA1, "granularity=source")).json();
    const inf = body.groups.find((g: { key: string }) => g.key === "influencer");
    expect(inf).toBeTruthy();
    expect(inf.revenue).toBe(36000);
    // Manual entries (no TrackingEvent) genuinely contribute: drop them and it's ₹31,000.
    const teInfluencer = await prisma.trackingEvent.aggregate({
      where: { hotelClientId: fx.hotelA1, eventType: "conversion", NOT: { couponCodeUsed: null } },
      _sum: { conversionValue: true },
    });
    expect(Number(teInfluencer._sum.conversionValue ?? 0)).toBe(31000); // 36000 − 5000 manual
  });
});

describe("influencer performance + archive (Part 8)", () => {
  test("an archived influencer's historical redemptions remain visible", async () => {
    await prisma.influencer.update({ where: { id: fx.priyaId }, data: { archivedAt: new Date() } });
    loginAs(fx.adminA, "agency_admin");
    const rows = await loadInfluencerPerformance(fx.hotelA1, { since: new Date(Date.now() - 30 * 86_400_000), until: new Date() });
    const priya = rows.find((r) => r.influencerId === fx.priyaId);
    expect(priya).toBeTruthy();
    expect(priya!.archived).toBe(true);
    expect(priya!.redemptions).toBeGreaterThanOrEqual(2); // auto + manual
    expect(priya!.revenue).toBeGreaterThanOrEqual(20000);
    expect(priya!.snippetCount).toBeGreaterThanOrEqual(1);
    expect(priya!.manualCount).toBeGreaterThanOrEqual(1);
  });
});
