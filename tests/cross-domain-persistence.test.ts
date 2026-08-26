import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Cross-domain handoff — DATABASE half.
//
// Reproduces the exact production journey that failed on Aster Holidays:
//
//   asterholidays.com  (influencer URL: instagram/influencer/krishitha-panda)
//     -> booking CTA
//   bookings.coffeeberryhills.in  (different origin: no cookies, no UTMs)
//
// Before the handoff, the second hop began as a brand-new visitor with no
// attribution and the influencer was lost. These tests drive the REAL ingest
// route with the REAL token codec and assert the persisted rows — not that a
// query parameter exists.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { POST as trackPOST } from "@/app/api/track/event/route";
import { buildUtmLink } from "@/lib/utm";
import { encodeJourneyToken, decodeJourneyToken, isBookingDomain } from "@/lib/journey-token";
import { resolveInfluencerFromUtmContent } from "@/lib/influencer-resolve";
import { classifySourceType } from "@/lib/source-classifier";

const PREFIX = "TEST_XD_";
const BOOKING_HOST = "bookings.coffeeberryhills.in";
const SITE_HOST = "asterholidays.com";
const LANDING = "/coffeeberry-hills-chikmagalur-resort/";
const INFLUENCER_NAME = "TEST_XD_INFLUENCER";

type Fx = {
  agencyId: string; hotelId: string; siteId: string;
  influencerId: string; contentPieceId: string; utmLink: string;
};
let fx: Fx;

