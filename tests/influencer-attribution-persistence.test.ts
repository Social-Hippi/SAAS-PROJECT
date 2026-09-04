import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Track A — INFLUENCER ACCEPTANCE TEST against a LIVE DATABASE.
//
// Creates one synthetic influencer with real rows (no faked data), generates the
// real HotelTrack tracking URL, drives the REAL /api/track/event handler, and
// proves BOTH routes land on the SAME Influencer:
//
//   URL     utm_content=ht-<contentPieceId> → ContentPiece.influencerId → Influencer
//   COUPON  couponCodeUsed → CouponCode → InfluencerRedemption → Influencer
//
// Requires 20260821000000, 20260824000000 and 20260825000000 to be applied.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ member: null as null | Record<string, unknown>, role: "agency_admin" as string | undefined }));
vi.mock("@/lib/auth", () => ({
  getCurrentMember: async () => h.member,
  getPlatformRole: async () => h.role,
}));

import { prisma } from "@/lib/prisma";
import { POST as trackPOST } from "@/app/api/track/event/route";
import { buildUtmLink } from "@/lib/utm";
import { classifySourceType } from "@/lib/source-classifier";
import { contentPieceIdFromUtmContent } from "@/lib/influencer-attribution";
import { loadChannelView } from "@/lib/channel-view";
import type { InfluencerChannelView } from "@/lib/channel-view-types";
import {
  resolveInfluencerFromCoupon,
  resolveInfluencerFromUtmContent,
  resolveInfluencerForConversion,
} from "@/lib/influencer-resolve";

const PREFIX = "TEST_INFA_";
const COUPON = "TESTINFLUENCERCODE";
/** Must match the name the fixture gives the Influencer row below. */
const INFLUENCER_NAME = "TEST_INFLUENCER";

type Fx = {
  agencyId: string; memberId: string; hotelId: string; siteId: string;
  influencerId: string; contentPieceId: string; utmLink: string;
  otherAgencyId: string; otherHotelId: string; otherInfluencerId: string;
};
let fx: Fx;

const sess = () => `sess_${randomUUID()}`;
const vis = () => `vis_${randomUUID()}`;

