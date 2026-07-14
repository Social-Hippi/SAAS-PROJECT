import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Revenue by Source — drives the real GET route handler against a live database,
// plus pure unit tests for the classifier + aggregation. Covers tenant isolation
// (404, not 403), the three granularities, UTM normalization, date filtering,
// deterministic classification, empty hotels, soft-deleted hotels, and the
// Part 7 sample-data totals (₹95,500 across 5 bookings).
//
// Requires the 20260612170000_add_attribution_model migration applied.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  member: null as null | Record<string, unknown>,
  role: "agency_admin" as string | undefined,
}));
vi.mock("@/lib/auth", () => ({
  getCurrentMember: async () => h.member,
  getPlatformRole: async () => h.role,
}));

import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/agency/hotels/[hotelId]/revenue-by-source/route";
import { classifySourceType, type ClassifiableUtm, type SourceType } from "@/lib/source-classifier";
import { aggregateRevenueBySource, type ConversionRow } from "@/lib/revenue-by-source";

const PREFIX = "TEST_RBS_";

function loginAs(member: Record<string, unknown> | null, role = "agency_admin") {
  h.member = member;
  h.role = role;
}

function call(hotelId: string, query = "") {
  return GET(new Request(`http://localhost/api/agency/hotels/${hotelId}/revenue-by-source?${query}`), {
    params: Promise.resolve({ hotelId }),
  });
}

type Utm = { source?: string; medium?: string; campaign?: string; content?: string };
function conv(agencyId: string, hotelId: string, utm: Utm, value: number, when = new Date()) {
  return prisma.trackingEvent.create({
    data: {
      agencyId,
      hotelClientId: hotelId,
      eventType: "conversion",
      utmSource: utm.source ?? null,
      utmMedium: utm.medium ?? null,
      utmCampaign: utm.campaign ?? null,
      utmContent: utm.content ?? null,
      pageUrl: "https://hotel.example/thank-you",
      conversionValue: value.toFixed(2),
      sessionId: `s_${randomUUID()}`,
      deviceType: "desktop",
      createdAt: when,
    },
  });
}

type Fx = {
  agencyA: string; agencyB: string;
  memberA: Record<string, unknown>; memberB: Record<string, unknown>;
  hotelA: string; hotelB: string; hotelEmpty: string; hotelSample: string; hotelDeleted: string;
};
let fx: Fx;

async function makeAgency(tag: string) {
  const agency = await prisma.agency.create({
    data: { name: `${PREFIX}${tag}`, email: `${PREFIX.toLowerCase()}${tag}@example.test`, subscriptionStatus: "active" },
  });
  const member = await prisma.agencyMember.create({
    data: { agencyId: agency.id, clerkId: `${PREFIX}clerk-${tag}-${Date.now()}`, email: `${tag}@socialhippi.com`, name: `M ${tag}`, role: "admin" },
    include: { agency: true },
  });
  return { agency, member };
}
async function makeHotel(agencyId: string, tag: string, deleted = false) {
  return prisma.hotelClient.create({
    data: {
      agencyId, name: `${PREFIX}${tag}`, websiteUrl: "https://hotel.example",
      contactName: "C", contactEmail: "c@test.local",
      siteId: `${PREFIX}site-${tag}-${Date.now()}-${Math.round(performance.now())}`,
      conversionMethod: "both",
      ...(deleted ? { deletedAt: new Date() } : {}),
    },
  });
}

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const A = await makeAgency("A");
  const B = await makeAgency("B");
  const hotelA = await makeHotel(A.agency.id, "A-Hotel");
  const hotelB = await makeHotel(B.agency.id, "B-Hotel");
  const hotelEmpty = await makeHotel(A.agency.id, "A-Empty");
  const hotelSample = await makeHotel(A.agency.id, "A-Sample");
  const hotelDeleted = await makeHotel(A.agency.id, "A-Deleted", true);
  fx = {
    agencyA: A.agency.id, agencyB: B.agency.id,
    memberA: A.member as unknown as Record<string, unknown>,
    memberB: B.member as unknown as Record<string, unknown>,
    hotelA: hotelA.id, hotelB: hotelB.id, hotelEmpty: hotelEmpty.id, hotelSample: hotelSample.id, hotelDeleted: hotelDeleted.id,
  };

  // Part 7 sample bookings on hotelSample (total ₹95,500 across 5 bookings).
  await conv(fx.agencyA, fx.hotelSample, { source: "instagram", medium: "reel", campaign: "monsoon" }, 15000);
  await conv(fx.agencyA, fx.hotelSample, { source: "instagram", medium: "story", campaign: "influencer", content: "priya" }, 8500);
  await conv(fx.agencyA, fx.hotelSample, { source: "facebook", medium: "cpc", campaign: "monsoon" }, 25000);
  await conv(fx.agencyA, fx.hotelSample, { source: "google", medium: "cpc", campaign: "brand" }, 42000);
  await conv(fx.agencyA, fx.hotelSample, {}, 5000); // direct, no UTM
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe("multi-tenant security (Part 6)", () => {
  test("Agency A requesting Agency B's hotel returns 404 (not 403, no existence leak)", async () => {
    loginAs(fx.memberA);
    const res = await call(fx.hotelB);
    expect(res.status).toBe(404);
  });

  test("a soft-deleted hotel returns 404", async () => {
    loginAs(fx.memberA);
    const res = await call(fx.hotelDeleted);
    expect(res.status).toBe(404);
  });

  test("unauthenticated returns 401", async () => {
    loginAs(null);
    const res = await call(fx.hotelSample);
    expect(res.status).toBe(401);
  });
});

