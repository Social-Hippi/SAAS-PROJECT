import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Owner Summary. Pattern selection (strong / slight-decline / significant-decline
// / no-data), Indian number formatting, the no-previous-period case, tenant
// isolation (404), caching, and toggle-between-periods. Also prints a sample
// summary for each pattern. No migration needed (read-only feature).
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ member: null as null | Record<string, unknown>, role: "agency_admin" as string | undefined }));
vi.mock("@/lib/auth", () => ({ getCurrentMember: async () => h.member, getPlatformRole: async () => h.role }));

import { prisma } from "@/lib/prisma";
import { generateSummary } from "@/lib/owner-summary";
import { TtlLruCache } from "@/lib/lru-cache";
import { GET as summaryGET } from "@/app/api/agency/hotels/[hotelId]/summary/route";

const PREFIX = "TEST_SUM_";
const loginAs = (m: Record<string, unknown> | null) => { h.member = m; };
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

function route(hotelId: string, period = "7d") {
  return summaryGET(new Request(`http://localhost/api/agency/hotels/${hotelId}/summary?period=${period}`), { params: Promise.resolve({ hotelId }) });
}
function conv(agencyId: string, hotelId: string, source: string | null, value: number, when: Date) {
  return prisma.trackingEvent.create({
    data: { agencyId, hotelClientId: hotelId, eventType: "conversion", utmSource: source, utmMedium: source ? "reel" : null, pageUrl: "https://h/thx", conversionValue: value.toFixed(2), sessionId: `s_${randomUUID()}`, deviceType: "desktop", createdAt: when },
  });
}

type Fx = {
  agencyA: string; memberA: Record<string, unknown>; memberB: Record<string, unknown>;
  strong: string; flat: string; decline: string; noData: string; first: string; small: string;
};
let fx: Fx;

async function mkAgency(t: string) { return prisma.agency.create({ data: { name: `${PREFIX}${t}`, email: `${PREFIX.toLowerCase()}${t}@x.test`, subscriptionStatus: "active" } }); }
async function mkMember(a: string, t: string) { return prisma.agencyMember.create({ data: { agencyId: a, clerkId: `${PREFIX}c-${t}-${Date.now()}-${Math.round(performance.now())}`, email: `${t}@socialhippi.com`, name: t, role: "admin" } }); }
async function mkHotel(a: string, t: string) { return prisma.hotelClient.create({ data: { agencyId: a, name: `${PREFIX}${t}`, websiteUrl: "https://h.example", contactName: "C", contactEmail: "c@t.local", siteId: `${PREFIX}s-${t}-${Date.now()}-${Math.round(performance.now())}`, conversionMethod: "both", otaCommissionRate: 18 } }); }

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const A = await mkAgency("A"), B = await mkAgency("B");
  const mA = await mkMember(A.id, "A"), mB = await mkMember(B.id, "B");
  const strong = await mkHotel(A.id, "Strong"), flat = await mkHotel(A.id, "Flat"), decline = await mkHotel(A.id, "Decline");
  const noData = await mkHotel(A.id, "NoData"), first = await mkHotel(A.id, "First"), small = await mkHotel(A.id, "Small");

  const cur = daysAgo(3), prev = daysAgo(10); // land in the 7-day cur/prev windows
  // strong: cur ₹2.4L (2 bookings, instagram) vs prev ₹1L → +140%
  await conv(A.id, strong.id, "instagram", 120000, cur);
  await conv(A.id, strong.id, "instagram", 120000, cur);
  await conv(A.id, strong.id, "instagram", 100000, prev);
  // flat: cur ₹90K vs prev ₹1L → −10%
  await conv(A.id, flat.id, "facebook", 90000, cur);
  await conv(A.id, flat.id, "facebook", 100000, prev);
  // significant decline: cur ₹40K vs prev ₹1L → −60%
  await conv(A.id, decline.id, "google", 40000, cur);
  await conv(A.id, decline.id, "google", 100000, prev);
  // no data: only a previous-period booking, nothing in cur
  await conv(A.id, noData.id, "instagram", 50000, prev);
  // first period: cur only (no prev) → strong, no comparison
  await conv(A.id, first.id, "instagram", 85000, cur);
  // small: a single ₹500 booking, no prev → must read "₹500", not "₹0.5K"
  await conv(A.id, small.id, "instagram", 500, cur);

  fx = { agencyA: A.id, memberA: mA as unknown as Record<string, unknown>, memberB: mB as unknown as Record<string, unknown>, strong: strong.id, flat: flat.id, decline: decline.id, noData: noData.id, first: first.id, small: small.id };
});

afterAll(async () => { await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } }); await prisma.$disconnect(); });