function post(body: Record<string, unknown>) {
  return trackPOST(
    new Request("http://localhost/api/track/event", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8", "x-forwarded-for": "203.0.113.55" },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });

  const agency = await prisma.agency.create({
    data: { name: `${PREFIX}A`, email: `${PREFIX.toLowerCase()}a@x.test`, subscriptionStatus: "active" },
  });
  // The reporting loaders go through agencyScoped(), which resolves the agency
  // from an AgencyMember — so the fixture needs a real one.
  const member = await prisma.agencyMember.create({
    data: {
      agencyId: agency.id, clerkId: `${PREFIX}clerk-${Date.now()}`,
      email: "a@socialhippi.com", name: `${PREFIX}Member`, role: "admin",
    },
  });
  const hotel = await prisma.hotelClient.create({
    data: {
      agencyId: agency.id, name: `${PREFIX}Hotel`, websiteUrl: "https://hotel.example",
      contactName: "C", contactEmail: "c@t.local",
      siteId: `${PREFIX}site-${Date.now()}`, conversionMethod: "both",
    },
  });

  // ── The synthetic influencer, exactly as an agency member would create it ──
  const influencer = await prisma.influencer.create({
    data: { agencyId: agency.id, hotelClientId: hotel.id, name: INFLUENCER_NAME, instagramHandle: "test_influencer" },
  });

  const piece = await prisma.contentPiece.create({
    data: {
      agencyId: agency.id, hotelClientId: hotel.id,
      title: "TEST_INFLUENCER_CAMPAIGN",
      contentType: "influencer", platform: "instagram",
      destinationUrl: "https://hotel.example/rooms",
      utmLink: "",
      influencerName: "TEST_INFLUENCER",   // legacy label, NOT the identity
      influencerId: influencer.id,          // the deterministic link
    },
  });
  const utmLink = buildUtmLink({
    destinationUrl: "https://hotel.example/rooms",
    source: "instagram", medium: "influencer",
    title: "TEST_INFLUENCER_CAMPAIGN",
    contentPieceId: piece.id, agencyId: agency.id,
  });
  await prisma.contentPiece.update({ where: { id: piece.id }, data: { utmLink } });

  await prisma.couponCode.create({
    data: { agencyId: agency.id, hotelClientId: hotel.id, influencerId: influencer.id, code: COUPON, status: "ACTIVE" },
  });

  // A second agency + influencer, for isolation checks.
  const other = await prisma.agency.create({
    data: { name: `${PREFIX}B`, email: `${PREFIX.toLowerCase()}b@x.test`, subscriptionStatus: "active" },
  });
  const otherHotel = await prisma.hotelClient.create({
    data: {
      agencyId: other.id, name: `${PREFIX}Other`, websiteUrl: "https://other.example",
      contactName: "C", contactEmail: "c@t.local",
      siteId: `${PREFIX}site-other-${Date.now()}`, conversionMethod: "both",
    },
  });
  const otherInfluencer = await prisma.influencer.create({
    data: { agencyId: other.id, hotelClientId: otherHotel.id, name: "TEST_INFLUENCER" }, // SAME display name
  });

  fx = {
    agencyId: agency.id, memberId: member.id, hotelId: hotel.id, siteId: hotel.siteId,
    influencerId: influencer.id, contentPieceId: piece.id, utmLink,
    otherAgencyId: other.id, otherHotelId: otherHotel.id, otherInfluencerId: otherInfluencer.id,
  };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

// ── A5 — URL route: URL → Session → Touchpoint → Influencer → Conversion ──

describe("A5 — URL route", () => {
  test("the generated URL is the real builder's output and resolves to the ContentPiece", () => {
    const utmContent = new URL(fx.utmLink).searchParams.get("utm_content");
    expect(contentPieceIdFromUtmContent(utmContent)).toBe(fx.contentPieceId);
  });

  test("a visit through the URL creates Session + TrackingEvent carrying utm_content", async () => {
    const p = new URL(fx.utmLink).searchParams;
    const sessionId = sess();
    const visitorId = vis();

    await post({
      siteId: fx.siteId, type: "pageview", v: "2.4.0", sessionId, visitorId,
      pagePath: "/rooms", pageUrl: fx.utmLink, timestamp: Date.now(), deviceType: "desktop",
      utmSource: p.get("utm_source"), utmMedium: p.get("utm_medium"),
      utmCampaign: p.get("utm_campaign"), utmContent: p.get("utm_content"),
    });

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { utmSource: true, utmMedium: true, utmContent: true, hotelClientId: true },
    });
    expect(session?.hotelClientId).toBe(fx.hotelId);
    expect(session?.utmSource).toBe("instagram");
    expect(session?.utmMedium).toBe("influencer");
    expect(contentPieceIdFromUtmContent(session?.utmContent)).toBe(fx.contentPieceId);
  });

  test("the conversion resolves DETERMINISTICALLY to the influencer", async () => {
    const p = new URL(fx.utmLink).searchParams;
    const sessionId = sess();
    await post({
      siteId: fx.siteId, type: "conversion", v: "2.4.0", sessionId, visitorId: vis(),
      pageUrl: "https://hotel.example/thank-you", deviceType: "desktop", value: 12500,
      utmSource: p.get("utm_source"), utmMedium: p.get("utm_medium"),
      utmCampaign: p.get("utm_campaign"), utmContent: p.get("utm_content"),
      journey: [{ ts: Date.now() - 60_000, utm_source: "instagram", utm_medium: "influencer", utm_content: p.get("utm_content") }],
    });

    const conv = await prisma.trackingEvent.findFirstOrThrow({
      where: { sessionId, eventType: "conversion" },
      select: {
        id: true, utmSource: true, utmMedium: true, utmContent: true,
        gclid: true, gbraid: true, wbraid: true, fbclid: true,
      },
    });
    expect(classifySourceType(conv)).toBe("influencer");

    const resolved = await resolveInfluencerFromUtmContent({
      agencyId: fx.agencyId, hotelClientId: fx.hotelId, utmContent: conv.utmContent,
    });
    expect(resolved).toEqual({ influencerId: fx.influencerId, contentPieceId: fx.contentPieceId, route: "utm_content" });

    // A Touchpoint was flushed for the acquisition click.
    const touches = await prisma.touchpoint.findMany({ where: { conversionId: conv.id } });
    expect(touches.length).toBeGreaterThan(0);
    expect(touches[0].utmMedium).toBe("influencer");
  });
});

// ── A4/A5 — Coupon route, and both routes agreeing ───────────────────────

describe("A4/A5 — coupon route", () => {
  test("a coupon conversion creates an InfluencerRedemption for the SAME influencer", async () => {
    const sessionId = sess();
    await post({
      siteId: fx.siteId, type: "conversion", v: "2.4.0", sessionId, visitorId: vis(),
      pageUrl: "https://hotel.example/thank-you", deviceType: "desktop", value: 9000,
      couponCodeUsed: COUPON,
    });

    const conv = await prisma.trackingEvent.findFirstOrThrow({
      where: { sessionId, eventType: "conversion" },
      select: { id: true, couponCodeUsed: true },
    });
    expect(conv.couponCodeUsed).toBe(COUPON);

    const redemption = await prisma.influencerRedemption.findFirstOrThrow({
      where: { trackingEventId: conv.id },
      select: { influencerId: true, redemptionSource: true, bookingValue: true },
    });
    expect(redemption.influencerId).toBe(fx.influencerId);
    expect(redemption.redemptionSource).toBe("snippet_auto");
    expect(Number(redemption.bookingValue)).toBe(9000);
  });

  test("the coupon resolver returns the same influencer as the URL resolver", async () => {
    const viaCoupon = await resolveInfluencerFromCoupon({
      agencyId: fx.agencyId, hotelClientId: fx.hotelId, couponCode: COUPON,
    });
    const viaUtm = await resolveInfluencerFromUtmContent({
      agencyId: fx.agencyId, hotelClientId: fx.hotelId,
      utmContent: new URL(fx.utmLink).searchParams.get("utm_content"),
    });
    expect(viaCoupon?.influencerId).toBe(fx.influencerId);
    expect(viaUtm?.influencerId).toBe(fx.influencerId);
    expect(viaCoupon?.influencerId).toBe(viaUtm?.influencerId); // A4's requirement
  });

  test("URL + coupon together resolve once, with no conflict", async () => {
    const { resolution, conflict } = await resolveInfluencerForConversion({
      agencyId: fx.agencyId, hotelClientId: fx.hotelId,
      utmContent: new URL(fx.utmLink).searchParams.get("utm_content"),
      couponCode: COUPON,
    });
    expect(conflict).toBe(false);
    expect(resolution?.influencerId).toBe(fx.influencerId);
  });

  test("a DISAGREEMENT between the two routes is surfaced, not silently resolved", async () => {
    const rival = await prisma.influencer.create({
      data: { agencyId: fx.agencyId, hotelClientId: fx.hotelId, name: "TEST_INFLUENCER_RIVAL" },
    });
    const rivalCode = "TESTRIVALCODE";
    await prisma.couponCode.create({
      data: { agencyId: fx.agencyId, hotelClientId: fx.hotelId, influencerId: rival.id, code: rivalCode, status: "ACTIVE" },
    });

    const { resolution, conflict } = await resolveInfluencerForConversion({
      agencyId: fx.agencyId, hotelClientId: fx.hotelId,
      utmContent: new URL(fx.utmLink).searchParams.get("utm_content"), // influencer A
      couponCode: rivalCode,                                           // influencer B
    });
    expect(conflict).toBe(true);
    expect(resolution?.influencerId).toBe(rival.id); // coupon preferred, conflict flagged
  });
});

// ── Isolation: identical display names must not collide ──────────────────

describe("tenant isolation", () => {
  test("two influencers with the SAME NAME in different agencies never collide", async () => {
    // This is precisely what name-matching could not do.
    const fromOther = await resolveInfluencerFromUtmContent({
      agencyId: fx.otherAgencyId, hotelClientId: fx.otherHotelId,
      utmContent: new URL(fx.utmLink).searchParams.get("utm_content"),
    });
    expect(fromOther).toBeNull();
    expect(fx.influencerId).not.toBe(fx.otherInfluencerId);
  });

  test("another hotel's coupon code does not resolve", async () => {
    const r = await resolveInfluencerFromCoupon({
      agencyId: fx.otherAgencyId, hotelClientId: fx.otherHotelId, couponCode: COUPON,
    });
    expect(r).toBeNull();
  });
});

// ── A4 — the influencer REPORT sees both routes, and counts each booking once ──

describe("influencer channel report", () => {
  const RANGE_START = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const RANGE_END = new Date(Date.now() + 60 * 60 * 1000);

  const load = async () => {
    // agencyScoped() funnels through getAgencyContext(), which is also the staff
    // read gate (lib/tenant.ts) — so the mocked member needs a staff-domain
    // email and the AgencyMember `role`, exactly as tests/channel-view.test.ts
    // does it. Without them the loader throws TenantAuthError before any query.
    h.member = { id: fx.memberId, agencyId: fx.agencyId, email: "a@socialhippi.com", role: "admin" };
    const view = (await loadChannelView(fx.hotelId, "influencer", RANGE_START, RANGE_END)) as InfluencerChannelView;
    return view;
  };
  const rowFor = (v: InfluencerChannelView, name: string) =>
    v.topInfluencers.find((r) => r.influencerName === name);

  test("a LINK conversion with NO coupon is credited to the influencer", async () => {
    const sessionId = sess();
    const visitorId = vis();
    const utmContent = new URL(fx.utmLink).searchParams.get("utm_content");

    await post({
      siteId: fx.siteId, type: "conversion", v: "2.4.0", sessionId, visitorId,
      pageUrl: `https://hotel.example/thank-you`, deviceType: "desktop", value: 7000,
      utmSource: "instagram", utmMedium: "influencer", utmContent,
      // No couponCodeUsed — this is exactly the booking the old report missed.
    });

    const view = await load();
    expect(view.kpis.linkAttributedBookings).toBeGreaterThanOrEqual(1);
    expect(view.kpis.linkAttributedRevenue).toBeGreaterThanOrEqual(7000);

    const row = rowFor(view, INFLUENCER_NAME);
    expect(row).toBeDefined();
    expect(row!.linkBookings).toBeGreaterThanOrEqual(1);
    expect(row!.linkRevenue).toBeGreaterThanOrEqual(7000);
  });

  test("a conversion using the coupon is counted ONCE, as a redemption", async () => {
    const before = await load();
    const beforeLink = before.kpis.linkAttributedRevenue;
    const beforeCoupon = before.kpis.totalRevenue;

    const sessionId = sess();
    await post({
      siteId: fx.siteId, type: "conversion", v: "2.4.0", sessionId, visitorId: vis(),
      pageUrl: "https://hotel.example/thank-you", deviceType: "desktop", value: 9000,
      // BOTH signals present: the link tag AND the coupon.
      utmSource: "instagram", utmMedium: "influencer",
      utmContent: new URL(fx.utmLink).searchParams.get("utm_content"),
      couponCodeUsed: COUPON,
    });

    const after = await load();
    // Coupon revenue grew by the booking value...
    expect(after.kpis.totalRevenue - beforeCoupon).toBe(9000);
    // ...and link revenue did NOT also grow. One booking, one count.
    expect(after.kpis.linkAttributedRevenue).toBe(beforeLink);
  });

  test("the combined total equals coupon revenue plus link revenue", async () => {
    const view = await load();
    const row = rowFor(view, INFLUENCER_NAME);
    expect(row!.attributedRevenue).toBe(row!.revenue + row!.linkRevenue);
  });

  test("a hand-written utm_content is not credited to anyone", async () => {
    const before = await load();
    await post({
      siteId: fx.siteId, type: "conversion", v: "2.4.0", sessionId: sess(), visitorId: vis(),
      pageUrl: "https://hotel.example/thank-you", deviceType: "desktop", value: 5000,
      utmSource: "instagram", utmMedium: "influencer", utmContent: "summer-reel",
    });
    const after = await load();
    expect(after.kpis.linkAttributedRevenue).toBe(before.kpis.linkAttributedRevenue);
  });
});
