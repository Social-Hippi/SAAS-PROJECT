import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Owner-overview metrics (Tier A). Each calculator against a live DB with known
// fixtures: marketing spend, cost/booking, ROAS (overall + Meta), conversion
// rate, new-vs-returning, device split (incl. missing-viewport fallback), bounce
// rate, avg time on site, top campaigns, bookings by source. Plus the endpoint:
// tenant isolation (404 / no rows), unauth (401), date filtering, and the 5-min
// response cache. Mirrors tests/ota-savings.test.ts conventions.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ member: null as null | Record<string, unknown>, role: "agency_admin" as string | undefined }));
vi.mock("@/lib/auth", () => ({ getCurrentMember: async () => h.member, getPlatformRole: async () => h.role }));

import { prisma } from "@/lib/prisma";
import {
  calculateMarketingSpend,
  calculateCostPerBooking,
  calculateROAS,
  calculateConversionRate,
  calculateNewVsReturningFromAds,
  calculateDeviceSplit,
  calculateBounceRate,
  calculateAverageTimeOnSite,
  calculateTopCampaigns,
  calculateBookingsBySource,
} from "@/lib/owner-metrics";
import { GET as ownerMetricsGET } from "@/app/api/agency/hotels/[hotelId]/owner-metrics/route";

const PREFIX = "TEST_OM_";
const loginAs = (m: Record<string, unknown> | null) => { h.member = m; };

// Fixed analysis window.
const START = new Date(Date.UTC(2026, 2, 1, 0, 0, 0)); // 2026-03-01
const END = new Date(Date.UTC(2026, 2, 31, 23, 59, 59)); // 2026-03-31
const IN_WINDOW = new Date(Date.UTC(2026, 2, 15, 10, 0, 0));
const BEFORE_WINDOW = new Date(Date.UTC(2026, 1, 1, 10, 0, 0)); // 2026-02-01

function metricsRoute(hotelId: string, query = "") {
  return ownerMetricsGET(new Request(`http://localhost/api/agency/hotels/${hotelId}/owner-metrics?${query}`), {
    params: Promise.resolve({ hotelId }),
  });
}

async function mkAgency(t: string) {
  return prisma.agency.create({ data: { name: `${PREFIX}${t}`, email: `${PREFIX.toLowerCase()}${t}@x.test`, subscriptionStatus: "active" } });
}
async function mkMember(a: string, t: string) {
  return prisma.agencyMember.create({ data: { agencyId: a, clerkId: `${PREFIX}c-${t}-${Date.now()}-${Math.round(performance.now())}`, email: `${t}@socialhippi.com`, name: t, role: "admin" } });
}
async function mkHotel(a: string, t: string) {
  return prisma.hotelClient.create({ data: { agencyId: a, name: `${PREFIX}${t}`, websiteUrl: "https://h.example", contactName: "C", contactEmail: "c@t.local", siteId: `${PREFIX}s-${t}-${Date.now()}-${Math.round(performance.now())}`, conversionMethod: "both" } });
}

function conv(a: string, hotel: string, value: number, opts: { source?: string; medium?: string; campaign?: string; when?: Date } = {}) {
  return prisma.trackingEvent.create({
    data: {
      agencyId: a, hotelClientId: hotel, eventType: "conversion", pageUrl: "https://h/thx",
      conversionValue: value.toFixed(2), sessionId: `s_${randomUUID()}`, deviceType: "desktop",
      utmSource: opts.source ?? null, utmMedium: opts.medium ?? null, utmCampaign: opts.campaign ?? null,
      createdAt: opts.when ?? IN_WINDOW,
    },
  });
}

async function session(a: string, hotel: string, opts: {
  visitorId: string; startedAt?: Date; source?: string; medium?: string;
  pageViewCount?: number; totalTimeMs?: number; userAgent?: string | null;
  viewportWidth?: number | null; withPageView?: boolean;
}) {
  const id = `sess_${randomUUID()}`;
  await prisma.session.create({
    data: {
      id, visitorId: opts.visitorId, hotelClientId: hotel, agencyId: a,
      startedAt: opts.startedAt ?? IN_WINDOW, landingPath: "/", exitPath: "/",
      pageViewCount: opts.pageViewCount ?? 1, totalTimeMs: opts.totalTimeMs ?? 0,
      utmSource: opts.source ?? null, utmMedium: opts.medium ?? null, userAgent: opts.userAgent ?? null,
    },
  });
  if (opts.withPageView !== false) {
    await prisma.pageView.create({
      data: {
        sessionId: id, visitorId: opts.visitorId, hotelClientId: hotel, agencyId: a,
        pagePath: "/", enteredAt: opts.startedAt ?? IN_WINDOW, viewportWidth: opts.viewportWidth ?? null,
      },
    });
  }
  return id;
}

