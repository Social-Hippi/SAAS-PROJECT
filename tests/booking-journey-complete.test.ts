import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// THE COMPLETE LOOP, proven against real rows:
//
//   INFLUENCER -> unique URL -> Aster website -> SESSION -> JOURNEY TOKEN
//     -> booking engine -> BOOKING PUSH -> Booking -> external booking id
//     -> REVENUE -> BookingJourneyMatch -> INFLUENCER -> attribution
//
// The provider payload mapping is still pending, so these drive the canonical
// event directly — exactly what the Simplotel adapter will emit once its sample
// payload arrives. Everything downstream of that boundary is real.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { POST as trackPOST } from "@/app/api/track/event/route";
import { buildUtmLink } from "@/lib/utm";
import { encodeJourneyToken, decodeJourneyToken } from "@/lib/journey-token";
import { ingestBookingEvent } from "@/lib/booking-ingest";
import { resolveInfluencerFromUtmContent } from "@/lib/influencer-resolve";
import { hashGuestEmail } from "@/lib/booking-identity";

const PREFIX = "TEST_LOOP_";
const SITE_HOST = "loop-hotel.example";
const BOOKING_HOST = "bookings.loop-hotel.example";
const LANDING = "/coffeeberry-hills/";
const INFLUENCER_NAME = "TEST_LOOP_INFLUENCER";
const GUEST_EMAIL = "loop.guest@example.test";

type Fx = {
  agencyId: string; hotelId: string; siteId: string;
  influencerId: string; contentPieceId: string; utmLink: string;
  conn: { id: string; agencyId: string; hotelClientId: string; provider: string };
};
let fx: Fx;

