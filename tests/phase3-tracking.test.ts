import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — click / form-field / identity tracking (snippet v2.2). Drives the
// real POST /api/track/event handler against a live database, then verifies:
//   • data-ht-click events are captured as ClickEvent rows
//   • form abandonment (focus, blur with no value) is captured + detected
//   • identify upserts a VisitorIdentity with SALTED-hashed email/phone (the raw
//     value never reaches the DB)
//   • Customer Journey Lookup search by (hashed) email is agency-scoped
//   • the per-session click/form rate limits are enforced
//   • full multi-tenant isolation across all three new tables
//
// Requires the 20260612160000_add_click_form_identity_tracking migration applied.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  member: null as null | Record<string, unknown>,
  role: "agency_admin" as string | undefined,
}));
vi.mock("@/lib/auth", () => ({
  getCurrentMember: async () => h.member,
  getPlatformRole: async () => h.role,
  // Mirror the real helper: only an admin member resolves; else null.
  requireAdmin: async () => (h.member && (h.member as { role?: string }).role === "admin" ? h.member : null),
}));

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { saltedHash } from "@/lib/pii";
import { hashEmailClient, hashPhoneClient } from "@/lib/pii-client";
import { computeFormAbandonment, computeClickAnalytics } from "@/lib/interaction-analytics";
import { POST as trackPOST } from "@/app/api/track/event/route";
import { lookupVisitorJourneys } from "@/app/(agency)/agency/(app)/hotel/[id]/journeys/actions";

const PREFIX = "TEST_P3_";

function loginAs(member: Record<string, unknown> | null, role = "agency_admin") {
  h.member = member;
  h.role = role;
}

const sess = () => `sess_${randomUUID()}`;
const vis = () => `vis_${randomUUID()}`;

function post(body: Record<string, unknown>) {
  return trackPOST(
    new Request("http://localhost/api/track/event", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8", "x-forwarded-for": "203.0.113.42" },
      body: JSON.stringify(body),
    }),
  );
}

function pageview(siteId: string, sessionId: string, visitorId: string, pagePath: string) {
  return post({
    siteId, type: "pageview", v: "2.2.0", sessionId, visitorId, pagePath,
    pageUrl: `https://hotel.example${pagePath}`, timestamp: Date.now(),
  });
}
function click(siteId: string, sessionId: string, visitorId: string, target: string, extra?: Record<string, unknown>) {
  return post({
    siteId, type: "click", v: "2.2.0", sessionId, visitorId, pagePath: "/book",
    clickTarget: target, elementTag: "BUTTON", elementText: "Book now", timestamp: Date.now(), ...extra,
  });
}
function formField(siteId: string, sessionId: string, visitorId: string, action: "focused" | "blurred", fieldName: string, hasValue?: boolean) {
  return post({
    siteId, type: `form_field_${action}`, v: "2.2.0", sessionId, visitorId, pagePath: "/book",
    fieldName, hasValue, timestamp: Date.now(),
  });
}

type Fx = {
  agencyA: string; agencyB: string;
  memberA: Record<string, unknown>; memberB: Record<string, unknown>;
  hotelA: string; siteA: string; hotelB: string; siteB: string;
};
let fx: Fx;

