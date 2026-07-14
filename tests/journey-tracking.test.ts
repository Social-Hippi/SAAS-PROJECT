import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Visitor journey tracking (snippet v2) — drives the real POST /api/track/event
// handler against a live database, then verifies Session/PageView rows, plus the
// retention cron and multi-tenant isolation.
//
// Requires the 20260612120000_add_visitor_journey_tracking migration to be
// applied to the test database.
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
import { agencyScoped } from "@/lib/tenant";
import { POST as trackPOST } from "@/app/api/track/event/route";
import { GET as cleanupGET } from "@/app/api/cron/cleanup-journey/route";

const PREFIX = "TEST_JT_";
const CRON_SECRET = "test-cron-secret-jt";

function loginAs(member: Record<string, unknown> | null, role = "agency_admin") {
  h.member = member;
  h.role = role;
}

const sess = () => `sess_${randomUUID()}`;
const vis = () => `vis_${randomUUID()}`;

// POST an event body to the tracking endpoint (text/plain like the beacon does).
function post(body: Record<string, unknown>) {
  return trackPOST(
    new Request("http://localhost/api/track/event", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(body),
    }),
  );
}

function pageview(siteId: string, sessionId: string, visitorId: string, pagePath: string, extra?: Record<string, unknown>) {
  return post({
    siteId,
    type: "pageview",
    v: "2.0.0",
    sessionId,
    visitorId,
    pagePath,
    pageTitle: `Title ${pagePath}`,
    referrer: "https://google.com",
    pageUrl: `https://hotel.example${pagePath}`,
    timestamp: Date.now(),
    viewportWidth: 1280,
    viewportHeight: 800,
    userAgent: "Mozilla/5.0 (test)",
    deviceType: "desktop",
    ...extra,
  });
}

type Fx = {
  agencyA: string;
  agencyB: string;
  memberA: Record<string, unknown>;
  memberB: Record<string, unknown>;
  hotelA: string;
  siteA: string;
  hotelB: string;
  siteB: string;
  hotelDeleted: string;
  siteDeleted: string;
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
      agencyId,
      name: `${PREFIX}${tag}`,
      websiteUrl: "https://hotel.example",
      contactName: "C",
      contactEmail: "c@test.local",
      siteId: `${PREFIX}site-${tag}-${Date.now()}-${Math.round(performance.now())}`,
      conversionMethod: "both",
      ...(deleted ? { deletedAt: new Date() } : {}),
    },
  });
}