const post = (body: Record<string, unknown>, origin: string) =>
  trackPOST(new Request("http://localhost/api/track/event", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", "x-forwarded-for": "203.0.113.9", origin: `https://${origin}` },
    body: JSON.stringify(body),
  }));

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const agency = await prisma.agency.create({
    data: { name: `${PREFIX}A`, email: `${PREFIX.toLowerCase()}a@x.test`, subscriptionStatus: "active" },
  });
  const hotel = await prisma.hotelClient.create({
    data: {
      agencyId: agency.id, name: `${PREFIX}Hotel`, websiteUrl: `https://${SITE_HOST}`,
      contactName: "C", contactEmail: "c@t.local",
      siteId: `${PREFIX}site-${Date.now()}`, conversionMethod: "url_change",
      bookingDomains: [BOOKING_HOST],
    },
  });
  const influencer = await prisma.influencer.create({
    data: { agencyId: agency.id, hotelClientId: hotel.id, name: INFLUENCER_NAME, instagramHandle: "loop_inf" },
  });
  const piece = await prisma.contentPiece.create({
    data: {
      agencyId: agency.id, hotelClientId: hotel.id, title: `${PREFIX}Reel`,
      contentType: "influencer", platform: "instagram",
      destinationUrl: `https://${SITE_HOST}${LANDING}`, utmLink: "",
      influencerName: INFLUENCER_NAME, influencerId: influencer.id,
    },
    select: { id: true },
  });
  const utmLink = buildUtmLink({
    destinationUrl: `https://${SITE_HOST}${LANDING}`, source: "instagram", medium: "influencer",
    title: "loop campaign", contentPieceId: piece.id, agencyId: agency.id,
  });
  await prisma.contentPiece.update({ where: { id: piece.id }, data: { utmLink } });
  const conn = await prisma.bookingConnection.create({
    data: { agencyId: agency.id, hotelClientId: hotel.id, provider: "simplotel", status: "active" },
    select: { id: true, agencyId: true, hotelClientId: true, provider: true },
  });

  fx = {
    agencyId: agency.id, hotelId: hotel.id, siteId: hotel.siteId,
    influencerId: influencer.id, contentPieceId: piece.id, utmLink, conn,
  };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe("influencer click → booking → revenue → attribution", () => {
  const sessionId = `sess_${randomUUID()}`;
  const visitorId = `vis_${randomUUID()}`;
  const externalBookingId = `SIMPL-${randomUUID().slice(0, 12)}`;
  let bookingId: string;

  test("1. influencer click lands on the hotel site and creates the session", async () => {
    const q = new URL(fx.utmLink).searchParams;
    await post({
      siteId: fx.siteId, type: "pageview", v: "2.5.0", sessionId, visitorId,
      pagePath: LANDING, pageUrl: fx.utmLink, timestamp: Date.now(), deviceType: "desktop",
      utmSource: q.get("utm_source"), utmMedium: q.get("utm_medium"),
      utmCampaign: q.get("utm_campaign"), utmContent: q.get("utm_content"),
    }, SITE_HOST);
    const s = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.utmContent).toBe(`ht-${fx.contentPieceId}`);
  });

  test("2. journey token carries the visit to the booking engine", async () => {
    const q = new URL(fx.utmLink).searchParams;
    const token = encodeJourneyToken({
      sessionId, visitorId, now: Date.now(),
      utms: { utm_source: q.get("utm_source"), utm_medium: q.get("utm_medium"), utm_content: q.get("utm_content") },
    })!;
    const p = decodeJourneyToken(token, Date.now())!;
    await post({
      siteId: fx.siteId, type: "pageview", v: "2.5.0", sessionId: p.s, visitorId: p.i,
      pagePath: "/booking", pageUrl: `https://${BOOKING_HOST}/?propertyId=8642`,
      timestamp: Date.now(), deviceType: "desktop",
      utmSource: p.u.utm_source, utmMedium: p.u.utm_medium, utmContent: p.u.utm_content,
    }, BOOKING_HOST);

    const s = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.pageViewCount).toBe(2);
    // Being ON the booking engine is evidence of booking INTENT.
    const pv = await prisma.pageView.findFirstOrThrow({ where: { sessionId, pagePath: "/booking" } });
    expect(pv.funnelStage).toBe("intent");
  });

  test("3. BOOKING PUSH creates the Booking with AUTHORITATIVE revenue", async () => {
    const r = await ingestBookingEvent(fx.conn, {
      eventType: "BOOKING_CREATED",
      provider: "simplotel",
      externalBookingId,
      occurredAt: new Date().toISOString(),
      status: "CONFIRMED",
      currency: "INR",
      amounts: { gross: 24000, tax: 2400 },
      guest: { email: GUEST_EMAIL },
      journey: { sessionId, visitorId },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    bookingId = r.bookingId;

    const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(b.externalBookingId).toBe(externalBookingId);
    expect(Number(b.grossAmount)).toBe(24000);
    expect(Number(b.taxAmount)).toBe(2400);
    expect(b.currency).toBe("INR");
    expect(b.journeySessionId).toBe(sessionId);
    // Raw PII is never stored — only the reproducible hash.
    expect(b.guestEmailHash).toBe(hashGuestEmail(GUEST_EMAIL));
    expect(JSON.stringify(b)).not.toContain(GUEST_EMAIL);
  });

  test("4. the booking matches the journey DETERMINISTICALLY by session id", async () => {
    const m = await prisma.bookingJourneyMatch.findMany({ where: { bookingId } });
    expect(m).toHaveLength(1);
    expect(m[0].matchMethod).toBe("session_id");
    expect(m[0].matchConfidence).toBe("DETERMINISTIC");
    expect(m[0].visitorId).toBe(visitorId);
  });

  test("5. the match resolves back to the INFLUENCER through the session", async () => {
    const match = await prisma.bookingJourneyMatch.findFirstOrThrow({ where: { bookingId } });
    const session = await prisma.session.findFirstOrThrow({
      where: { visitorId: match.visitorId!, hotelClientId: fx.hotelId },
    });
    const r = await resolveInfluencerFromUtmContent({
      agencyId: fx.agencyId, hotelClientId: fx.hotelId, utmContent: session.utmContent,
    });
    expect(r?.influencerId).toBe(fx.influencerId);      // FK, never a name
    expect(r?.contentPieceId).toBe(fx.contentPieceId);
  });

  test("6. a RETRIED push creates no duplicate booking", async () => {
    const before = await prisma.booking.count({ where: { hotelClientId: fx.hotelId } });
    const r = await ingestBookingEvent(fx.conn, {
      eventType: "BOOKING_CREATED", provider: "simplotel", externalBookingId,
      occurredAt: new Date().toISOString(), status: "CONFIRMED",
      currency: "INR", amounts: { gross: 24000 }, journey: { sessionId, visitorId },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.created).toBe(false);
    expect(await prisma.booking.count({ where: { hotelClientId: fx.hotelId } })).toBe(before);
  });

  test("7. a MODIFICATION updates value and appends lifecycle history", async () => {
    const r = await ingestBookingEvent(fx.conn, {
      eventType: "BOOKING_UPDATED", provider: "simplotel", externalBookingId,
      occurredAt: new Date().toISOString(), status: "MODIFIED",
      currency: "INR", amounts: { gross: 31000 }, journey: { sessionId, visitorId },
    });
    expect(r.ok).toBe(true);
    const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(Number(b.grossAmount)).toBe(31000);
    expect((await prisma.bookingStatusEvent.findMany({ where: { bookingId } })).length).toBeGreaterThan(1);
  });

  test("8. a CANCELLATION is recorded without erasing history", async () => {
    await ingestBookingEvent(fx.conn, {
      eventType: "BOOKING_CANCELLED", provider: "simplotel", externalBookingId,
      occurredAt: new Date().toISOString(), status: "CANCELLED",
    });
    const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(b.status).toBe("CANCELLED");
    const history = await prisma.bookingStatusEvent.findMany({ where: { bookingId }, orderBy: { occurredAt: "asc" } });
    expect(history.length).toBeGreaterThanOrEqual(3); // created + modified + cancelled
  });

  test("9. a booking with NO journey and NO identifiers is UNKNOWN, never guessed", async () => {
    const r = await ingestBookingEvent(fx.conn, {
      eventType: "BOOKING_CREATED", provider: "simplotel",
      externalBookingId: `SIMPL-ORPHAN-${randomUUID().slice(0, 8)}`,
      occurredAt: new Date().toISOString(), status: "CONFIRMED",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = await prisma.bookingJourneyMatch.findFirstOrThrow({ where: { bookingId: r.bookingId } });
    expect(m.matchMethod).toBe("unknown");
    expect(m.matchConfidence).toBe("UNKNOWN");
    expect(m.visitorId).toBeNull();
  });

  test("10. a journey id from ANOTHER hotel never matches", async () => {
    const other = await prisma.agency.create({
      data: { name: `${PREFIX}B`, email: `${PREFIX.toLowerCase()}b@x.test`, subscriptionStatus: "active" },
    });
    const otherHotel = await prisma.hotelClient.create({
      data: {
        agencyId: other.id, name: `${PREFIX}HotelB`, websiteUrl: "https://loop-b.example",
        contactName: "C", contactEmail: "c@t.local",
        siteId: `${PREFIX}siteB-${Date.now()}`, conversionMethod: "url_change",
      },
    });
    const otherConn = await prisma.bookingConnection.create({
      data: { agencyId: other.id, hotelClientId: otherHotel.id, provider: "simplotel", status: "active" },
      select: { id: true, agencyId: true, hotelClientId: true, provider: true },
    });
    const r = await ingestBookingEvent(otherConn, {
      eventType: "BOOKING_CREATED", provider: "simplotel",
      externalBookingId: `SIMPL-XT-${randomUUID().slice(0, 8)}`,
      occurredAt: new Date().toISOString(), status: "CONFIRMED",
      journey: { sessionId, visitorId },   // hotel A's journey
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = await prisma.bookingJourneyMatch.findFirstOrThrow({ where: { bookingId: r.bookingId } });
    expect(m.matchMethod).toBe("unknown");   // hotel-scoped: no cross-tenant match
    expect(m.visitorId).toBeNull();
  });

  test("11. missing revenue stays NULL — never defaulted to zero", async () => {
    const r = await ingestBookingEvent(fx.conn, {
      eventType: "BOOKING_CREATED", provider: "simplotel",
      externalBookingId: `SIMPL-NOAMT-${randomUUID().slice(0, 8)}`,
      occurredAt: new Date().toISOString(), status: "CONFIRMED",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = await prisma.booking.findUniqueOrThrow({ where: { id: r.bookingId } });
    expect(b.grossAmount).toBeNull();
    expect(b.currency).toBeNull();   // never invented
  });
});