async function makeAgency(tag: string) {
  const agency = await prisma.agency.create({
    data: { name: `${PREFIX}${tag}`, email: `${PREFIX.toLowerCase()}${tag}@example.test`, subscriptionStatus: "active" },
  });
  const member = await prisma.agencyMember.create({
    data: { agencyId: agency.id, clerkId: `${PREFIX}clerk-${tag}-${Date.now()}`, email: `${tag}@m.test`, name: `M ${tag}`, role: "admin" },
    include: { agency: true },
  });
  return { agency, member };
}
async function makeHotel(agencyId: string, tag: string) {
  return prisma.hotelClient.create({
    data: {
      agencyId, name: `${PREFIX}${tag}`, websiteUrl: "https://hotel.example",
      contactName: "C", contactEmail: "c@test.local",
      siteId: `${PREFIX}site-${tag}-${Date.now()}-${Math.round(performance.now())}`,
      conversionMethod: "both",
    },
  });
}

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const A = await makeAgency("A");
  const B = await makeAgency("B");
  const hA = await makeHotel(A.agency.id, "A-Hotel");
  const hB = await makeHotel(B.agency.id, "B-Hotel");
  fx = {
    agencyA: A.agency.id, agencyB: B.agency.id,
    memberA: A.member as unknown as Record<string, unknown>,
    memberB: B.member as unknown as Record<string, unknown>,
    hotelA: hA.id, siteA: hA.siteId, hotelB: hB.id, siteB: hB.siteId,
  };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe("click ingestion (Part 1/3)", () => {
  test("a data-ht-click event is captured as a ClickEvent", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/book");
    const res = await click(fx.siteA, sId, vId, "check-availability");
    expect(res.status).toBe(204);

    const ev = await prisma.clickEvent.findFirst({ where: { sessionId: sId } });
    expect(ev).not.toBeNull();
    expect(ev!.clickTarget).toBe("check-availability");
    expect(ev!.elementTag).toBe("BUTTON");
    expect(ev!.hotelClientId).toBe(fx.hotelA);
    expect(ev!.agencyId).toBe(fx.agencyA);
  });

  test("elementText is truncated to 100 chars", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/book");
    await click(fx.siteA, sId, vId, "long-text", { elementText: "x".repeat(150) });
    const ev = await prisma.clickEvent.findFirst({ where: { sessionId: sId, clickTarget: "long-text" } });
    expect(ev!.elementText!.length).toBe(100);
  });

  test("a click with no owning session is dropped (FK + tenant guard)", async () => {
    const sId = sess(), vId = vis(); // no pageview ⇒ no Session row
    const res = await click(fx.siteA, sId, vId, "ghost");
    expect(res.status).toBe(204);
    expect(await prisma.clickEvent.count({ where: { sessionId: sId } })).toBe(0);
  });
});

describe("form abandonment (Part 1/3/5)", () => {
  test("focus then blur-with-no-value is captured and detected as abandonment", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/book");
    await formField(fx.siteA, sId, vId, "focused", "date-picker");
    await formField(fx.siteA, sId, vId, "blurred", "date-picker", false);

    const rows = await prisma.formFieldEvent.findMany({ where: { sessionId: sId }, orderBy: { occurredAt: "asc" } });
    expect(rows.map((r) => r.action)).toEqual(["focused", "blurred"]);
    expect(rows[1].hasValue).toBe(false);

    const funnel = computeFormAbandonment(
      rows.map((r) => ({ fieldName: r.fieldName, sessionId: r.sessionId, action: r.action, hasValue: r.hasValue })),
    );
    const f = funnel.find((x) => x.field === "date-picker")!;
    expect(f.focusedSessions).toBe(1);
    expect(f.filledSessions).toBe(0);
    expect(f.abandonedSessions).toBe(1);
    expect(f.abandonmentRate).toBe(1);
  });

  test("blur-with-value counts as filled, not abandoned", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/book");
    await formField(fx.siteA, sId, vId, "focused", "guest-name");
    await formField(fx.siteA, sId, vId, "blurred", "guest-name", true);

    const rows = await prisma.formFieldEvent.findMany({ where: { sessionId: sId } });
    const funnel = computeFormAbandonment(
      rows.map((r) => ({ fieldName: r.fieldName, sessionId: r.sessionId, action: r.action, hasValue: r.hasValue })),
    );
    const f = funnel.find((x) => x.field === "guest-name")!;
    expect(f.filledSessions).toBe(1);
    expect(f.abandonedSessions).toBe(0);
  });
});