function post(body: Record<string, unknown>, origin: string) {
  return trackPOST(
    new Request("http://localhost/api/track/event", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        "x-forwarded-for": "203.0.113.77",
        origin: `https://${origin}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

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
    data: { agencyId: agency.id, hotelClientId: hotel.id, name: INFLUENCER_NAME, instagramHandle: "xd_influencer" },
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
    destinationUrl: `https://${SITE_HOST}${LANDING}`,
    source: "instagram", medium: "influencer", title: "krishitha panda",
    contentPieceId: piece.id, agencyId: agency.id,
  });
  await prisma.contentPiece.update({ where: { id: piece.id }, data: { utmLink } });

  fx = {
    agencyId: agency.id, hotelId: hotel.id, siteId: hotel.siteId,
    influencerId: influencer.id, contentPieceId: piece.id, utmLink,
  };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe("the Aster journey, across two origins, persisted", () => {
  const sessionId = `sess_${randomUUID()}`;
  const visitorId = `vis_${randomUUID()}`;
  let token: string;

  test("1. bookingDomains is stored and the CTA host matches the allowlist", async () => {
    const h = await prisma.hotelClient.findUniqueOrThrow({
      where: { id: fx.hotelId }, select: { bookingDomains: true },
    });
    expect(h.bookingDomains).toContain(BOOKING_HOST);
    expect(isBookingDomain(BOOKING_HOST, h.bookingDomains)).toBe(true);
    expect(isBookingDomain("evil-coffeeberryhills.in", h.bookingDomains)).toBe(false);
  });

  test("2. ORIGIN: the influencer landing persists a Session with the full UTM set", async () => {
    const q = new URL(fx.utmLink).searchParams;
    await post({
      siteId: fx.siteId, type: "pageview", v: "2.5.0", sessionId, visitorId,
      pagePath: LANDING, pageUrl: fx.utmLink, timestamp: Date.now(), deviceType: "desktop",
      utmSource: q.get("utm_source"), utmMedium: q.get("utm_medium"),
      utmCampaign: q.get("utm_campaign"), utmContent: q.get("utm_content"), utmTerm: q.get("utm_term"),
    }, SITE_HOST);

    const s = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.hotelClientId).toBe(fx.hotelId);
    expect(s.utmSource).toBe("instagram");
    expect(s.utmMedium).toBe("influencer");
    expect(s.utmContent).toBe(`ht-${fx.contentPieceId}`);
    expect(s.landingPath).toBe(LANDING);
    expect(s.pageViewCount).toBe(1);
  });

  test("3. the booking CTA mints a token carrying that journey", () => {
    const q = new URL(fx.utmLink).searchParams;
    token = encodeJourneyToken({
      sessionId, visitorId, now: Date.now(),
      utms: {
        utm_source: q.get("utm_source"), utm_medium: q.get("utm_medium"),
        utm_campaign: q.get("utm_campaign"), utm_content: q.get("utm_content"),
      },
    })!;
    const p = decodeJourneyToken(token, Date.now())!;
    expect(p.s).toBe(sessionId);
    expect(p.i).toBe(visitorId);
    expect(p.u.utm_content).toBe(`ht-${fx.contentPieceId}`);
  });

  test("4. DESTINATION: the booking-engine beacon is ACCEPTED and joins the same session", async () => {
    const p = decodeJourneyToken(token, Date.now())!;   // what the receiving snippet does
    const res = await post({
      siteId: fx.siteId, type: "pageview", v: "2.5.0",
      sessionId: p.s, visitorId: p.i,                    // adopted, not invented
      pagePath: "/booking", pageUrl: `https://${BOOKING_HOST}/?propertyId=8642`,
      timestamp: Date.now(), deviceType: "desktop",
      utmSource: p.u.utm_source, utmMedium: p.u.utm_medium,
      utmCampaign: p.u.utm_campaign, utmContent: p.u.utm_content,
    }, BOOKING_HOST);
    expect(res.status).toBeLessThan(400);

    // ONE session spanning both origins — not two.
    const sessions = await prisma.session.findMany({ where: { visitorId } });
    expect(sessions).toHaveLength(1);

    const s = sessions[0];
    expect(s.id).toBe(sessionId);
    expect(s.pageViewCount).toBe(2);
    expect(s.landingPath).toBe(LANDING);   // origin landing NOT overwritten
    expect(s.exitPath).toBe("/booking");   // moved to the booking engine
    expect(s.utmSource).toBe("instagram"); // attribution NOT overwritten
    expect(s.utmContent).toBe(`ht-${fx.contentPieceId}`);
  });

  test("5. both origins' pageviews are persisted under that one session", async () => {
    const pvs = await prisma.pageView.findMany({ where: { sessionId }, orderBy: { enteredAt: "asc" } });
    expect(pvs.map((p) => p.pagePath)).toEqual([LANDING, "/booking"]);
    expect(pvs.every((p) => p.hotelClientId === fx.hotelId)).toBe(true);
  });

  test("6. the booking-engine TrackingEvent retains the influencer attribution", async () => {
    const ev = await prisma.trackingEvent.findFirstOrThrow({
      where: { sessionId, pageUrl: { contains: BOOKING_HOST } },
    });
    expect(ev.utmSource).toBe("instagram");
    expect(ev.utmMedium).toBe("influencer");
    expect(ev.utmContent).toBe(`ht-${fx.contentPieceId}`);
    expect(ev.visitorId).toBe(visitorId);
    expect(classifySourceType(ev)).toBe("influencer");
  });

  test("7. ContentPiece and Influencer resolve FROM the booking-engine event", async () => {
    const ev = await prisma.trackingEvent.findFirstOrThrow({
      where: { sessionId, pageUrl: { contains: BOOKING_HOST } },
      select: { utmContent: true },
    });
    const r = await resolveInfluencerFromUtmContent({
      agencyId: fx.agencyId, hotelClientId: fx.hotelId, utmContent: ev.utmContent,
    });
    expect(r).not.toBeNull();
    expect(r!.contentPieceId).toBe(fx.contentPieceId);
    expect(r!.influencerId).toBe(fx.influencerId);          // FK, never a name
    expect(r!.route).toBe("utm_content");
  });

  test("8. an EXPIRED token yields no continuation — a shared link cannot graft on", async () => {
    const stale = encodeJourneyToken({
      sessionId, visitorId, now: Date.now() - 31 * 60 * 1000,
      utms: { utm_source: "instagram", utm_medium: "influencer" },
    })!;
    expect(decodeJourneyToken(stale, Date.now())).toBeNull();
    const s = await prisma.session.findUniqueOrThrow({
      where: { id: sessionId }, select: { pageViewCount: true },
    });
    expect(s.pageViewCount).toBe(2); // unchanged — nothing was adopted
  });

  test("9. a token can NEVER write across tenants", async () => {
    const other = await prisma.agency.create({
      data: { name: `${PREFIX}B`, email: `${PREFIX.toLowerCase()}b@x.test`, subscriptionStatus: "active" },
    });
    const otherHotel = await prisma.hotelClient.create({
      data: {
        agencyId: other.id, name: `${PREFIX}HotelB`, websiteUrl: "https://other.example",
        contactName: "C", contactEmail: "c@t.local",
        siteId: `${PREFIX}siteB-${Date.now()}`, conversionMethod: "url_change",
        bookingDomains: [BOOKING_HOST],
      },
    });
    // Hotel B replays hotel A's session id — the route's `foreign` guard must drop it.
    await post({
      siteId: otherHotel.siteId, type: "pageview", v: "2.5.0",
      sessionId, visitorId, pagePath: "/hijack",
      pageUrl: `https://${BOOKING_HOST}/hijack`, timestamp: Date.now(), deviceType: "desktop",
    }, BOOKING_HOST);

    const s = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.hotelClientId).toBe(fx.hotelId);   // still hotel A
    expect(s.pageViewCount).toBe(2);            // hotel B wrote nothing
    expect(s.exitPath).toBe("/booking");
  });
});
