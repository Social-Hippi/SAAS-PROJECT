import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Influencer Performance dashboard — server-side aggregation.
//
// The point of these is that the dashboard tells the TRUTH: it counts what was
// recorded, refuses to count what was not, keeps the two revenue streams apart,
// and never credits a booking to an influencer on weak evidence.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { loadInfluencerPerformance } from "@/lib/influencer-performance";
import { loadInfluencerJourneys, loadJourneyDetail, maskGuestName } from "@/lib/influencer-journeys";
import { buildUtmLink } from "@/lib/utm";
import { ingestBookingEvent } from "@/lib/booking-ingest";

const PREFIX = "TEST_IPERF_";
const HOST = "iperf-hotel.example";
const BOOKING_HOST = "bookings.iperf-hotel.example";
const RANGE = { since: new Date(Date.now() - 7 * 864e5), until: new Date(Date.now() + 864e5) };

type Fx = {
  agencyId: string; hotelId: string; hotelBId: string; siteId: string;
  infA: string; infB: string; pieceA: string; pieceB: string;
  connId: { id: string; agencyId: string; hotelClientId: string; provider: string };
  otherAgencyId: string; otherInfluencerId: string;
};
let fx: Fx;

async function mkSession(o: {
  hotelId: string; pieceId: string; visitorId?: string; intent?: boolean; coupon?: string | null;
}) {
  const sessionId = `sess_${randomUUID()}`;
  const visitorId = o.visitorId ?? `vis_${randomUUID()}`;
  await prisma.session.create({
    data: {
      id: sessionId, visitorId, hotelClientId: o.hotelId, agencyId: fx.agencyId,
      startedAt: new Date(), landingPath: "/rooms", exitPath: "/rooms", pageViewCount: o.intent ? 2 : 1,
      utmSource: "instagram", utmMedium: "influencer", utmCampaign: "camp",
      utmContent: `ht-${o.pieceId}`,
    },
  });
  await prisma.pageView.create({
    data: {
      sessionId, visitorId, hotelClientId: o.hotelId, agencyId: fx.agencyId,
      pagePath: "/rooms", enteredAt: new Date(), funnelStage: null,
    },
  });
  if (o.intent) {
    await prisma.pageView.create({
      data: {
        sessionId, visitorId, hotelClientId: o.hotelId, agencyId: fx.agencyId,
        pagePath: "/booking", enteredAt: new Date(), funnelStage: "intent",
      },
    });
  }
  if (o.coupon) {
    await prisma.trackingEvent.create({
      data: {
        agencyId: fx.agencyId, hotelClientId: o.hotelId, eventType: "conversion",
        sessionId, visitorId, couponCodeUsed: o.coupon, utmContent: `ht-${o.pieceId}`,
        pageUrl: `https://${HOST}/thank-you`, deviceType: "desktop",
      },
    });
  }
  return { sessionId, visitorId };
}

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const agency = await prisma.agency.create({
    data: { name: `${PREFIX}A`, email: `${PREFIX.toLowerCase()}a@x.test`, subscriptionStatus: "active" },
  });
  const mkHotel = (tag: string, domains: string[]) =>
    prisma.hotelClient.create({
      data: {
        agencyId: agency.id, name: `${PREFIX}${tag}`, websiteUrl: `https://${tag}.${HOST}`,
        contactName: "C", contactEmail: "c@t.local",
        siteId: `${PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        conversionMethod: "url_change", bookingDomains: domains,
      },
    });
  const hotel = await mkHotel("H1", [BOOKING_HOST]);
  const hotelB = await mkHotel("H2", []);

  const mkInf = (name: string, hotelId: string) =>
    prisma.influencer.create({ data: { agencyId: agency.id, hotelClientId: hotelId, name, instagramHandle: name.toLowerCase() } });
  const infA = await mkInf(`${PREFIX}Alpha`, hotel.id);
  const infB = await mkInf(`${PREFIX}Beta`, hotel.id);

  const mkPiece = async (influencerId: string, hotelId: string, tag: string) => {
    const p = await prisma.contentPiece.create({
      data: {
        agencyId: agency.id, hotelClientId: hotelId, title: `${PREFIX}${tag}`,
        contentType: "influencer", platform: "instagram",
        destinationUrl: `https://${HOST}/rooms`, utmLink: "", influencerId,
      },
      select: { id: true },
    });
    await prisma.contentPiece.update({
      where: { id: p.id },
      data: { utmLink: buildUtmLink({ destinationUrl: `https://${HOST}/rooms`, source: "instagram", medium: "influencer", title: tag, contentPieceId: p.id, agencyId: agency.id }) },
    });
    return p.id;
  };
  const pieceA = await mkPiece(infA.id, hotel.id, "PieceA");
  const pieceB = await mkPiece(infB.id, hotel.id, "PieceB");

  const conn = await prisma.bookingConnection.create({
    data: { agencyId: agency.id, hotelClientId: hotel.id, provider: "simplotel", status: "active" },
    select: { id: true, agencyId: true, hotelClientId: true, provider: true },
  });

  const other = await prisma.agency.create({
    data: { name: `${PREFIX}OTHER`, email: `${PREFIX.toLowerCase()}o@x.test`, subscriptionStatus: "active" },
  });
  const otherHotel = await prisma.hotelClient.create({
    data: {
      agencyId: other.id, name: `${PREFIX}OtherHotel`, websiteUrl: "https://other.example",
      contactName: "C", contactEmail: "c@t.local",
      siteId: `${PREFIX}other-${Date.now()}`, conversionMethod: "url_change",
    },
  });
  const otherInf = await prisma.influencer.create({
    data: { agencyId: other.id, hotelClientId: otherHotel.id, name: `${PREFIX}Alpha` }, // SAME name
  });

  fx = {
    agencyId: agency.id, hotelId: hotel.id, hotelBId: hotelB.id, siteId: hotel.siteId,
    infA: infA.id, infB: infB.id, pieceA, pieceB, connId: conn,
    otherAgencyId: other.id, otherInfluencerId: otherInf.id,
  };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

