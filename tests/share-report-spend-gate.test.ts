import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { prisma } from "@/lib/prisma";
import { loadHotelReport } from "@/lib/report-data";

// ─────────────────────────────────────────────────────────────────────────────
// /share/<uuid> ad-spend gate. When the report is loaded for the PUBLIC share link
// (respectAdSpendFlag: true) and the hotel's showAdSpendToHotel flag is OFF,
// loadHotelReport strips ad spend + every spend-derived figure (cost/booking,
// ROAS, Meta ROAS, True ROI, the daily spend series) BEFORE the report leaves the
// server. Outcomes (bookings, revenue, OTA savings) are untouched. Agency + PDF
// callers (flag omitted) always see spend, regardless of the hotel flag.
//
// A live DB holds the fixtures.
// ─────────────────────────────────────────────────────────────────────────────

const PREFIX = "TEST_SPENDGATE_";
const day = (o: number) => new Date(Date.now() + o * 86_400_000);

let agencyId: string;
let hotelHidden: string; // showAdSpendToHotel = false
let hotelShown: string; // showAdSpendToHotel = true

async function mkHotel(name: string, showAdSpendToHotel: boolean) {
  const hotel = await prisma.hotelClient.create({
    data: {
      agencyId, name: `${PREFIX}${name}`, websiteUrl: "https://h.example", contactName: "C", contactEmail: "c@t.local",
      siteId: `${PREFIX}s-${name}-${randomUUID()}`, conversionMethod: "both", otaCommissionRate: "15.00",
      showAdSpendToHotel,
    },
  });
  // Real Meta spend inside the window, plus a snippet-tracked booking.
  await prisma.adSnapshot.create({
    data: {
      agencyId, hotelClientId: hotel.id, metaAccountId: "act_test", date: day(-3),
      spend: "1000.00", impressions: 10000, reach: 8000, clicks: 200, ctr: 2, cpc: "5", cpm: "100",
      conversions: 4, roas: 3, pixelPurchases: 0, pixelLeads: 0, pixelPageViews: 0,
    },
  });
  await prisma.trackingEvent.create({
    data: {
      agencyId, hotelClientId: hotel.id, eventType: "conversion", pageUrl: "https://h/thx",
      conversionValue: "3000.00", sessionId: `s_${randomUUID()}`, deviceType: "desktop",
      utmSource: "facebook", utmMedium: "paid", utmCampaign: "Summer", createdAt: day(-3),
    },
  });
  return hotel.id;
}

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const a = await prisma.agency.create({
    data: { name: `${PREFIX}A`, email: `${PREFIX.toLowerCase()}a@x.test`, subscriptionStatus: "active" },
  });
  agencyId = a.id;
  hotelHidden = await mkHotel("Hidden", false);
  hotelShown = await mkHotel("Shown", true);
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

const range = { since: day(-14), until: day(1) };

describe("loadHotelReport ad-spend gate for /share", () => {
  test("share caller + hotel flag OFF → spend + spend-derived figures stripped", async () => {
    const r = await loadHotelReport({ agencyId, hotelId: hotelHidden, ...range, respectAdSpendFlag: true });
    expect(r.showAdSpend).toBe(false);
    expect(r.ads.spend).toBe(0);
    expect(r.ads.spendOverTime).toEqual([]);
    expect(r.ads.metaRoas).toBeNull();
    expect(r.kpis.spend).toBe(0);
    expect(r.kpis.costPerBooking).toBeNull();
    expect(r.kpis.roas).toBeNull();
    // Phase 0: the new spend-derived fields must be stripped too. blendedRoas is
    // (all revenue ÷ paid spend) — leaving it in would leak the spend figure by
    // division, since revenue IS shown to the hotel.
    expect(r.kpis.blendedRoas).toBeNull();
    expect(r.kpis.spendByPlatform).toEqual({ meta: 0, google: 0, total: 0 });
    expect(r.realRoi).toBeNull();
    // Outcomes remain intact.
    expect(r.kpis.bookings).toBeGreaterThan(0);
    expect(r.kpis.revenue).toBeGreaterThan(0);
    expect(r.otaSavings.amount).toBeGreaterThan(0);
  });

  test("share caller + hotel flag ON → spend shown", async () => {
    const r = await loadHotelReport({ agencyId, hotelId: hotelShown, ...range, respectAdSpendFlag: true });
    expect(r.showAdSpend).toBe(true);
    expect(r.ads.spend).toBeGreaterThan(0);
    expect(r.ads.spendOverTime.length).toBeGreaterThan(0);
  });

  test("agency/PDF caller (flag omitted) always sees spend, even when the hotel flag is OFF", async () => {
    const r = await loadHotelReport({ agencyId, hotelId: hotelHidden, ...range });
    expect(r.showAdSpend).toBe(true);
    expect(r.ads.spend).toBeGreaterThan(0);
  });
});