describe("pattern selection", () => {
  test("growth → 'strong'", async () => {
    loginAs(fx.memberA);
    const r = (await generateSummary(fx.strong, "7d"))!;
    expect(r.pattern).toBe("strong");
    expect(r.metrics.revenue).toBe(240000);
    expect(r.summary).toContain("₹2.4L"); // Indian formatting
    expect(r.summary.toLowerCase()).toContain("strong");
    console.log(`[strong/7d] ${r.summary}`);
  });

  test("slight decline → 'flat_or_slight_decline'", async () => {
    loginAs(fx.memberA);
    const r = (await generateSummary(fx.flat, "7d"))!;
    expect(r.pattern).toBe("flat_or_slight_decline");
    console.log(`[flat/7d]   ${r.summary}`);
  });

  test("big drop → 'significant_decline'", async () => {
    loginAs(fx.memberA);
    const r = (await generateSummary(fx.decline, "7d"))!;
    expect(r.pattern).toBe("significant_decline");
    expect(r.summary.toLowerCase()).toMatch(/quiet|review|slow/);
    console.log(`[decline/7d] ${r.summary}`);
  });

  test("zero bookings → 'no_data'", async () => {
    loginAs(fx.memberA);
    const r = (await generateSummary(fx.noData, "7d"))!;
    expect(r.pattern).toBe("no_data");
    expect(r.summary).toContain("No tracked bookings");
    console.log(`[no_data]   ${r.summary}`);
  });
});

describe("formatting + edge cases", () => {
  test("first period omits the comparison sentence", async () => {
    loginAs(fx.memberA);
    const r = (await generateSummary(fx.first, "7d"))!;
    expect(r.pattern).toBe("strong");
    expect(r.metrics.revenueChangePct).toBeNull();
    expect(r.summary).not.toContain("from the week before");
    expect(r.summary).toContain("₹85K");
    console.log(`[first/7d]  ${r.summary}`);
  });

  test("a single ₹500 booking shows ₹500, not ₹0.5K", async () => {
    loginAs(fx.memberA);
    const r = (await generateSummary(fx.small, "7d"))!;
    expect(r.summary).toContain("₹500");
    expect(r.summary).not.toContain("0.5K");
    console.log(`[small/7d]  ${r.summary}`);
  });

  test("highlights include Meta, Google, and Instagram bullets (4–5)", async () => {
    loginAs(fx.memberA);
    const r = (await generateSummary(fx.strong, "7d"))!;
    expect(Array.isArray(r.highlights)).toBe(true);
    expect(r.highlights.length).toBeGreaterThanOrEqual(4);
    expect(r.highlights.length).toBeLessThanOrEqual(5);
    expect(r.highlights.some((h) => h.includes("Meta Ads"))).toBe(true);
    expect(r.highlights.some((h) => h.includes("Google Ads"))).toBe(true);
    expect(r.highlights.some((h) => h.includes("Instagram"))).toBe(true);
    console.log(`[highlights]`, r.highlights);
  });

  test("toggling period returns different content", async () => {
    loginAs(fx.memberA);
    const d7 = (await generateSummary(fx.strong, "7d"))!;
    const d1 = (await generateSummary(fx.strong, "1d"))!;
    const d30 = (await generateSummary(fx.strong, "30d"))!;
    expect(d7.periodLabel).toBe("last 7 days");
    expect(d1.periodLabel).toBe("yesterday");
    expect(d30.periodLabel).toBe("last 30 days");
    expect(d1.summary).not.toBe(d7.summary); // yesterday window has no booking → no_data
    console.log(`[strong/1d] ${d1.summary}`);
    console.log(`[strong/30d] ${d30.summary}`);
  });
});

describe("security + caching", () => {
  test("agency B cannot fetch agency A's hotel summary (404)", async () => {
    loginAs(fx.memberB);
    expect((await route(fx.strong)).status).toBe(404);
  });

  test("unauthenticated is rejected (401)", async () => {
    loginAs(null);
    expect((await route(fx.strong)).status).toBe(401);
  });

  test("the route caches within the window (same generatedAt on a repeat call)", async () => {
    loginAs(fx.memberA);
    const a = await (await route(fx.flat, "30d")).json();
    const b = await (await route(fx.flat, "30d")).json();
    expect(b.generatedAt).toBe(a.generatedAt); // served from cache
  });

  test("TtlLruCache expires entries after the TTL", async () => {
    const c = new TtlLruCache<string>(10, 30);
    c.set("k", "v");
    expect(c.get("k")).toBe("v");
    await new Promise((r) => setTimeout(r, 45));
    expect(c.get("k")).toBeUndefined();
  });
});