const load = (over: Partial<Parameters<typeof loadInfluencerPerformance>[0]> = {}) =>
  loadInfluencerPerformance({ agencyId: fx.agencyId, ...RANGE, ...over });

// ── Availability: never a misleading zero ────────────────────────────────

describe("availability, not misleading zeroes", () => {
  test("link clicks are reported NOT OBSERVABLE, never as 0", async () => {
    const p = await load();
    expect(p.availability.linkClicks.state).toBe("not_observable");
    expect(p.funnel.linkClicks.state).toBe("not_observable");
  });

  test("checkout is reported NOT OBSERVABLE", async () => {
    expect((await load()).availability.checkout.state).toBe("not_observable");
  });

  test("ROAS is NOT CONFIGURED — no influencer cost exists in the data model", async () => {
    const r = (await load()).availability.roas;
    expect(r.state).toBe("not_configured");
    if (r.state !== "available") expect(r.reason).toMatch(/cost/i);
  });

  test("booking-engine availability follows bookingDomains configuration", async () => {
    expect((await load({ hotelClientIds: [fx.hotelId] })).availability.bookingEngine.state).toBe("available");
    expect((await load({ hotelClientIds: [fx.hotelBId] })).availability.bookingEngine.state).toBe("not_configured");
  });

  test("bookings availability follows whether a provider is connected", async () => {
    expect((await load({ hotelClientIds: [fx.hotelId] })).availability.bookings.state).toBe("available");
    expect((await load({ hotelClientIds: [fx.hotelBId] })).availability.bookings.state).toBe("not_configured");
  });
});

// ── Aggregation ──────────────────────────────────────────────────────────

describe("KPI aggregation", () => {
  test("zero state: no sessions, no invented numbers", async () => {
    const p = await load();
    expect(p.kpis.sessions).toBe(0);
    expect(p.kpis.confirmedBookings).toBe(0);
    expect(p.kpis.attributedRevenue).toBe(0);
    expect(p.kpis.bookingConversionRate).toBeNull(); // no sessions => no rate, not 0%
    expect(p.kpis.averageBookingValue).toBeNull();
  });

  test("sessions and booking-engine visits are counted from persisted rows", async () => {
    await mkSession({ hotelId: fx.hotelId, pieceId: fx.pieceA, intent: true });
    await mkSession({ hotelId: fx.hotelId, pieceId: fx.pieceA });
    await mkSession({ hotelId: fx.hotelId, pieceId: fx.pieceB, intent: true });

    const p = await load();
    expect(p.kpis.sessions).toBe(3);
    expect(p.kpis.bookingEngineVisits).toBe(2);
    const a = p.rows.find((r) => r.influencerId === fx.infA)!;
    expect(a.sessions).toBe(2);
    expect(a.bookingEngineVisits).toBe(1);
    expect(a.contentPieces).toBe(1);
  });

  test("date filtering excludes sessions outside the range", async () => {
    const p = await load({ since: new Date(Date.now() - 60 * 864e5), until: new Date(Date.now() - 30 * 864e5) });
    expect(p.kpis.sessions).toBe(0);
  });

  test("hotel filtering scopes the whole rollup", async () => {
    expect((await load({ hotelClientIds: [fx.hotelBId] })).kpis.sessions).toBe(0);
    expect((await load({ hotelClientIds: [fx.hotelId] })).kpis.sessions).toBeGreaterThan(0);
  });

  test("influencer filtering returns only that influencer", async () => {
    const p = await load({ influencerId: fx.infA });
    expect(p.rows.every((r) => r.influencerId === fx.infA)).toBe(true);
  });
});

