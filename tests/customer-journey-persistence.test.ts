import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// GENERAL customer-journey harness — DATABASE half (Tracks B + C).
//
// Same source-agnostic scenario table as the DB-free runner; this one drives the
// real POST /api/track/event handler and asserts the rows that actually land:
// Session, PageView, Touchpoint, TrackingEvent.
//
// Adding a channel = one row in tests/journey/scenarios.ts. Nothing here is
// influencer-specific.
//
// Requires 20260821000000 (click identifiers) to be applied.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { POST as trackPOST } from "@/app/api/track/event/route";
import { classifySourceType } from "@/lib/source-classifier";
import { CLICK_ID_KEYS, JOURNEY_SCENARIOS, type JourneyScenario } from "@/tests/journey/scenarios";

const PREFIX = "TEST_CJ_";
let fx: { agencyId: string; hotelId: string; siteId: string };

const sess = () => `sess_${randomUUID()}`;
const vis = () => `vis_${randomUUID()}`;

function post(body: Record<string, unknown>) {
  return trackPOST(
    new Request("http://localhost/api/track/event", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8", "x-forwarded-for": "203.0.113.66" },
      body: JSON.stringify(body),
    }),
  );
}

/** Turn a scenario's landing URL into the payload fields the snippet would send. */
function acquisitionFields(s: JourneyScenario): Record<string, unknown> {
  const q = new URL(`https://hotel.example${s.landing}`).searchParams;
  const out: Record<string, unknown> = {
    utmSource: q.get("utm_source"),
    utmMedium: q.get("utm_medium"),
    utmCampaign: q.get("utm_campaign"),
    utmContent: q.get("utm_content"),
    utmTerm: q.get("utm_term"),
    referrer: s.referrer ?? null,
  };
  for (const k of CLICK_ID_KEYS) {
    const v = q.get(k);
    if (v) out[k] = v;
  }
  return out;
}

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const agency = await prisma.agency.create({
    data: { name: `${PREFIX}A`, email: `${PREFIX.toLowerCase()}a@x.test`, subscriptionStatus: "active" },
  });
  const hotel = await prisma.hotelClient.create({
    data: {
      agencyId: agency.id, name: `${PREFIX}Hotel`, websiteUrl: "https://hotel.example",
      contactName: "C", contactEmail: "c@t.local",
      siteId: `${PREFIX}site-${Date.now()}`, conversionMethod: "both",
    },
  });
  fx = { agencyId: agency.id, hotelId: hotel.id, siteId: hotel.siteId };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

// ── B1/B2/B4 — full journey per source, in the database ──────────────────