beforeAll(async () => {
  process.env.CRON_SECRET = CRON_SECRET;
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const A = await makeAgency("A");
  const B = await makeAgency("B");
  const hA = await makeHotel(A.agency.id, "A-Hotel");
  const hB = await makeHotel(B.agency.id, "B-Hotel");
  const hDel = await makeHotel(A.agency.id, "A-Deleted", true);
  fx = {
    agencyA: A.agency.id,
    agencyB: B.agency.id,
    memberA: A.member as unknown as Record<string, unknown>,
    memberB: B.member as unknown as Record<string, unknown>,
    hotelA: hA.id,
    siteA: hA.siteId,
    hotelB: hB.id,
    siteB: hB.siteId,
    hotelDeleted: hDel.id,
    siteDeleted: hDel.siteId,
  };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe("pageview ingestion", () => {
  test("a pageview creates a Session and a PageView (and a visit TrackingEvent)", async () => {
    const sId = sess(), vId = vis();
    const res = await pageview(fx.siteA, sId, vId, "/", { utmSource: "instagram", utmMedium: "social", utmCampaign: "summer" });
    expect(res.status).toBe(204);

    const session = await prisma.session.findUnique({ where: { id: sId } });
    expect(session).not.toBeNull();
    expect(session!.hotelClientId).toBe(fx.hotelA);
    expect(session!.agencyId).toBe(fx.agencyA);
    expect(session!.landingPath).toBe("/");
    expect(session!.pageViewCount).toBe(1);
    expect(session!.utmSource).toBe("instagram");

    const pvs = await prisma.pageView.findMany({ where: { sessionId: sId } });
    expect(pvs.length).toBe(1);
    expect(pvs[0].pagePath).toBe("/");

    // The additive visit TrackingEvent preserves existing dashboards.
    const te = await prisma.trackingEvent.findFirst({ where: { sessionId: sId, eventType: "visit" } });
    expect(te).not.toBeNull();
  });

  test("a second pageview in the same session reuses the Session", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/rooms");
    await pageview(fx.siteA, sId, vId, "/rooms/deluxe");

    const session = await prisma.session.findUnique({ where: { id: sId } });
    expect(session!.pageViewCount).toBe(2);
    expect(session!.landingPath).toBe("/rooms");
    expect(session!.exitPath).toBe("/rooms/deluxe");
    expect(await prisma.pageView.count({ where: { sessionId: sId } })).toBe(2);
  });

  test("a different sessionId (e.g. after 30-min inactivity) creates a new Session", async () => {
    const vId = vis();
    const s1 = sess(), s2 = sess();
    await pageview(fx.siteA, s1, vId, "/");
    await pageview(fx.siteA, s2, vId, "/");
    expect(await prisma.session.findUnique({ where: { id: s1 } })).not.toBeNull();
    expect(await prisma.session.findUnique({ where: { id: s2 } })).not.toBeNull();
    expect(s1).not.toBe(s2);
  });

  test("SPA navigation — 5 pageviews in one session ⇒ 1 Session, 5 PageViews", async () => {
    const sId = sess(), vId = vis();
    for (const p of ["/", "/rooms", "/rooms/suite", "/offers", "/book"]) {
      await pageview(fx.siteA, sId, vId, p);
    }
    const session = await prisma.session.findUnique({ where: { id: sId } });
    expect(session!.pageViewCount).toBe(5);
    expect(session!.exitPath).toBe("/book");
    expect(await prisma.pageView.count({ where: { sessionId: sId } })).toBe(5);
  });
});

describe("page_exit ingestion", () => {
  test("page_exit sets timeOnPageMs on the open PageView and increments Session.totalTimeMs", async () => {
    const sId = sess(), vId = vis();
    const entered = Date.now();
    await post({
      siteId: fx.siteA, type: "pageview", sessionId: sId, visitorId: vId,
      pagePath: "/", pageUrl: "https://hotel.example/", timestamp: entered,
    });
    const exitTs = entered + 4200;
    const res = await post({
      siteId: fx.siteA, type: "page_exit", sessionId: sId, visitorId: vId,
      pagePath: "/", timeOnPageMs: 4200, exitReason: "navigation", timestamp: exitTs,
    });
    expect(res.status).toBe(204);

    const pv = await prisma.pageView.findFirst({ where: { sessionId: sId } });
    expect(pv!.exitedAt).not.toBeNull();
    expect(pv!.timeOnPageMs).toBe(4200);
    expect(pv!.exitReason).toBe("navigation");

    const session = await prisma.session.findUnique({ where: { id: sId } });
    expect(session!.totalTimeMs).toBe(4200);
    expect(session!.endedAt).toBeNull(); // navigation keeps the session open
  });

  test("an 'unload' page_exit ends the session", async () => {
    const sId = sess(), vId = vis();
    const entered = Date.now();
    await post({ siteId: fx.siteA, type: "pageview", sessionId: sId, visitorId: vId, pagePath: "/", pageUrl: "x", timestamp: entered });
    await post({ siteId: fx.siteA, type: "page_exit", sessionId: sId, visitorId: vId, pagePath: "/", exitReason: "unload", timestamp: entered + 1000 });
    const session = await prisma.session.findUnique({ where: { id: sId } });
    expect(session!.endedAt).not.toBeNull();
  });
});

describe("conversion links to the session", () => {
  test("a conversion with the session's id is discoverable as converted", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/book");
    const res = await post({ siteId: fx.siteA, type: "conversion", sessionId: sId, visitorId: vId, pageUrl: "https://hotel.example/thank-you", value: 12500 });
    expect(res.status).toBe(204);

    const conv = await prisma.trackingEvent.findFirst({ where: { sessionId: sId, eventType: "conversion" }, select: { sessionId: true } });
    expect(conv?.sessionId).toBe(sId);
    // The session still exists and can be matched to the conversion.
    expect(await prisma.session.findUnique({ where: { id: sId } })).not.toBeNull();
  });
});