// ── Attribution confidence + no double counting ──────────────────────────

describe("booking attribution", () => {
  let visitorId: string, sessionId: string;

  test("a DETERMINISTIC booking is attributed with authoritative revenue", async () => {
    const s = await mkSession({ hotelId: fx.hotelId, pieceId: fx.pieceA, intent: true });
    sessionId = s.sessionId; visitorId = s.visitorId;

    const r = await ingestBookingEvent(fx.connId, {
      eventType: "BOOKING_CREATED", provider: "simplotel",
      externalBookingId: `IPERF-${randomUUID().slice(0, 8)}`,
      occurredAt: new Date().toISOString(), status: "CONFIRMED",
      currency: "INR", amounts: { gross: 24000 },
      journey: { sessionId, visitorId },
    });
    expect(r.ok).toBe(true);

    const p = await load();
    const a = p.rows.find((x) => x.influencerId === fx.infA)!;
    expect(a.confirmedBookings).toBe(1);
    expect(a.attributedRevenue).toBe(24000);
    expect(a.currency).toBe("INR");
    expect(a.confidence).toBe("DETERMINISTIC");
    expect(p.kpis.averageBookingValue).toBe(24000);
  });

  test("currency is reported as stored — never assumed", async () => {
    const p = await load();
    expect(p.kpis.currency).toBe("INR");
    expect(p.kpis.mixedCurrency).toBe(false);
  });

  test("ONE booking is counted ONCE even with several journey matches", async () => {
    const before = (await load()).kpis.confirmedBookings;
    // A second match row pointing at the SAME booking must not add revenue.
    const booking = await prisma.booking.findFirstOrThrow({ where: { journeySessionId: sessionId } });
    await prisma.bookingJourneyMatch.create({
      data: {
        agencyId: fx.agencyId, hotelClientId: fx.hotelId, bookingId: booking.id,
        visitorId, matchMethod: "email_hash", matchConfidence: "STRONG", evidence: {},
      },
    });
    const after = await load();
    expect(after.kpis.confirmedBookings).toBe(before);
    expect(after.rows.find((r) => r.influencerId === fx.infA)!.attributedRevenue).toBe(24000);
  });

  test("a PARTIAL match is NOT credited, and is surfaced separately", async () => {
    const s = await mkSession({ hotelId: fx.hotelId, pieceId: fx.pieceB });
    const r = await ingestBookingEvent(fx.connId, {
      eventType: "BOOKING_CREATED", provider: "simplotel",
      externalBookingId: `IPERF-P-${randomUUID().slice(0, 8)}`,
      occurredAt: new Date().toISOString(), status: "CONFIRMED",
      currency: "INR", amounts: { gross: 99000 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await prisma.bookingJourneyMatch.deleteMany({ where: { bookingId: r.bookingId } });
    await prisma.bookingJourneyMatch.create({
      data: {
        agencyId: fx.agencyId, hotelClientId: fx.hotelId, bookingId: r.bookingId,
        visitorId: s.visitorId, matchMethod: "email_hash", matchConfidence: "PARTIAL", evidence: {},
      },
    });

    const p = await load();
    const b = p.rows.find((x) => x.influencerId === fx.infB)!;
    expect(b.confirmedBookings).toBe(0);            // never credited
    expect(b.attributedRevenue).toBeNull();
    expect(p.belowConfidenceFloor).toBeGreaterThan(0); // but reported
  });

  test("a CANCELLED booking is not counted as confirmed revenue", async () => {
    const before = (await load()).kpis.attributedRevenue;
    await ingestBookingEvent(fx.connId, {
      eventType: "BOOKING_CANCELLED", provider: "simplotel",
      externalBookingId: (await prisma.booking.findFirstOrThrow({ where: { journeySessionId: sessionId } })).externalBookingId,
      occurredAt: new Date().toISOString(), status: "CANCELLED",
    });
    const after = await load();
    expect(after.kpis.attributedRevenue).toBe((before ?? 0) - 24000);
  });
});

// ── The two revenue streams stay apart ───────────────────────────────────

describe("coupon revenue is a separate stream", () => {
  test("coupon redemptions are reported but never summed into booking revenue", async () => {
    const code = await prisma.couponCode.create({
      data: { code: `${PREFIX}CODE`, influencerId: fx.infA, hotelClientId: fx.hotelId, agencyId: fx.agencyId, status: "ACTIVE" },
    });
    await prisma.influencerRedemption.create({
      data: {
        couponCodeId: code.id, influencerId: fx.infA, hotelClientId: fx.hotelId, agencyId: fx.agencyId,
        bookingValue: "5000", redemptionSource: "manual_entry", redeemedAt: new Date(),
      },
    });
    const p = await load();
    const a = p.rows.find((r) => r.influencerId === fx.infA)!;
    expect(a.couponRedemptions).toBe(1);
    expect(a.couponRevenue).toBe(5000);
    // Booking revenue must NOT include the coupon amount.
    expect(a.attributedRevenue ?? 0).not.toBe(5000);
    expect(p.kpis.couponRevenue).toBe(5000);
    expect(a.activeCoupons).toBe(1);
  });
});

// ── Tenant isolation ─────────────────────────────────────────────────────

describe("tenant isolation", () => {
  test("another agency's identically-named influencer never appears", async () => {
    const p = await load();
    expect(p.rows.some((r) => r.influencerId === fx.otherInfluencerId)).toBe(false);
  });

  test("journeys for another agency's influencer are not readable", async () => {
    expect(await loadInfluencerJourneys({
      agencyId: fx.agencyId, influencerId: fx.otherInfluencerId, ...RANGE,
    })).toBeNull();
  });
});

// ── Journey detail + PII ─────────────────────────────────────────────────

describe("journeys and PII", () => {
  test("journey list exposes identity, campaign, tracked URL and coupon", async () => {
    const j = (await loadInfluencerJourneys({ agencyId: fx.agencyId, influencerId: fx.infA, ...RANGE }))!;
    expect(j.influencer.name).toBe(`${PREFIX}Alpha`);
    expect(j.influencer.trackedUrls[0].utmLink).toContain(`ht-${fx.pieceA}`);
    expect(j.influencer.coupons.map((c) => c.code)).toContain(`${PREFIX}CODE`);
    expect(j.journeys.length).toBeGreaterThan(0);
    expect(j.journeys[0].ref).toMatch(/^HT-[A-Z0-9]{6}$/);
  });

  test("a journey timeline marks uncaptured stages rather than zeroing them", async () => {
    const j = (await loadInfluencerJourneys({ agencyId: fx.agencyId, influencerId: fx.infA, ...RANGE }))!;
    const d = (await loadJourneyDetail({ agencyId: fx.agencyId, sessionId: j.journeys[0].sessionId }))!;
    expect(d.stages.map((s) => s.key)).toEqual([
      "click", "session", "pageviews", "interaction", "booking_engine", "booking", "revenue", "attribution",
    ]);
    // Interaction needs [data-ht-click] annotation, absent here — must be marked.
    const interaction = d.stages.find((s) => s.key === "interaction")!;
    expect(interaction.captured).toBe(false);
    expect(interaction.detail).toBeNull();
  });

  test("no raw guest email or phone is ever returned", async () => {
    const j = (await loadInfluencerJourneys({ agencyId: fx.agencyId, influencerId: fx.infA, ...RANGE }))!;
    const blob = JSON.stringify(j);
    expect(blob).not.toMatch(/@[a-z0-9-]+\.(test|com|in)/i);
    expect(blob).not.toMatch(/guestEmailHash|guestPhoneHash/);
  });

  test("guest names are masked to initials", () => {
    expect(maskGuestName("Priya Sharma")).toBe("P. S.");
    expect(maskGuestName(null)).toBeNull();
    expect(maskGuestName("   ")).toBeNull();
  });

  test("a journey from another agency is not readable by session id", async () => {
    const j = (await loadInfluencerJourneys({ agencyId: fx.agencyId, influencerId: fx.infA, ...RANGE }))!;
    expect(await loadJourneyDetail({ agencyId: fx.otherAgencyId, sessionId: j.journeys[0].sessionId })).toBeNull();
  });
});