describe.each(JOURNEY_SCENARIOS.map((s) => [s.label, s] as const))("%s", (_label, s) => {
  const sessionId = sess();
  const visitorId = vis();
  const acq = acquisitionFields(s);

  test("landing pageview creates Session + PageView with the acquisition evidence", async () => {
    await post({
      siteId: fx.siteId, type: "pageview", v: "2.4.0", sessionId, visitorId,
      pagePath: "/", pageUrl: `https://hotel.example${s.landing}`,
      timestamp: Date.now(), deviceType: "desktop", userAgent: "test", ...acq,
    });

    const session = await prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        hotelClientId: true, visitorId: true, utmSource: true, utmMedium: true,
        gclid: true, gbraid: true, wbraid: true, fbclid: true, referrer: true,
      },
    });
    expect(session.hotelClientId).toBe(fx.hotelId);
    expect(session.visitorId).toBe(visitorId);
    expect(session.utmSource).toBe(s.expected.utmSource);
    expect(session.utmMedium).toBe(s.expected.utmMedium);
    for (const k of CLICK_ID_KEYS) {
      expect(session[k]).toBe(s.expected.clickIds[k] ?? null);
    }

    const pageViews = await prisma.pageView.count({ where: { sessionId } });
    expect(pageViews).toBe(1);
  });

  test("cross-page navigation keeps ONE session and does not invent a source", async () => {
    for (const p of ["/journey-step-2", "/journey-step-3"]) {
      await post({
        siteId: fx.siteId, type: "pageview", v: "2.4.0", sessionId, visitorId,
        pagePath: p, pageUrl: `https://hotel.example${p}`,
        timestamp: Date.now(), deviceType: "desktop", ...acq, // snippet replays first-touch
      });
    }
    const session = await prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { pageViewCount: true, utmSource: true, exitPath: true },
    });
    expect(session.pageViewCount).toBe(3);
    expect(session.utmSource).toBe(s.expected.utmSource); // unchanged by later pages
    expect(session.exitPath).toBe("/journey-step-3");
  });

  test("conversion creates a TrackingEvent that retains the full evidence", async () => {
    await post({
      siteId: fx.siteId, type: "conversion", v: "2.4.0", sessionId, visitorId,
      pageUrl: "https://hotel.example/thank-you", deviceType: "desktop", value: 12500,
      ...acq,
      journey: [{ ts: Date.now() - 60_000, utm_source: acq.utmSource, utm_medium: acq.utmMedium, utm_content: acq.utmContent, ...Object.fromEntries(CLICK_ID_KEYS.filter((k) => acq[k]).map((k) => [k, acq[k]])) }],
    });

    const conv = await prisma.trackingEvent.findFirstOrThrow({
      where: { sessionId, eventType: "conversion" },
      select: {
        id: true, visitorId: true, sessionId: true, conversionValue: true,
        utmSource: true, utmMedium: true, utmCampaign: true, utmContent: true,
        gclid: true, gbraid: true, wbraid: true, fbclid: true,
      },
    });

    expect(conv.visitorId).toBe(visitorId);
    expect(conv.sessionId).toBe(sessionId);
    expect(Number(conv.conversionValue)).toBe(12500);
    expect(conv.utmSource).toBe(s.expected.utmSource);
    expect(conv.utmMedium).toBe(s.expected.utmMedium);
    for (const k of CLICK_ID_KEYS) {
      expect(conv[k]).toBe(s.expected.clickIds[k] ?? null);
    }

    // The STORED row classifies exactly as the live payload did.
    expect(classifySourceType(conv)).toBe(s.expected.sourceType);

    // A Touchpoint was flushed for the acquisition click.
    const touches = await prisma.touchpoint.findMany({
      where: { conversionId: conv.id },
      orderBy: { position: "asc" },
    });
    expect(touches.length).toBeGreaterThan(0);
  });
});

// ── B3 — return journey, observed in the database ────────────────────────

describe("B3 — return journey (observed, semantics unchanged)", () => {
  test("session 2 is new, the visitor is the same, and the click id carries over", async () => {
    const visitorId = vis();
    const s1 = sess();
    const s2 = sess();
    const gclid = "TEST_GCLID_RETURN_1";

    await post({
      siteId: fx.siteId, type: "pageview", v: "2.4.0", sessionId: s1, visitorId,
      pagePath: "/", pageUrl: `https://hotel.example/?gclid=${gclid}`,
      timestamp: Date.now(), deviceType: "desktop", gclid,
    });
    // Later, direct return — but the snippet still replays the remembered id.
    await post({
      siteId: fx.siteId, type: "pageview", v: "2.4.0", sessionId: s2, visitorId,
      pagePath: "/offers", pageUrl: "https://hotel.example/offers",
      timestamp: Date.now(), deviceType: "desktop", gclid,
    });

    const [a, b] = await Promise.all([
      prisma.session.findUniqueOrThrow({ where: { id: s1 }, select: { visitorId: true, gclid: true } }),
      prisma.session.findUniqueOrThrow({ where: { id: s2 }, select: { visitorId: true, gclid: true, utmSource: true } }),
    ]);
    expect(a.visitorId).toBe(b.visitorId);
    expect(b.gclid).toBe(gclid);
    // DOCUMENTED: the returning session still classifies as google_ads, not direct.
    expect(classifySourceType({ utmSource: b.utmSource, utmMedium: null, gclid: b.gclid })).toBe("google_ads");
  });
});