describe("visitor identification (Part 1/3/7)", () => {
  test("identify upserts a VisitorIdentity with salted-hashed email/phone; raw never stored", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/book");

    const rawEmail = "Priya@Example.com";
    const rawPhone = "+91 98765 43210";
    const emailHash = await hashEmailClient(rawEmail); // hashed client-side
    const phoneHash = await hashPhoneClient(rawPhone);
    expect(emailHash).toMatch(/^[0-9a-f]{64}$/);

    const res = await post({
      siteId: fx.siteA, type: "identify", v: "2.2.0", sessionId: sId, visitorId: vId,
      name: "Priya", customerId: "CUST-1", emailHash, phoneHash, timestamp: Date.now(),
    });
    expect(res.status).toBe(204);

    const id = await prisma.visitorIdentity.findUnique({ where: { visitorId: vId } });
    expect(id).not.toBeNull();
    expect(id!.name).toBe("Priya");
    expect(id!.customerId).toBe("CUST-1");
    expect(id!.hotelClientId).toBe(fx.hotelA);
    expect(id!.identifiedInSessionId).toBe(sId);
    // Stored hash is the SALTED server hash of the client hash — verifiable + not raw.
    expect(id!.emailHash).toBe(saltedHash(emailHash));
    expect(id!.phoneHash).toBe(saltedHash(phoneHash));
    // The raw email/phone and even the bare client hash are NOT in the DB.
    expect(id!.emailHash).not.toBe(rawEmail.toLowerCase());
    expect(id!.emailHash).not.toBe(emailHash);
    expect(JSON.stringify(id)).not.toContain("priya@example.com");
    expect(JSON.stringify(id)).not.toContain("9876543210");
  });

  test("a second identify for the same visitor updates fields", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/book");
    await post({ siteId: fx.siteA, type: "identify", sessionId: sId, visitorId: vId, name: "Anon", timestamp: Date.now() });
    await post({ siteId: fx.siteA, type: "identify", sessionId: sId, visitorId: vId, name: "Real Name", customerId: "C9", timestamp: Date.now() });
    const id = await prisma.visitorIdentity.findUnique({ where: { visitorId: vId } });
    expect(id!.name).toBe("Real Name");
    expect(id!.customerId).toBe("C9");
    expect(await prisma.visitorIdentity.count({ where: { visitorId: vId } })).toBe(1);
  });
});

describe("Customer Journey Lookup (Part 6) — scoped search by hashed email", () => {
  test("search by email returns the visitor's sessions for the owning agency only", async () => {
    const sId = sess(), vId = vis();
    const email = `vip-${randomUUID()}@example.com`;
    await pageview(fx.siteA, sId, vId, "/");
    await pageview(fx.siteA, sId, vId, "/rooms");
    await click(fx.siteA, sId, vId, "check-availability");
    const emailHash = await hashEmailClient(email);
    await post({ siteId: fx.siteA, type: "identify", sessionId: sId, visitorId: vId, name: "VIP", emailHash, timestamp: Date.now() });

    // Owning agency: finds the visitor + their full history.
    loginAs(fx.memberA);
    const found = await lookupVisitorJourneys(fx.hotelA, { emailHash });
    expect(found.found).toBe(true);
    expect(found.visitorId).toBe(vId);
    expect(found.sessionCount).toBeGreaterThanOrEqual(1);
    const session = found.sessions.find((s) => s.id === sId)!;
    expect(session.pages.length).toBeGreaterThanOrEqual(2);
    expect(session.clicks.some((c) => c.clickTarget === "check-availability")).toBe(true);

    // Other agency: the same hash matches nothing (scoped) AND can't reach hotel A.
    loginAs(fx.memberB);
    const other = await lookupVisitorJourneys(fx.hotelA, { emailHash });
    expect(other.found).toBe(false);
  });

  test("a raw email is never accepted as a hash (only well-formed client hashes match)", async () => {
    loginAs(fx.memberA);
    const res = await lookupVisitorJourneys(fx.hotelA, { emailHash: "not-a-real-sha256" });
    expect(res.found).toBe(false);
  });
});