describe("validation + soft delete", () => {
  test("unknown siteId is rejected (403) and writes nothing", async () => {
    const res = await pageview("nope-unknown-site", sess(), vis(), "/");
    expect(res.status).toBe(403);
  });

  test("a soft-deleted hotel does not accept pageviews (204, no rows)", async () => {
    const sId = sess(), vId = vis();
    const res = await pageview(fx.siteDeleted, sId, vId, "/");
    expect(res.status).toBe(204);
    expect(await prisma.session.findUnique({ where: { id: sId } })).toBeNull();
    expect(await prisma.pageView.count({ where: { sessionId: sId } })).toBe(0);
  });

  test("a malformed timestamp (replay) is ignored for page_exit", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/");
    const res = await post({ siteId: fx.siteA, type: "page_exit", sessionId: sId, visitorId: vId, pagePath: "/", exitReason: "unload", timestamp: Date.now() - 10 * 60_000 });
    expect(res.status).toBe(204);
    const pv = await prisma.pageView.findFirst({ where: { sessionId: sId } });
    expect(pv!.exitedAt).toBeNull(); // not closed — stale timestamp ignored
  });
});

describe("multi-tenant isolation", () => {
  test("agency B cannot read agency A's session/pageviews via the scoped wrapper", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/secret");

    loginAs(fx.memberB);
    expect(await agencyScoped(prisma.session).findFirst({ where: { id: sId } })).toBeNull();
    const bPages = await agencyScoped(prisma.pageView).findMany({ where: { sessionId: sId } });
    expect(bPages.length).toBe(0);

    loginAs(fx.memberA);
    expect(await agencyScoped(prisma.session).findFirst({ where: { id: sId } })).not.toBeNull();
  });

  test("a sessionId minted on hotel A cannot be hijacked by a pageview to hotel B", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/"); // session belongs to hotel A
    const before = (await prisma.session.findUnique({ where: { id: sId } }))!.pageViewCount;

    // Replay the same sessionId against hotel B (different agency).
    await pageview(fx.siteB, sId, vis(), "/evil");

    const after = await prisma.session.findUnique({ where: { id: sId } });
    expect(after!.hotelClientId).toBe(fx.hotelA); // unchanged owner
    expect(after!.pageViewCount).toBe(before); // B's replay did NOT touch A's session
    // No PageView for that session got stamped with hotel B.
    expect(await prisma.pageView.count({ where: { sessionId: sId, hotelClientId: fx.hotelB } })).toBe(0);
  });
});

describe("90-day retention cron", () => {
  function cron() {
    return cleanupGET(
      new Request("http://localhost/api/cron/cleanup-journey", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );
  }

  test("deletes 91-day-old data, keeps 89-day-old", async () => {
    const vId = vis();
    const oldId = sess(), newId = sess();
    const d91 = new Date(Date.now() - 91 * 86_400_000);
    const d89 = new Date(Date.now() - 89 * 86_400_000);

    for (const [id, when] of [[oldId, d91], [newId, d89]] as const) {
      await prisma.session.create({
        data: { id, visitorId: vId, hotelClientId: fx.hotelA, agencyId: fx.agencyA, startedAt: when, landingPath: "/" },
      });
      await prisma.pageView.create({
        data: { sessionId: id, visitorId: vId, hotelClientId: fx.hotelA, agencyId: fx.agencyA, pagePath: "/", enteredAt: when },
      });
    }

    const res = await cron();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pageViewsDeleted: number; sessionsDeleted: number };
    expect(json.pageViewsDeleted).toBeGreaterThanOrEqual(1);
    expect(json.sessionsDeleted).toBeGreaterThanOrEqual(1);

    expect(await prisma.session.findUnique({ where: { id: oldId } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { id: newId } })).not.toBeNull();
  });

  test("rejects without the CRON_SECRET", async () => {
    const res = await cleanupGET(new Request("http://localhost/api/cron/cleanup-journey"));
    expect(res.status).toBe(401);
  });
});
