import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0 — revenue integrity at ingest. Drives the real POST /api/track/event
// handler against a live database.
//
// Three defects this pins down:
//   1. MAX_CONVERSION_VALUE was declared with a comment claiming it was enforced,
//      and never applied — so anyone holding a hotel's PUBLIC siteId could inject
//      an arbitrary booking value straight into its revenue KPIs.
//   2. No server-side conversion idempotency. The snippet's `_ht_conv` guard is
//      keyed to a sessionStorage id, so a reopened tab (or a replayed beacon)
//      created a SECOND TrackingEvent and double-counted the booking + revenue.
//   3. A duplicated conversion carrying a coupon also created a second
//      InfluencerRedemption, double-counting the influencer's attributed revenue.
//
// Requires a live test database (same as the other integration suites).
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
import { POST as trackPOST } from "@/app/api/track/event/route";

const PREFIX = "TEST_TI_";

// Mirrors app/api/track/event/route.ts:MAX_CONVERSION_VALUE. Kept as a literal
// on purpose: if the route's cap ever changes, this test should be reviewed
// rather than silently following along.
const MAX_CONVERSION_VALUE = 10_000_000;

const sess = () => `sess_${randomUUID()}`;
const vis = () => `vis_${randomUUID()}`;

function post(body: Record<string, unknown>) {
  return trackPOST(
    new Request("http://localhost/api/track/event", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8", "x-forwarded-for": "203.0.113.44" },
      body: JSON.stringify(body),
    }),
  );
}

function conversion(
  siteId: string,
  sessionId: string,
  visitorId: string,
  value: number | null,
  extra?: Record<string, unknown>,
) {
  return post({
    siteId,
    type: "conversion",
    v: "2.3.0",
    sessionId,
    visitorId,
    pageUrl: "https://hotel.example/thank-you",
    utmSource: "facebook",
    utmMedium: "cpc",
    utmCampaign: "Summer Sale",
    deviceType: "desktop",
    value,
    ...extra,
  });
}

type Fx = {
  agencyId: string;
  hotelId: string;
  siteId: string;
  influencerId: string;
  couponId: string;
  couponCode: string;
};
let fx: Fx;

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const agency = await prisma.agency.create({
    data: { name: `${PREFIX}A`, email: `${PREFIX.toLowerCase()}a@x.test`, subscriptionStatus: "active" },
  });
  const hotel = await prisma.hotelClient.create({
    data: {
      agencyId: agency.id,
      name: `${PREFIX}Hotel`,
      websiteUrl: "https://hotel.example",
      contactName: "C",
      contactEmail: "c@t.local",
      siteId: `${PREFIX}site-${Date.now()}`,
      conversionMethod: "both",
    },
  });
  const influencer = await prisma.influencer.create({
    data: { agencyId: agency.id, hotelClientId: hotel.id, name: `${PREFIX}Priya` },
  });
  const code = "PHASE0TEST";
  const coupon = await prisma.couponCode.create({
    data: {
      agencyId: agency.id,
      hotelClientId: hotel.id,
      influencerId: influencer.id,
      code,
      status: "ACTIVE",
    },
  });

  fx = {
    agencyId: agency.id,
    hotelId: hotel.id,
    siteId: hotel.siteId,
    influencerId: influencer.id,
    couponId: coupon.id,
    couponCode: code,
  };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

const conversionsFor = (sessionId: string) =>
  prisma.trackingEvent.findMany({
    where: { hotelClientId: fx.hotelId, eventType: "conversion", sessionId },
    select: { id: true, conversionValue: true },
  });

// ── 9. MAX_CONVERSION_VALUE is actually enforced ────────────────────────────

describe("conversion value cap", () => {
  test("a value over MAX_CONVERSION_VALUE is rejected, but the booking is kept", async () => {
    const s = sess();
    const res = await conversion(fx.siteId, s, vis(), MAX_CONVERSION_VALUE + 1);
    expect(res.status).toBe(204);

    const rows = await conversionsFor(s);
    expect(rows).toHaveLength(1); // the booking is NEVER lost
    expect(rows[0].conversionValue).toBeNull(); // only the implausible amount is
  });

  test("a value exactly at the cap is accepted", async () => {
    const s = sess();
    await conversion(fx.siteId, s, vis(), MAX_CONVERSION_VALUE);
    const rows = await conversionsFor(s);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].conversionValue)).toBe(MAX_CONVERSION_VALUE);
  });

  test("an ordinary booking value is unaffected", async () => {
    const s = sess();
    await conversion(fx.siteId, s, vis(), 24_500);
    const rows = await conversionsFor(s);
    expect(Number(rows[0].conversionValue)).toBe(24_500);
  });

  test("a negative value is ignored (no revenue), booking still recorded", async () => {
    const s = sess();
    await conversion(fx.siteId, s, vis(), -5_000);
    const rows = await conversionsFor(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].conversionValue).toBeNull();
  });
});

