import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 funnel-stage tracking. Pure unit coverage for the matcher/aggregator,
// plus DB-backed coverage that drives the real POST /api/track/event handler and
// the backfill, then verifies StageReached / highestStageReached + isolation.
//
// Requires the 20260612140000_add_funnel_stage_tracking migration applied.
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
import {
  matchUrlPattern,
  resolveStageFromRules,
  computeFunnel,
  parseFunnelRules,
} from "@/lib/funnel";

// ── Pure unit tests (no DB) ───────────────────────────────────────────────────
describe("matchUrlPattern", () => {
  test("exact match is case-insensitive + trailing-slash tolerant", () => {
    expect(matchUrlPattern("/", "/")).toBe(true);
    expect(matchUrlPattern("/thank-you", "/thank-you")).toBe(true);
    expect(matchUrlPattern("/thank-you", "/thank-you/")).toBe(true);
    expect(matchUrlPattern("/Rooms", "/rooms")).toBe(true);
    expect(matchUrlPattern("/", "/rooms")).toBe(false);
  });
  test("wildcard matches the prefix and any suffix", () => {
    expect(matchUrlPattern("/rooms*", "/rooms")).toBe(true);
    expect(matchUrlPattern("/rooms*", "/rooms/deluxe")).toBe(true);
    expect(matchUrlPattern("/rooms*", "/rooms/deluxe/photos")).toBe(true);
    expect(matchUrlPattern("/rooms*", "/booking")).toBe(false);
  });
});

describe("resolveStageFromRules", () => {
  const rules = parseFunnelRules([
    { urlPattern: "/", stage: "awareness" },
    { urlPattern: "/rooms*", stage: "consideration" },
    { urlPattern: "/book*", stage: "intent" },
    { urlPattern: "/thank-you", stage: "booking" },
  ]);
  test("returns the first matching rule's stage", () => {
    expect(resolveStageFromRules(rules, "/")).toBe("awareness");
    expect(resolveStageFromRules(rules, "/rooms/deluxe")).toBe("consideration");
    expect(resolveStageFromRules(rules, "/book/step-2")).toBe("intent");
    expect(resolveStageFromRules(rules, "/thank-you")).toBe("booking");
    expect(resolveStageFromRules(rules, "/about")).toBeNull();
  });
});

describe("computeFunnel", () => {
  test("cumulative counts + conversion rates", () => {
    // 100 sessions stuck at awareness, 60 at consideration, 30 at intent, 10 booked.
    const f = computeFunnel({ reachedByRank: { 1: 100, 2: 60, 3: 30, 4: 10 }, revenue: 5000 });
    expect(f.stages.map((s) => s.visitors)).toEqual([200, 100, 40, 10]);
    expect(f.stages[0].conversionFromPrev).toBe(1);
    expect(f.stages[1].conversionFromPrev).toBeCloseTo(0.5); // 100/200
    expect(f.stages[2].conversionFromPrev).toBeCloseTo(0.4); // 40/100
    expect(f.conversions).toBe(10);
    expect(f.overallConversion).toBeCloseTo(0.05); // 10/200
    expect(f.stages[0].dropOff).toBe(100); // 200 → 100
  });
});

// ── DB-backed ─────────────────────────────────────────────────────────────────
const PREFIX = "TEST_FUNNEL_";
const sess = () => `sess_${randomUUID()}`;
const vis = () => `vis_${randomUUID()}`;

function loginAs(member: Record<string, unknown> | null, role = "agency_admin") {
  h.member = member;
  h.role = role;
}

function post(body: Record<string, unknown>) {
  return trackPOST(
    new Request("http://localhost/api/track/event", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8", "x-forwarded-for": "203.0.113.21" },
      body: JSON.stringify(body),
    }),
  );
}
function pageview(siteId: string, sessionId: string, visitorId: string, pagePath: string, funnelStage?: string | null) {
  return post({
    siteId, type: "pageview", v: "2.1.0", sessionId, visitorId,
    pagePath, pageUrl: `https://hotel.example${pagePath}`, timestamp: Date.now(),
    ...(funnelStage !== undefined ? { funnelStage } : {}),
  });
}

type Fx = {
  agencyA: string; agencyB: string;
  memberA: Record<string, unknown>; memberB: Record<string, unknown>;
  hotelA: string; siteA: string; hotelB: string; siteB: string;
  hotelDeleted: string; siteDeleted: string;
};
let fx: Fx;