function adSnap(a: string, hotel: string, spend: number, date = IN_WINDOW) {
  return prisma.adSnapshot.create({
    data: {
      agencyId: a, hotelClientId: hotel, metaAccountId: "act_test", date, spend: spend.toFixed(2),
      impressions: 0, reach: 0, clicks: 0, ctr: 0, cpc: "0", cpm: "0", conversions: 0, roas: 0,
      pixelPurchases: 0, pixelLeads: 0, pixelPageViews: 0,
    },
  });
}
function adCampSnap(a: string, hotel: string, campaignName: string, spend: number, date = IN_WINDOW) {
  return prisma.adCampaignSnapshot.create({
    data: {
      agencyId: a, hotelClientId: hotel, metaCampaignId: `c_${randomUUID()}`, campaignName, date,
      spend: spend.toFixed(2), impressions: 0, clicks: 0, conversions: 0, purchaseValue: "0",
    },
  });
}

type Fx = {
  agencyA: string; memberA: Record<string, unknown>; memberB: Record<string, unknown>;
  hMain: string; hEmpty: string; hOne: string; hDev: string; hB: string;
};
let fx: Fx;

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const A = await mkAgency("A"), B = await mkAgency("B");
  const mA = await mkMember(A.id, "A"), mB = await mkMember(B.id, "B");
  const hMain = await mkHotel(A.id, "Main");
  const hEmpty = await mkHotel(A.id, "Empty");
  const hOne = await mkHotel(A.id, "One");
  const hDev = await mkHotel(A.id, "Dev");
  const hB = await mkHotel(B.id, "B1");

  // ── HMain: the rich scenario ──
  // Ad spend ₹10,000 (account level) across two days.
  await adSnap(A.id, hMain.id, 6000);
  await adSnap(A.id, hMain.id, 4000, new Date(Date.UTC(2026, 2, 16, 10)));
  // Campaign-level spend for "Summer Sale".
  await adCampSnap(A.id, hMain.id, "Summer Sale", 8000);
  // Conversions: revenue 35,000; meta-attributed 30,000; "Summer Sale" = 2 bookings.
  await conv(A.id, hMain.id, 20000, { source: "facebook", medium: "cpc", campaign: "Summer Sale" });
  await conv(A.id, hMain.id, 10000, { source: "instagram", medium: "paid", campaign: "Summer Sale" });
  await conv(A.id, hMain.id, 5000, {}); // direct, no campaign
  // Sessions (4 in window): conv-rate 3/4, devices, bounce, time, new-vs-returning.
  await session(A.id, hMain.id, { visitorId: "V1", source: "facebook", medium: "cpc", viewportWidth: 375, pageViewCount: 3, totalTimeMs: 120000 }); // mobile, ad, new
  await session(A.id, hMain.id, { visitorId: "V2", source: "instagram", medium: "paid", viewportWidth: 800, pageViewCount: 1, totalTimeMs: 5000 }); // tablet, ad, returning, bounce
  await session(A.id, hMain.id, { visitorId: "V3", source: "instagram", medium: "social", viewportWidth: 1440, pageViewCount: 2, totalTimeMs: 60000 }); // desktop, organic
  await session(A.id, hMain.id, { visitorId: "V4", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS) Safari", pageViewCount: 1, totalTimeMs: 3000, withPageView: false }); // mobile via UA, bounce
  // Prior session (before window) makes V2 a "returning" ad visitor.
  await session(A.id, hMain.id, { visitorId: "V2", source: "instagram", medium: "paid", startedAt: BEFORE_WINDOW, pageViewCount: 1, totalTimeMs: 4000, viewportWidth: 800 });

  // ── HOne: exactly 1 booking + 1 campaign (the edge case) ──
  await adSnap(A.id, hOne.id, 5000);
  await adCampSnap(A.id, hOne.id, "Solo", 5000);
  await conv(A.id, hOne.id, 15000, { source: "facebook", medium: "cpc", campaign: "Solo" });

  // ── HDev: device-split graceful handling when viewportWidth is missing ──
  await session(A.id, hDev.id, { visitorId: "D1", viewportWidth: null, userAgent: null }); // unknown
  await session(A.id, hDev.id, { visitorId: "D2", viewportWidth: null, userAgent: "Mozilla/5.0 (iPad; CPU OS) Safari" }); // tablet via UA
  await session(A.id, hDev.id, { visitorId: "D3", userAgent: null, withPageView: false }); // unknown (no pv, no UA)

  // ── HB (agency B): for isolation ──
  await conv(B.id, hB.id, 99000, { source: "facebook", medium: "cpc", campaign: "Other" });

  fx = {
    agencyA: A.id, memberA: mA as unknown as Record<string, unknown>, memberB: mB as unknown as Record<string, unknown>,
    hMain: hMain.id, hEmpty: hEmpty.id, hOne: hOne.id, hDev: hDev.id, hB: hB.id,
  };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe("calculators (HMain known fixtures)", () => {
  // PHASE 0: HMain has ₹10,000 Meta spend, ₹0 Google spend, and ₹35,000 revenue
  // of which ₹30,000 is meta_ads and ₹5,000 is direct.
  test("marketing spend = Meta + Google (Google present, zero here)", async () => {
    loginAs(fx.memberA);
    const r = await calculateMarketingSpend(fx.hMain, START, END);
    expect(r.total).toBe(10000);
    expect(r.meta).toBe(10000);
    expect(r.google).toBe(0); // was `null` — Google Ads IS integrated
    expect(r.mixedCurrency).toBe(false);
  });

  test("cost per booking = paid spend / PAID bookings (not all bookings)", async () => {
    loginAs(fx.memberA);
    const r = await calculateCostPerBooking(fx.hMain, START, END);
    expect(r.bookings).toBe(3); // all tracked bookings, kept for context
    expect(r.paidBookings).toBe(2); // the 2 meta_ads ones — the real denominator
    expect(r.totalSpend).toBe(10000);
    // Phase 0: 10000/2 = 5000. It used to be 10000/3 ≈ 3333, understating the
    // real cost of a paid booking by counting the direct booking as ad-driven.
    expect(r.costPerBooking).toBeCloseTo(5000, 4);
  });

  test("ROAS is PAID-only: direct revenue never enters the numerator", async () => {
    loginAs(fx.memberA);
    const r = await calculateROAS(fx.hMain, START, END);
    // overall = (meta 30000 + google 0) / (meta 10000 + google 0) = 3.0
    // It used to be 3.5 — all 35,000 (including ₹5,000 direct) over Meta spend.
    expect(r.overall).toBeCloseTo(3.0, 6);
    expect(r.meta).toBeCloseTo(3.0, 6);
    expect(r.google).toBeNull(); // no Google spend to divide by
    expect(r.paidRevenue).toBe(30000);
    expect(r.nonPaidRevenue).toBe(5000);
    expect(r.totalRevenue).toBe(35000);
    // The old number is preserved, honestly named, and DIFFERENT from roas.
    expect(r.blended).toBeCloseTo(3.5, 6);
    expect(r.blended).not.toBeCloseTo(r.overall!, 6);
  });

  test("conversion rate = bookings / sessions * 100", async () => {
    loginAs(fx.memberA);
    const r = await calculateConversionRate(fx.hMain, START, END);
    expect(r.bookings).toBe(3);
    expect(r.sessions).toBe(4); // only the 4 in-window sessions, not the prior one
    expect(r.conversionRate).toBeCloseTo(75, 6);
  });

  test("new vs returning (ad-driven only)", async () => {
    loginAs(fx.memberA);
    const r = await calculateNewVsReturningFromAds(fx.hMain, START, END);
    expect(r.totalAdVisitors).toBe(2); // V1 (fb/cpc) + V2 (ig/paid); V3 organic excluded
    expect(r.newVisitors).toBe(1); // V1
    expect(r.returningVisitors).toBe(1); // V2 had a prior session
  });

  test("device split (viewport thresholds + UA fallback)", async () => {
    loginAs(fx.memberA);
    const r = await calculateDeviceSplit(fx.hMain, START, END);
    expect(r.mobile).toBe(2); // V1 (375) + V4 (UA iPhone)
    expect(r.tablet).toBe(1); // V2 (800)
    expect(r.desktop).toBe(1); // V3 (1440)
    expect(r.unknown).toBe(0);
  });

  test("bounce rate (1 pv AND <10s)", async () => {
    loginAs(fx.memberA);
    const r = await calculateBounceRate(fx.hMain, START, END);
    expect(r.totalSessions).toBe(4);
    expect(r.bouncedSessions).toBe(2); // V2 (1pv,5s) + V4 (1pv,3s)
    expect(r.bounceRate).toBeCloseTo(50, 6);
  });

  test("avg time on site", async () => {
    loginAs(fx.memberA);
    const r = await calculateAverageTimeOnSite(fx.hMain, START, END);
    expect(r.sessions).toBe(4);
    expect(r.averageMs).toBe((120000 + 5000 + 60000 + 3000) / 4); // 47000
    expect(r.averageFormatted).toBe("47s");
  });

  test("top campaigns joined to Meta spend", async () => {
    loginAs(fx.memberA);
    const r = await calculateTopCampaigns(fx.hMain, START, END);
    expect(r.campaigns.length).toBe(1); // direct conversion has no campaign → excluded
    const c = r.campaigns[0];
    expect(c.campaignName).toBe("Summer Sale");
    expect(c.source).toBe("meta");
    expect(c.revenue).toBe(30000);
    expect(c.bookings).toBe(2);
    expect(c.spend).toBe(8000);
    expect(c.roas).toBeCloseTo(30000 / 8000, 6); // 3.75
    expect(c.costPerBooking).toBe(4000); // 8000 / 2
  });

  test("bookings by source", async () => {
    loginAs(fx.memberA);
    const r = await calculateBookingsBySource(fx.hMain, START, END);
    expect(r.totalBookings).toBe(3);
    expect(r.totalRevenue).toBe(35000);
    const byType = Object.fromEntries(r.sources.map((s) => [s.type, s]));
    expect(byType.meta_ads.revenue).toBe(30000);
    expect(byType.meta_ads.bookings).toBe(2);
    expect(byType.direct.revenue).toBe(5000);
    expect(byType.direct.bookings).toBe(1);
    expect(r.sources[0].type).toBe("meta_ads"); // sorted by revenue desc
  });
});

describe("edge cases", () => {
  test("empty hotel returns clean empty states (no NaN / no infinity)", async () => {
    loginAs(fx.memberA);
    expect((await calculateMarketingSpend(fx.hEmpty, START, END)).total).toBe(0);
    const cpb = await calculateCostPerBooking(fx.hEmpty, START, END);
    expect(cpb.costPerBooking).toBeNull();
    const roas = await calculateROAS(fx.hEmpty, START, END);
    expect(roas.overall).toBeNull();
    expect(roas.meta).toBeNull();
    expect(roas.google).toBeNull();
    expect(roas.blended).toBeNull();
    expect(roas.paidRevenue).toBe(0);
    const cr = await calculateConversionRate(fx.hEmpty, START, END);
    expect(cr.conversionRate).toBe(0);
    expect(cr.sessions).toBe(0);
    const t = await calculateAverageTimeOnSite(fx.hEmpty, START, END);
    expect(t.sessions).toBe(0);
    expect(t.averageFormatted).toBe("—");
    expect((await calculateTopCampaigns(fx.hEmpty, START, END)).campaigns.length).toBe(0);
    expect((await calculateBookingsBySource(fx.hEmpty, START, END)).totalBookings).toBe(0);
  });

  test("hotel with 1 booking + 1 campaign computes ROAS and cost/booking", async () => {
    loginAs(fx.memberA);
    const cpb = await calculateCostPerBooking(fx.hOne, START, END);
    expect(cpb.bookings).toBe(1);
    expect(cpb.paidBookings).toBe(1); // the single booking IS facebook/cpc
    expect(cpb.costPerBooking).toBe(5000); // 5000 / 1
    const roas = await calculateROAS(fx.hOne, START, END);
    expect(roas.overall).toBeCloseTo(3, 6); // 15000 paid / 5000 paid spend
    // With no non-paid revenue at all, blended and paid ROAS agree.
    expect(roas.blended).toBeCloseTo(3, 6);
    const camp = (await calculateTopCampaigns(fx.hOne, START, END)).campaigns;
    expect(camp.length).toBe(1);
    expect(camp[0].roas).toBeCloseTo(3, 6);
    expect(camp[0].costPerBooking).toBe(5000);
  });

  test("device split handles missing viewportWidth gracefully", async () => {
    loginAs(fx.memberA);
    const r = await calculateDeviceSplit(fx.hDev, START, END);
    expect(r.tablet).toBe(1); // D2 → iPad UA
    expect(r.unknown).toBe(2); // D1 (no width, no UA) + D3 (no pv, no UA)
    expect(r.mobile).toBe(0);
    expect(r.desktop).toBe(0);
  });

  test("date filtering: a window before the data is empty", async () => {
    loginAs(fx.memberA);
    const janStart = new Date(Date.UTC(2026, 0, 1));
    const janEnd = new Date(Date.UTC(2026, 0, 31, 23, 59, 59));
    expect((await calculateConversionRate(fx.hMain, janStart, janEnd)).bookings).toBe(0);
    expect((await calculateMarketingSpend(fx.hMain, janStart, janEnd)).total).toBe(0);
  });
});

describe("owner-metrics endpoint", () => {
  test("returns the full bundle for an owned hotel", async () => {
    loginAs(fx.memberA);
    const res = await metricsRoute(fx.hMain, "startDate=2026-03-01&endDate=2026-03-31");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.marketingSpend.total).toBe(10000);
    expect(body.marketingSpend.google).toBe(0);
    expect(body.conversionRate.bookings).toBe(3);
    // Phase 0: the endpoint now serves the PAID ROAS (3.0), not the blended 3.5.
    expect(body.roas.overall).toBeCloseTo(3.0, 6);
    expect(body.roas.blended).toBeCloseTo(3.5, 6);
    expect(body.topCampaigns.campaigns[0].campaignName).toBe("Summer Sale");
    expect(body.bookingsBySource.totalBookings).toBe(3);
    expect(body.meta.metaConnected).toBe(true);
    expect(body.meta.googleConnected).toBe(false);
    expect(body.meta.paidConnected).toBe(true);
  });

  test("another agency's hotel returns 404", async () => {
    loginAs(fx.memberB);
    expect((await metricsRoute(fx.hMain, "startDate=2026-03-01&endDate=2026-03-31")).status).toBe(404);
  });

  test("unauthenticated is rejected", async () => {
    loginAs(null);
    expect((await metricsRoute(fx.hMain)).status).toBe(401);
  });

  test("calculators are agency-scoped (B sees no rows for A's hotel)", async () => {
    loginAs(fx.memberB);
    const cr = await calculateConversionRate(fx.hMain, START, END);
    expect(cr.bookings).toBe(0);
    expect(cr.sessions).toBe(0);
  });

  test("response is cached, and the cache expires after 5 minutes", async () => {
    loginAs(fx.memberA);
    const cacheHotel = await mkHotel(fx.agencyA, `Cache-${Date.now()}`);
    await conv(fx.agencyA, cacheHotel.id, 1000, { source: "facebook", medium: "cpc", campaign: "C" });
    const q = "startDate=2026-03-01&endDate=2026-03-31";

    const first = await (await metricsRoute(cacheHotel.id, q)).json();
    expect(first.conversionRate.bookings).toBe(1);

    // Mutate the DB, then read again immediately → cached (stale) value.
    await prisma.trackingEvent.deleteMany({ where: { hotelClientId: cacheHotel.id } });
    const cached = await (await metricsRoute(cacheHotel.id, q)).json();
    expect(cached.conversionRate.bookings).toBe(1); // served from cache

    // Advance only the cache's clock (Date.now) past the 5-min TTL → recomputed.
    const realNow = Date.now;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 6 * 60_000);
    try {
      const fresh = await (await metricsRoute(cacheHotel.id, q)).json();
      expect(fresh.conversionRate.bookings).toBe(0); // cache expired → fresh read
    } finally {
      nowSpy.mockRestore();
    }
  });
});
