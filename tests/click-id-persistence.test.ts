import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1A persistence — drives the real POST /api/track/event handler against a
// live database and verifies the click identifiers land on Session, Touchpoint
// and TrackingEvent with the right semantics.
//
// The semantics that matter, and why:
//   • Session      — ADD-ONLY. An internal navigation carries no click id, and it
//                    must never null out what the session landed with.
//   • Touchpoint   — the id present on THAT page load only. Copying the remembered
//                    value onto later touches would invent ad clicks that never
//                    happened, inflating Google/Meta attribution.
//   • TrackingEvent— the id in effect when the event fired, so a conversion is
//                    self-contained for Phase 2's offline-conversion upload.
//
// Requires the 20260821000000_add_click_identifiers migration applied.
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
import { classifySourceType } from "@/lib/source-classifier";

const PREFIX = "TEST_CID_";

const GCLID = "TEST_GCLID_123";
const GBRAID = "TEST_GBRAID_123";
const WBRAID = "TEST_WBRAID_123";
const FBCLID = "TEST_FBCLID_123";

const sess = () => `sess_${randomUUID()}`;
const vis = () => `vis_${randomUUID()}`;

function post(body: Record<string, unknown>) {
  return trackPOST(
    new Request("http://localhost/api/track/event", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8", "x-forwarded-for": "203.0.113.77" },
      body: JSON.stringify(body),
    }),
  );
}

function pageview(siteId: string, sessionId: string, visitorId: string, pagePath: string, extra: Record<string, unknown> = {}) {
  return post({
    siteId, type: "pageview", v: "2.4.0", sessionId, visitorId, pagePath,
    pageUrl: `https://hotel.example${pagePath}`,
    timestamp: Date.now(), deviceType: "desktop", userAgent: "Mozilla/5.0 (test)",
    ...extra,
  });
}

function conversion(siteId: string, sessionId: string, visitorId: string, extra: Record<string, unknown> = {}) {
  return post({
    siteId, type: "conversion", v: "2.4.0", sessionId, visitorId,
    pageUrl: "https://hotel.example/thank-you", deviceType: "desktop", value: 25000,
    ...extra,
  });
}

type Fx = { agencyId: string; hotelId: string; siteId: string; otherHotelId: string; otherSiteId: string; otherAgencyId: string };
let fx: Fx;

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const a = await prisma.agency.create({
    data: { name: `${PREFIX}A`, email: `${PREFIX.toLowerCase()}a@x.test`, subscriptionStatus: "active" },
  });
  const b = await prisma.agency.create({
    data: { name: `${PREFIX}B`, email: `${PREFIX.toLowerCase()}b@x.test`, subscriptionStatus: "active" },
  });
  const mk = (agencyId: string, t: string) =>
    prisma.hotelClient.create({
      data: {
        agencyId, name: `${PREFIX}${t}`, websiteUrl: "https://hotel.example",
        contactName: "C", contactEmail: "c@t.local",
        siteId: `${PREFIX}site-${t}-${Date.now()}`, conversionMethod: "both",
      },
    });
  const hotel = await mk(a.id, "Main");
  const other = await mk(b.id, "Other");
  fx = {
    agencyId: a.id, hotelId: hotel.id, siteId: hotel.siteId,
    otherAgencyId: b.id, otherHotelId: other.id, otherSiteId: other.siteId,
  };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

const sessionRow = (id: string) =>
  prisma.session.findUnique({
    where: { id },
    select: { gclid: true, gbraid: true, wbraid: true, fbclid: true, hotelClientId: true, agencyId: true },
  });

const conversionRow = (sessionId: string) =>
  prisma.trackingEvent.findFirst({
    where: { sessionId, eventType: "conversion" },
    select: { id: true, gclid: true, gbraid: true, wbraid: true, fbclid: true, utmSource: true, utmMedium: true, utmContent: true },
  });

// ── 2–5. Session persistence ───────────────────────────────────────────────