// ── 10. Conversion idempotency per (hotel, session) ─────────────────────────

describe("conversion idempotency", () => {
  test("a repeat conversion for the same hotel + session creates no second event", async () => {
    const s = sess();
    const v = vis();

    const first = await conversion(fx.siteId, s, v, 30_000);
    expect(first.status).toBe(204);
    const second = await conversion(fx.siteId, s, v, 30_000);
    expect(second.status).toBe(204); // a no-op, not an error

    const rows = await conversionsFor(s);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].conversionValue)).toBe(30_000);
  });

  test("the duplicate cannot overwrite the first booking's value", async () => {
    const s = sess();
    const v = vis();
    await conversion(fx.siteId, s, v, 10_000);
    await conversion(fx.siteId, s, v, 999_999); // a later, different amount

    const rows = await conversionsFor(s);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].conversionValue)).toBe(10_000);
  });

  test("a DIFFERENT session for the same hotel still records its own booking", async () => {
    const v = vis();
    const s1 = sess();
    const s2 = sess();
    await conversion(fx.siteId, s1, v, 5_000);
    await conversion(fx.siteId, s2, v, 7_000);

    expect(await conversionsFor(s1)).toHaveLength(1);
    expect(await conversionsFor(s2)).toHaveLength(1);
  });

  test("no touchpoint rows are duplicated by the repeat", async () => {
    const s = sess();
    const v = vis();
    const journey = [
      { ts: Date.now() - 60_000, utm_source: "facebook", utm_medium: "cpc" },
      { ts: Date.now() - 30_000, utm_source: "google", utm_medium: "cpc" },
    ];
    await conversion(fx.siteId, s, v, 12_000, { journey });
    await conversion(fx.siteId, s, v, 12_000, { journey });

    const rows = await conversionsFor(s);
    expect(rows).toHaveLength(1);
    const touchpoints = await prisma.touchpoint.count({ where: { conversionId: rows[0].id } });
    expect(touchpoints).toBe(2); // not 4
  });

  test("a repeat still refreshes the hotel's lastEventAt (the snippet is alive)", async () => {
    const s = sess();
    const v = vis();
    await conversion(fx.siteId, s, v, 1_000);
    const before = await prisma.hotelClient.findUniqueOrThrow({
      where: { id: fx.hotelId },
      select: { lastEventAt: true },
    });
    await new Promise((r) => setTimeout(r, 25));
    await conversion(fx.siteId, s, v, 1_000);
    const after = await prisma.hotelClient.findUniqueOrThrow({
      where: { id: fx.hotelId },
      select: { lastEventAt: true },
    });
    expect(after.lastEventAt!.getTime()).toBeGreaterThan(before.lastEventAt!.getTime());
  });
});

// ── 11. Influencer redemption is not duplicated ─────────────────────────────

describe("influencer redemption duplication", () => {
  test("a repeat coupon conversion creates only ONE redemption", async () => {
    const s = sess();
    const v = vis();
    await conversion(fx.siteId, s, v, 40_000, { couponCodeUsed: fx.couponCode });
    await conversion(fx.siteId, s, v, 40_000, { couponCodeUsed: fx.couponCode });

    const rows = await conversionsFor(s);
    expect(rows).toHaveLength(1);

    const redemptions = await prisma.influencerRedemption.findMany({
      where: { couponCodeId: fx.couponId, sessionId: s },
      select: { bookingValue: true, redemptionSource: true },
    });
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0].redemptionSource).toBe("snippet_auto");
    expect(Number(redemptions[0].bookingValue)).toBe(40_000);
  });

  test("distinct sessions each redeem the same code once", async () => {
    const s1 = sess();
    const s2 = sess();
    await conversion(fx.siteId, s1, vis(), 10_000, { couponCodeUsed: fx.couponCode });
    await conversion(fx.siteId, s2, vis(), 10_000, { couponCodeUsed: fx.couponCode });

    const a = await prisma.influencerRedemption.count({ where: { couponCodeId: fx.couponId, sessionId: s1 } });
    const b = await prisma.influencerRedemption.count({ where: { couponCodeId: fx.couponId, sessionId: s2 } });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  test("an over-cap coupon booking records the redemption at 0, not the bogus value", async () => {
    const s = sess();
    await conversion(fx.siteId, s, vis(), MAX_CONVERSION_VALUE + 1, {
      couponCodeUsed: fx.couponCode,
    });
    const redemptions = await prisma.influencerRedemption.findMany({
      where: { couponCodeId: fx.couponId, sessionId: s },
      select: { bookingValue: true },
    });
    expect(redemptions).toHaveLength(1);
    expect(Number(redemptions[0].bookingValue)).toBe(0);
  });
});