describe("per-session rate limits (Part 3)", () => {
  // Each accepted event is a network round-trip to the DB, so exceeding the cap
  // means ~50/100 sequential writes — give these a generous per-test timeout.
  test("clicks are capped at 50 per session", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/book");
    for (let i = 0; i < 55; i++) await click(fx.siteA, sId, vId, `t-${i}`);
    expect(await prisma.clickEvent.count({ where: { sessionId: sId } })).toBe(50);
  }, 120_000);

  test("form field events are capped at 100 per session", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/book");
    for (let i = 0; i < 105; i++) await formField(fx.siteA, sId, vId, "focused", `field-${i}`);
    expect(await prisma.formFieldEvent.count({ where: { sessionId: sId } })).toBe(100);
  }, 180_000);
});

describe("multi-tenant isolation (Part 8)", () => {
  test("agency B cannot read agency A's ClickEvent / FormFieldEvent / VisitorIdentity", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/book");
    await click(fx.siteA, sId, vId, "secret-button");
    await formField(fx.siteA, sId, vId, "focused", "secret-field");
    await post({ siteId: fx.siteA, type: "identify", sessionId: sId, visitorId: vId, name: "Secret", timestamp: Date.now() });

    loginAs(fx.memberB);
    expect(await agencyScoped(prisma.clickEvent).count({ where: { sessionId: sId } })).toBe(0);
    expect(await agencyScoped(prisma.formFieldEvent).count({ where: { sessionId: sId } })).toBe(0);
    expect(await agencyScoped(prisma.visitorIdentity).findFirst({ where: { visitorId: vId } })).toBeNull();

    loginAs(fx.memberA);
    expect(await agencyScoped(prisma.clickEvent).count({ where: { sessionId: sId } })).toBe(1);
    expect(await agencyScoped(prisma.visitorIdentity).findFirst({ where: { visitorId: vId } })).not.toBeNull();
  });

  test("a click for a session owned by hotel A cannot be written via hotel B's site", async () => {
    const sId = sess(), vId = vis();
    await pageview(fx.siteA, sId, vId, "/book"); // session belongs to hotel A
    await click(fx.siteB, sId, vis(), "hijack"); // replay against hotel B
    // No ClickEvent stamped with hotel B for A's session.
    expect(await prisma.clickEvent.count({ where: { sessionId: sId, hotelClientId: fx.hotelB } })).toBe(0);
  });

  test("an identify cannot hijack a visitorId already owned by another hotel", async () => {
    const sIdA = sess(), vId = vis();
    await pageview(fx.siteA, sIdA, vId, "/book");
    await post({ siteId: fx.siteA, type: "identify", sessionId: sIdA, visitorId: vId, name: "Owner A", timestamp: Date.now() });

    const sIdB = sess();
    await pageview(fx.siteB, sIdB, vId, "/book");
    await post({ siteId: fx.siteB, type: "identify", sessionId: sIdB, visitorId: vId, name: "Attacker B", timestamp: Date.now() });

    const id = await prisma.visitorIdentity.findUnique({ where: { visitorId: vId } });
    expect(id!.hotelClientId).toBe(fx.hotelA); // unchanged owner
    expect(id!.name).toBe("Owner A"); // B's identify did not overwrite
  });

  test("computeClickAnalytics conversion rate is per unique session", () => {
    const rows = computeClickAnalytics(
      [
        { clickTarget: "book-now", sessionId: "s1" },
        { clickTarget: "book-now", sessionId: "s1" },
        { clickTarget: "book-now", sessionId: "s2" },
      ],
      new Set(["s1"]),
    );
    const r = rows.find((x) => x.target === "book-now")!;
    expect(r.totalClicks).toBe(3);
    expect(r.uniqueSessions).toBe(2);
    expect(r.convertedSessions).toBe(1);
    expect(r.conversionRate).toBe(0.5);
  });
});