describe("Session persistence", () => {
  test.each([
    ["2. gclid", { gclid: GCLID }, "gclid", GCLID],
    ["3. gbraid", { gbraid: GBRAID }, "gbraid", GBRAID],
    ["4. wbraid", { wbraid: WBRAID }, "wbraid", WBRAID],
    ["5. fbclid", { fbclid: FBCLID }, "fbclid", FBCLID],
  ])("%s persists to Session", async (_label, payload, key, value) => {
    const s = sess();
    await pageview(fx.siteId, s, vis(), "/", payload);
    const row = await sessionRow(s);
    expect(row).not.toBeNull();
    expect((row as unknown as Record<string, string | null>)[key]).toBe(value);
  });

  test("9. a later un-tagged pageview does NOT erase the session's identifier", async () => {
    const s = sess();
    const v = vis();
    await pageview(fx.siteId, s, v, "/", { gclid: GCLID });
    // Every internal navigation looks like this: no click id on the URL.
    await pageview(fx.siteId, s, v, "/rooms");
    await pageview(fx.siteId, s, v, "/rooms/deluxe");

    const row = await sessionRow(s);
    expect(row!.gclid).toBe(GCLID);
  });

  test("a new ad click within the session replaces that platform's id only", async () => {
    const s = sess();
    const v = vis();
    await pageview(fx.siteId, s, v, "/", { gclid: GCLID });
    await pageview(fx.siteId, s, v, "/offers", { gclid: "TEST_GCLID_456", fbclid: FBCLID });

    const row = await sessionRow(s);
    expect(row!.gclid).toBe("TEST_GCLID_456");
    expect(row!.fbclid).toBe(FBCLID); // added, not replacing
    expect(row!.gbraid).toBeNull();
  });

  test("15/16. malformed and oversized ids are rejected server-side", async () => {
    const s = sess();
    await pageview(fx.siteId, s, vis(), "/", {
      gclid: "has spaces",
      gbraid: "a".repeat(256),
      wbraid: "<script>",
      fbclid: FBCLID, // the one valid id still lands
    });
    const row = await sessionRow(s);
    expect(row!.gclid).toBeNull();
    expect(row!.gbraid).toBeNull();
    expect(row!.wbraid).toBeNull();
    expect(row!.fbclid).toBe(FBCLID);
  });
});

// ── 7–8. TrackingEvent persistence ─────────────────────────────────────────

describe("TrackingEvent persistence", () => {
  test("7. click ids persist onto a visit event", async () => {
    const s = sess();
    await pageview(fx.siteId, s, vis(), "/", { gclid: GCLID });
    const ev = await prisma.trackingEvent.findFirst({
      where: { sessionId: s, eventType: "visit" },
      select: { gclid: true },
    });
    expect(ev!.gclid).toBe(GCLID);
  });

  test("8. a conversion carries the identifiers needed for offline attribution", async () => {
    const s = sess();
    const v = vis();
    await pageview(fx.siteId, s, v, "/", { gclid: GCLID, fbclid: FBCLID });
    await pageview(fx.siteId, s, v, "/rooms"); // navigate away from the ad URL
    // The snippet sends the REMEMBERED ids on the conversion, pages later.
    await conversion(fx.siteId, s, v, { gclid: GCLID, fbclid: FBCLID });

    const conv = await conversionRow(s);
    expect(conv!.gclid).toBe(GCLID);
    expect(conv!.fbclid).toBe(FBCLID);
  });

  test("the conversion is findable by its Google click id (the Phase 2 join)", async () => {
    const s = sess();
    const unique = `TEST_GCLID_${randomUUID().replace(/-/g, "")}`;
    await conversion(fx.siteId, s, vis(), { gclid: unique });

    const found = await prisma.trackingEvent.findFirst({
      where: { hotelClientId: fx.hotelId, gclid: unique },
      select: { sessionId: true },
    });
    expect(found!.sessionId).toBe(s);
  });
});

// ── 6, 10, 11. Touchpoint persistence — per-click, never inherited ─────────