describe("granularities + sample data (Part 7)", () => {
  test("source granularity: correct totals + per-source breakdown", async () => {
    loginAs(fx.memberA);
    const res = await call(fx.hotelSample, "granularity=source");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.totals.bookings).toBe(5);
    expect(body.totals.revenue).toBe(95500);
    const bySource = Object.fromEntries(body.groups.map((g: { key: string; revenue: number }) => [g.key, g.revenue]));
    expect(bySource.instagram).toBe(23500); // 15000 + 8500
    expect(bySource.facebook).toBe(25000);
    expect(bySource.google).toBe(42000);
    expect(bySource.direct).toBe(5000);
    // Sorted by revenue desc → google first.
    expect(body.groups[0].key).toBe("google");
    // % of total adds up.
    const pctSum = body.groups.reduce((s: number, g: { percentOfTotal: number }) => s + g.percentOfTotal, 0);
    expect(Math.round(pctSum)).toBe(100);
  });

  test("source_medium granularity splits instagram into reel + story", async () => {
    loginAs(fx.memberA);
    const body = await (await call(fx.hotelSample, "granularity=source_medium")).json();
    const m = Object.fromEntries(body.groups.map((g: { key: string; revenue: number }) => [g.key, g.revenue]));
    expect(m["instagram/reel"]).toBe(15000);
    expect(m["instagram/story"]).toBe(8500);
    expect(m["facebook/cpc"]).toBe(25000);
    expect(m["google/cpc"]).toBe(42000);
    expect(m["direct/none"]).toBe(5000);
  });

  test("source_medium_campaign granularity shows all 5 distinctly", async () => {
    loginAs(fx.memberA);
    const body = await (await call(fx.hotelSample, "granularity=source_medium_campaign")).json();
    expect(body.groups.length).toBe(5);
    const keys = body.groups.map((g: { key: string }) => g.key).sort();
    expect(keys).toContain("instagram/reel/monsoon");
    expect(keys).toContain("instagram/story/influencer");
    expect(keys).toContain("facebook/cpc/monsoon");
    expect(keys).toContain("google/cpc/brand");
    expect(keys).toContain("direct/none/none");
  });
});