const RULES = [
  { urlPattern: "/", stage: "awareness" },
  { urlPattern: "/rooms*", stage: "consideration" },
  { urlPattern: "/book*", stage: "intent" },
  { urlPattern: "/thank-you", stage: "booking" },
];

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
async function makeHotel(agencyId: string, tag: string, opts?: { deleted?: boolean; rules?: unknown }) {
  return prisma.hotelClient.create({
    data: {
      agencyId, name: `${PREFIX}${tag}`, websiteUrl: "https://hotel.example",
      contactName: "C", contactEmail: "c@test.local",
      siteId: `${PREFIX}site-${tag}-${Date.now()}-${Math.round(performance.now())}`,
      conversionMethod: "both",
      ...(opts?.deleted ? { deletedAt: new Date() } : {}),
      ...(opts?.rules !== undefined ? { funnelStageRules: opts.rules as never } : {}),
    },
  });
}

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const A = await makeAgency("A");
  const B = await makeAgency("B");
  const hA = await makeHotel(A.agency.id, "A-Hotel", { rules: RULES });
  const hB = await makeHotel(B.agency.id, "B-Hotel", { rules: RULES });
  const hDel = await makeHotel(A.agency.id, "A-Deleted", { deleted: true, rules: RULES });
  fx = {
    agencyA: A.agency.id, agencyB: B.agency.id,
    memberA: A.member as unknown as Record<string, unknown>,
    memberB: B.member as unknown as Record<string, unknown>,
    hotelA: hA.id, siteA: hA.siteId, hotelB: hB.id, siteB: hB.siteId,
    hotelDeleted: hDel.id, siteDeleted: hDel.siteId,
  };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe("stage detection + ingestion", () => {
  test("data-ht-stage in the payload is stored + recorded", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/landing", "consideration");
    const pv = await prisma.pageView.findFirst({ where: { sessionId: sId } });
    expect(pv?.funnelStage).toBe("consideration");
    const sr = await prisma.stageReached.findMany({ where: { sessionId: sId } });
    expect(sr.map((r) => r.stage)).toEqual(["consideration"]);
    const session = await prisma.session.findUnique({ where: { id: sId } });
    expect(session?.highestStageReached).toBe("consideration");
  });

  test("URL-rule wildcard sets the stage when the payload has none", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/rooms/deluxe"); // no funnelStage → /rooms* rule
    const pv = await prisma.pageView.findFirst({ where: { sessionId: sId } });
    expect(pv?.funnelStage).toBe("consideration");
    const session = await prisma.session.findUnique({ where: { id: sId } });
    expect(session?.highestStageReached).toBe("consideration");
  });

  test("a full flow reaches all four stages, highest = booking", async () => {
    const sId = sess(), vId = vis();
    for (const p of ["/", "/rooms", "/book", "/thank-you"]) await pageview(fx.siteA, sId, vId, p);
    const sr = await prisma.stageReached.findMany({ where: { sessionId: sId }, orderBy: { reachedAt: "asc" } });
    expect(new Set(sr.map((r) => r.stage))).toEqual(new Set(["awareness", "consideration", "intent", "booking"]));
    const session = await prisma.session.findUnique({ where: { id: sId } });
    expect(session?.highestStageReached).toBe("booking");
  });
});

describe("stage_reached event idempotency + no regression", () => {
  test("stage_reached fires once per stage (unique)", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/"); // create the session
    await post({ siteId: fx.siteA, type: "stage_reached", sessionId: sId, visitorId: vId, stage: "intent", timestamp: Date.now() });
    await post({ siteId: fx.siteA, type: "stage_reached", sessionId: sId, visitorId: vId, stage: "intent", timestamp: Date.now() });
    expect(await prisma.stageReached.count({ where: { sessionId: sId, stage: "intent" } })).toBe(1);
  });

  test("going from intent back to consideration does NOT lower highest or add a row", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/book"); // intent
    const before = await prisma.session.findUnique({ where: { id: sId } });
    expect(before?.highestStageReached).toBe("intent");
    await pageview(fx.siteA, sId, vId, "/rooms"); // consideration (lower)
    const after = await prisma.session.findUnique({ where: { id: sId } });
    expect(after?.highestStageReached).toBe("intent"); // unchanged
    // consideration WAS reached (it's a real stage), but highest stays intent.
    expect(await prisma.stageReached.count({ where: { sessionId: sId, stage: "consideration" } })).toBe(1);
  });

  test("an invalid stage on a stage_reached event is rejected (400)", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/");
    const res = await post({ siteId: fx.siteA, type: "stage_reached", sessionId: sId, visitorId: vId, stage: "nonsense", timestamp: Date.now() });
    expect(res.status).toBe(400);
  });
});

describe("soft delete + isolation", () => {
  test("a soft-deleted hotel records no funnel rows", async () => {
    const sId = sess(), vId = vis();
    const res = await pageview(fx.siteDeleted, sId, vId, "/rooms");
    expect(res.status).toBe(204);
    expect(await prisma.session.findUnique({ where: { id: sId } })).toBeNull();
    expect(await prisma.stageReached.count({ where: { sessionId: sId } })).toBe(0);
  });

  test("agency B cannot read agency A's StageReached via the scoped wrapper", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/rooms");
    loginAs(fx.memberB);
    expect(await agencyScoped(prisma.stageReached).findMany({ where: { sessionId: sId } })).toHaveLength(0);
    loginAs(fx.memberA);
    expect((await agencyScoped(prisma.stageReached).findMany({ where: { sessionId: sId } })).length).toBeGreaterThan(0);
  });
});

describe("backfill applies rules to historical PageViews", () => {
  test("a pre-funnel PageView gets a stage + StageReached after backfill", async () => {
    // Simulate a Phase 1 session: PageView with funnelStage = null, no StageReached.
    const sId = sess(), vId = vis();
    await prisma.session.create({
      data: { id: sId, visitorId: vId, hotelClientId: fx.hotelA, agencyId: fx.agencyA, startedAt: new Date(), landingPath: "/rooms" },
    });
    await prisma.pageView.create({
      data: { sessionId: sId, visitorId: vId, hotelClientId: fx.hotelA, agencyId: fx.agencyA, pagePath: "/rooms/suite", enteredAt: new Date() },
    });

    const { backfillHotel } = await import("@/scripts/backfill-funnel-stages");
    await backfillHotel({ id: fx.hotelA, name: "A", agencyId: fx.agencyA, funnelStageRules: RULES });

    const pv = await prisma.pageView.findFirst({ where: { sessionId: sId } });
    expect(pv?.funnelStage).toBe("consideration");
    expect(await prisma.stageReached.count({ where: { sessionId: sId, stage: "consideration" } })).toBe(1);
    const session = await prisma.session.findUnique({ where: { id: sId } });
    expect(session?.highestStageReached).toBe("consideration");
  });
});