describe("Touchpoint persistence", () => {
  test("6/10/11. each touch keeps its OWN click id; an un-tagged touch stays null", async () => {
    const s = sess();
    const v = vis();
    const now = Date.now();
    // The journey the snippet flushes: an ad click, then a direct return visit.
    await conversion(fx.siteId, s, v, {
      gclid: GCLID,
      journey: [
        { ts: now - 120_000, utm_source: null, gclid: GCLID, landing_page: "https://hotel.example/?gclid=" + GCLID },
        { ts: now - 60_000, utm_source: null, landing_page: "https://hotel.example/" },
      ],
    });

    const conv = await conversionRow(s);
    const touches = await prisma.touchpoint.findMany({
      where: { conversionId: conv!.id },
      orderBy: { position: "asc" },
      select: { position: true, gclid: true, fbclid: true },
    });

    expect(touches).toHaveLength(2);
    expect(touches[0].gclid).toBe(GCLID); // the real ad click
    expect(touches[1].gclid).toBeNull(); // NOT inherited — this was a direct visit
    expect(touches.filter((t) => t.gclid === GCLID)).toHaveLength(1);
  });

  test("a second, genuinely different ad click produces its own tagged touch", async () => {
    const s = sess();
    const now = Date.now();
    await conversion(fx.siteId, s, vis(), {
      gclid: "TEST_GCLID_456",
      journey: [
        { ts: now - 120_000, gclid: GCLID },
        { ts: now - 60_000, gclid: "TEST_GCLID_456" },
      ],
    });
    const conv = await conversionRow(s);
    const touches = await prisma.touchpoint.findMany({
      where: { conversionId: conv!.id },
      orderBy: { position: "asc" },
      select: { gclid: true },
    });
    expect(touches.map((t) => t.gclid)).toEqual([GCLID, "TEST_GCLID_456"]);
  });
});

// ── 12–14. Classification of STORED rows ──────────────────────────────────

describe("classification of stored conversions", () => {
  test("12. a stored auto-tagged Google conversion classifies as google_ads", async () => {
    const s = sess();
    // No UTM parameters at all — exactly what Google auto-tagging sends.
    await conversion(fx.siteId, s, vis(), { gclid: GCLID });
    const conv = await conversionRow(s);
    expect(conv!.utmSource).toBeNull();
    expect(classifySourceType(conv!)).toBe("google_ads"); // was: direct
  });

  test("13. a stored fbclid-only conversion does NOT classify as meta_ads", async () => {
    const s = sess();
    await conversion(fx.siteId, s, vis(), { fbclid: FBCLID });
    const conv = await conversionRow(s);
    expect(classifySourceType(conv!)).not.toBe("meta_ads");
  });

  test("14. stored UTM classification is unchanged with no click id present", async () => {
    const s = sess();
    await conversion(fx.siteId, s, vis(), { utmSource: "facebook", utmMedium: "cpc" });
    const conv = await conversionRow(s);
    expect(conv!.gclid).toBeNull();
    expect(classifySourceType(conv!)).toBe("meta_ads");
  });
});

// ── 17. Tenant isolation ──────────────────────────────────────────────────

describe("17. tenant isolation", () => {
  test("a click id is stamped with the OWNING agency, resolved from siteId", async () => {
    const s = sess();
    await pageview(fx.otherSiteId, s, vis(), "/", { gclid: GCLID });
    const row = await sessionRow(s);
    expect(row!.agencyId).toBe(fx.otherAgencyId);
    expect(row!.hotelClientId).toBe(fx.otherHotelId);
  });

  test("one hotel's click id never appears on another hotel's rows", async () => {
    const unique = `TEST_GCLID_${randomUUID().replace(/-/g, "")}`;
    await conversion(fx.siteId, sess(), vis(), { gclid: unique });

    const leaked = await prisma.trackingEvent.count({
      where: { hotelClientId: fx.otherHotelId, gclid: unique },
    });
    expect(leaked).toBe(0);
  });

  test("a session id minted on another hotel's site cannot be hijacked", async () => {
    const s = sess();
    const v = vis();
    await pageview(fx.siteId, s, v, "/", { gclid: GCLID });
    // Same session id replayed against a DIFFERENT hotel's siteId.
    await pageview(fx.otherSiteId, s, v, "/", { gclid: "TEST_GCLID_HIJACK" });

    const row = await sessionRow(s);
    expect(row!.hotelClientId).toBe(fx.hotelId); // still the original owner
    expect(row!.gclid).toBe(GCLID); // untouched by the foreign write
  });
});