describe("normalization + filtering (Part 6)", () => {
  test("instagram + Instagram + INSTAGRAM + ig all aggregate together", async () => {
    const hotel = (await makeHotel(fx.agencyA, "A-Norm")).id;
    await conv(fx.agencyA, hotel, { source: "instagram", medium: "reel" }, 1000);
    await conv(fx.agencyA, hotel, { source: "Instagram", medium: "reel" }, 1000);
    await conv(fx.agencyA, hotel, { source: "INSTAGRAM", medium: "reel" }, 1000);
    await conv(fx.agencyA, hotel, { source: "ig", medium: "reel" }, 1000); // alias
    loginAs(fx.memberA);
    const body = await (await call(hotel, "granularity=source")).json();
    expect(body.groups.length).toBe(1);
    expect(body.groups[0].key).toBe("instagram");
    expect(body.groups[0].bookings).toBe(4);
    expect(body.groups[0].revenue).toBe(4000);
  });

  test("date range filtering excludes out-of-window bookings", async () => {
    const hotel = (await makeHotel(fx.agencyA, "A-Dates")).id;
    await conv(fx.agencyA, hotel, { source: "google" }, 1000, new Date(Date.now() - 60 * 86_400_000));
    await conv(fx.agencyA, hotel, { source: "google" }, 2000, new Date());
    loginAs(fx.memberA);
    const body = await (await call(hotel, "granularity=source")).json(); // default last 30d
    expect(body.totals.bookings).toBe(1);
    expect(body.totals.revenue).toBe(2000);
  });

  test("empty hotel returns 200 with empty groups, not an error", async () => {
    loginAs(fx.memberA);
    const res = await call(fx.hotelEmpty);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toEqual([]);
    expect(body.totals.bookings).toBe(0);
    expect(body.totals.revenue).toBe(0);
  });

  test("sourceTypes chip filter narrows to the selected types", async () => {
    loginAs(fx.memberA);
    const body = await (await call(fx.hotelSample, "granularity=source&sourceTypes=google_ads")).json();
    expect(body.groups.length).toBe(1);
    expect(body.groups[0].key).toBe("google");
    expect(body.totals.revenue).toBe(42000);
  });
});

describe("source classification is deterministic (Part 6)", () => {
  test("known mappings are stable across calls", () => {
    const cases: [ClassifiableUtm, SourceType][] = [
      [{ utmSource: "facebook", utmMedium: "cpc" }, "meta_ads"],
      [{ utmSource: "instagram", utmMedium: "paid_social" }, "meta_ads"],
      [{ utmSource: "google", utmMedium: "cpc" }, "google_ads"],
      [{ utmSource: "instagram", utmMedium: "reel" }, "instagram_organic"],
      [{ utmSource: "facebook", utmMedium: "page" }, "facebook_organic"],
      [{ utmSource: "instagram", utmMedium: "influencer" }, "influencer"],
      [{ utmSource: "email", utmMedium: "newsletter" }, "email"],
      [{ utmSource: "whatsapp", utmMedium: "chat" }, "whatsapp"],
      [{ utmSource: undefined, utmMedium: undefined }, "direct"],
      [{ utmSource: "reddit", utmMedium: "social" }, "other"],
    ];
    for (const [utm, expected] of cases) {
      const a = classifySourceType(utm);
      const b = classifySourceType(utm);
      expect(a).toBe(expected);
      expect(b).toBe(a); // deterministic
    }
  });
});

describe("aggregation unit (pure)", () => {
  test("percentOfTotal, averageBookingValue, and sorting", () => {
    const now = new Date();
    const rows: ConversionRow[] = [
      { utmSource: "google", utmMedium: "cpc", utmCampaign: "b", utmContent: null, value: 6000, occurredAt: now },
      { utmSource: "instagram", utmMedium: "reel", utmCampaign: "m", utmContent: null, value: 2000, occurredAt: now },
      { utmSource: "instagram", utmMedium: "reel", utmCampaign: "m", utmContent: null, value: 2000, occurredAt: now },
    ];
    const out = aggregateRevenueBySource(rows, "source", { start: new Date(now.getTime() - 6 * 86_400_000), end: now });
    expect(out.totals.revenue).toBe(10000);
    expect(out.groups[0].key).toBe("google"); // highest revenue first
    expect(out.groups[0].percentOfTotal).toBeCloseTo(60);
    const insta = out.groups.find((g) => g.key === "instagram")!;
    expect(insta.bookings).toBe(2);
    expect(insta.averageBookingValue).toBe(2000);
  });
});
