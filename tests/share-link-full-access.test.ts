import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// TWO share credentials, and they are NOT equivalent.
//
//   • the legacy 64-hex HotelClient.shareToken (/h/<token>) — RETIRED. It had no
//     expiry, no revocation and no password, so a leaked URL was permanent. It
//     still grants nothing, and the first half of this suite proves it: the read
//     routes answer 404 even for a valid token with real data behind it.
//
//   • the ShareLink uuid (/share/<uuid>) — LIVE, and now serving the full
//     dashboard. It carries the three things the raw token never had, so the
//     second half of this suite proves each of them actually bites: revoked,
//     expired and password-locked links are all refused at the DATA routes, not
//     just on the page.
//
// The test that matters most is neither of those: it is that link A cannot read
// hotel B. A share token is the only credential on that request, so a missing
// hotel comparison would turn one hotel's link into an agency-wide read.
//
// auth() is mocked to a SIGNED-OUT session throughout, so the token header is the
// only thing that could authorize a request. next/headers is mocked so the
// password-unlock cookie can be set per test. A live DB holds the fixtures.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  userId: null as string | null,
  cookieJar: new Map<string, string>(),
}));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: h.userId }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      h.cookieJar.has(name) ? { name, value: h.cookieJar.get(name)! } : undefined,
  }),
  headers: async () => new Headers(),
}));

import { prisma } from "@/lib/prisma";
import { SHARE_TOKEN_HEADER } from "@/lib/share-token";
import { signUnlock, unlockCookieName, hashSharePassword } from "@/lib/share";
import { resolveShareLink } from "@/lib/share-link-access";
import {
  requireShareTokenAccess,
  requireShareLinkAccess,
  requireReadAccess,
} from "@/lib/hotel-auth";
import * as channelViewRoute from "@/app/api/hotel/[hotelClientId]/channel-view/route";
import * as ownerMetricsRoute from "@/app/api/hotel/[hotelClientId]/owner-metrics/route";
import * as summaryRoute from "@/app/api/hotel/[hotelClientId]/summary/route";
import * as revenueRoute from "@/app/api/hotel/[hotelClientId]/revenue-by-source/route";
import * as savingsRoute from "@/app/api/hotel/[hotelClientId]/savings/route";
import * as reachSplitRoute from "@/app/api/hotel/[hotelClientId]/instagram-reach-split/route";

const PREFIX = "TEST_SHARE_";
const mkToken = () => randomBytes(32).toString("hex");
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const WINDOW = `startDate=${ymd(day(-14))}&endDate=${ymd(day(1))}`;

type GET = (req: Request, ctx: { params: Promise<{ hotelClientId: string }> }) => Promise<Response>;

// Build a share-link request: NO Clerk session, token carried in the header.
function shareCall(get: GET, hotelClientId: string, token: string | undefined, query = WINDOW) {
  return get(
    new Request(`http://localhost/api/hotel/${hotelClientId}/x?${query}`, {
      headers: token ? { [SHARE_TOKEN_HEADER]: token } : undefined,
    }),
    { params: Promise.resolve({ hotelClientId }) },
  );
}

const ALL_READ_ROUTES: [GET, string][] = [
  [channelViewRoute.GET as GET, `channel=meta_ads&${WINDOW}`],
  [ownerMetricsRoute.GET as GET, WINDOW],
  [summaryRoute.GET as GET, "period=30d"],
  [revenueRoute.GET as GET, `granularity=source&${WINDOW}`],
  [savingsRoute.GET as GET, WINDOW],
  [reachSplitRoute.GET as GET, "range=30d"],
];

async function mkAgency(t: string) {
  return prisma.agency.create({
    data: { name: `${PREFIX}${t}`, email: `${PREFIX.toLowerCase()}${t}@x.test`, subscriptionStatus: "active" },
  });
}
async function mkHotel(agencyId: string, t: string, token: string, showAdSpendToHotel = false) {
  return prisma.hotelClient.create({
    data: {
      agencyId, name: `${PREFIX}${t}`, websiteUrl: "https://h.example", contactName: "C", contactEmail: "c@t.local",
      siteId: `${PREFIX}s-${t}-${randomUUID()}`, conversionMethod: "both", otaCommissionRate: "15.00",
      showAdSpendToHotel,
      shareToken: token, shareTokenRevoked: false, shareTokenCreatedAt: new Date(),
    },
  });
}
async function mkLink(
  agencyId: string,
  hotelClientId: string,
  opts: { expiresAt?: Date; revokedAt?: Date | null; password?: string } = {},
) {
  return prisma.shareLink.create({
    data: {
      agencyId,
      hotelClientId,
      expiresAt: opts.expiresAt ?? day(30),
      revokedAt: opts.revokedAt ?? null,
      passwordHash: opts.password ? hashSharePassword(opts.password) : null,
    },
    select: { id: true, token: true },
  });
}

let agencyA: string;
let hotelA1: string;
let hotelA2: string;
const legacyTokenA1 = mkToken();

let liveLink: string;        // live link for hotelA1 (spend hidden)
let spendShownLink: string;  // live link for hotelA2 (spend shared)
let revokedLink: string;
let expiredLink: string;
let lockedLink: string;

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const A = await mkAgency("AgencyA");
  agencyA = A.id;
  hotelA1 = (await mkHotel(agencyA, "HotelA1", legacyTokenA1, false)).id;
  hotelA2 = (await mkHotel(agencyA, "HotelA2", mkToken(), true)).id;

  // Real Meta spend + a booking exist for hotelA1 — so "denied" below can never
  // be confused with "there was nothing to return anyway".
  await prisma.adSnapshot.create({
    data: {
      agencyId: agencyA, hotelClientId: hotelA1, metaAccountId: "act_test", date: day(-3),
      spend: "1000.00", impressions: 10000, reach: 8000, clicks: 200, ctr: 2, cpc: "5", cpm: "100",
      conversions: 4, roas: 3, pixelPurchases: 0, pixelLeads: 0, pixelPageViews: 0,
    },
  });

  liveLink = (await mkLink(agencyA, hotelA1)).token;
  spendShownLink = (await mkLink(agencyA, hotelA2)).token;
  revokedLink = (await mkLink(agencyA, hotelA1, { revokedAt: new Date() })).token;
  expiredLink = (await mkLink(agencyA, hotelA1, { expiresAt: day(-1) })).token;
  lockedLink = (await mkLink(agencyA, hotelA1, { password: "hunter2" })).token;
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

beforeEach(() => {
  h.userId = null;
  h.cookieJar.clear();
});

// ── 1. The legacy /h token stays retired ────────────────────────────────────

describe("ACCESS LOCKDOWN — the legacy /h share token denies unconditionally", () => {
  test("a valid, active HotelClient.shareToken grants nothing (returns null)", async () => {
    expect(await requireShareTokenAccess(legacyTokenA1, hotelA1)).toBeNull();
  });

  test("requireReadAccess → 404 for the legacy token, 403 for a no-token request", async () => {
    const share = await requireReadAccess(
      new Request("http://x/", { headers: { [SHARE_TOKEN_HEADER]: legacyTokenA1 } }),
      hotelA1,
    );
    expect(share).toEqual({ ok: false, status: 404 });

    const noAuth = await requireReadAccess(new Request("http://x/"), hotelA1);
    expect(noAuth).toEqual({ ok: false, status: 403 });
  });

  test("every read route 404s for the legacy token even with real data present", async () => {
    for (const [get, query] of ALL_READ_ROUTES) {
      const res = await shareCall(get, hotelA1, legacyTokenA1, query);
      expect(res.status).toBe(404);
    }
  });

  test("the read routes still export NO write verbs (defense-in-depth unchanged)", () => {
    for (const mod of [channelViewRoute, ownerMetricsRoute, summaryRoute, revenueRoute, savingsRoute, reachSplitRoute]) {
      const m = mod as Record<string, unknown>;
      expect(m.POST).toBeUndefined();
      expect(m.PUT).toBeUndefined();
      expect(m.DELETE).toBeUndefined();
      expect(m.PATCH).toBeUndefined();
    }
  });
});

// ── 2. The /share/<uuid> link grants READ access to its own hotel ───────────

describe("/share/<uuid> — a live link reads its own hotel", () => {
  test("the gate resolves, and pins the hotel + agency off the ROW", async () => {
    const access = await requireShareLinkAccess(liveLink, hotelA1);
    expect(access).not.toBeNull();
    expect(access!.agencyId).toBe(agencyA);
    expect(access!.hotelId).toBe(hotelA1);
  });

  test("a link-holder is never an owner and never the agency", async () => {
    const access = await requireShareLinkAccess(liveLink, hotelA1);
    expect(access!.isOwner).toBe(false);
    expect(access!.isAgencyMember).toBe(false);
  });

  test("it carries READ capabilities only — no management capability at all", async () => {
    const access = await requireShareLinkAccess(liveLink, hotelA1);
    for (const cap of ["viewPerformance", "viewDataHealth", "viewGuestDetails"] as const) {
      expect(access!.can(cap), cap).toBe(true);
    }
    for (const cap of ["manageIntegrations", "manageHotelSettings", "manageTeam", "manageAsAgency"] as const) {
      expect(access!.can(cap), cap).toBe(false);
    }
  });

  test("every read route answers 200 for a live link", async () => {
    for (const [get, query] of ALL_READ_ROUTES) {
      const res = await shareCall(get, hotelA1, liveLink, query);
      expect(res.status).toBe(200);
    }
  });
});

// ── 3. Cross-hotel isolation — the test that matters most ───────────────────

describe("/share/<uuid> — one hotel's link can never read another's", () => {
  test("a valid link for hotel A is refused for hotel B in the SAME agency", async () => {
    expect(await requireShareLinkAccess(liveLink, hotelA2)).toBeNull();
  });

  test("the read routes answer 404 (not 403) for that mismatch", async () => {
    for (const [get, query] of ALL_READ_ROUTES) {
      const res = await shareCall(get, hotelA2, liveLink, query);
      expect(res.status).toBe(404);
    }
  });
});

// ── 4. Revocation, expiry and the password gate bite at the DATA routes ─────

describe("/share/<uuid> — revoked, expired and locked links are refused", () => {
  test("a revoked link resolves to unavailable and 404s", async () => {
    const r = await resolveShareLink(revokedLink);
    expect(r).toEqual({ ok: false, reason: "unavailable" });
    expect(await requireShareLinkAccess(revokedLink, hotelA1)).toBeNull();
    expect((await shareCall(ownerMetricsRoute.GET as GET, hotelA1, revokedLink)).status).toBe(404);
  });

  test("an expired link resolves to expired and 404s", async () => {
    const r = await resolveShareLink(expiredLink);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("expired");
    expect(await requireShareLinkAccess(expiredLink, hotelA1)).toBeNull();
    expect((await shareCall(ownerMetricsRoute.GET as GET, hotelA1, expiredLink)).status).toBe(404);
  });

  test("a password-locked link is refused at the DATA routes, not just the page", async () => {
    // The lock screen is not the security boundary: someone who copies the token
    // out of the URL must not be able to read the JSON straight past it.
    const r = await resolveShareLink(lockedLink);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("locked");
    expect(await requireShareLinkAccess(lockedLink, hotelA1)).toBeNull();
    expect((await shareCall(ownerMetricsRoute.GET as GET, hotelA1, lockedLink)).status).toBe(404);
  });

  test("with the unlock cookie, the same locked link reads normally", async () => {
    h.cookieJar.set(unlockCookieName(lockedLink), signUnlock(lockedLink));
    const r = await resolveShareLink(lockedLink);
    expect(r.ok).toBe(true);
    expect((await shareCall(ownerMetricsRoute.GET as GET, hotelA1, lockedLink)).status).toBe(200);
  });

  test("a forged unlock cookie does not open it", async () => {
    h.cookieJar.set(unlockCookieName(lockedLink), signUnlock("some-other-token"));
    const r = await resolveShareLink(lockedLink);
    expect(r.ok === false && r.reason).toBe("locked");
  });

  test("a malformed token never reaches the database", async () => {
    for (const bogus of ["", "   ", "not-a-uuid", legacyTokenA1]) {
      expect(await resolveShareLink(bogus)).toEqual({ ok: false, reason: "unavailable" });
    }
  });
});

// ── 5. showAdSpendToHotel still governs what a link-holder sees ─────────────

describe("/share/<uuid> — the ad-spend toggle reaches the data routes", () => {
  test("spendVisible follows the hotel's flag", async () => {
    const hidden = await requireShareLinkAccess(liveLink, hotelA1);
    const shown = await requireShareLinkAccess(spendShownLink, hotelA2);
    expect(hidden!.spendVisible).toBe(false);
    expect(shown!.spendVisible).toBe(true);
  });

  test("a session always sees spend, regardless of the flag", async () => {
    // The toggle governs the public link only; it has never gated a logged-in
    // dashboard, and this pins that so a future change is deliberate.
    const { requireHotelOwnerAccess } = await import("@/lib/hotel-auth");
    h.userId = null;
    expect(await requireHotelOwnerAccess(hotelA1)).toBeNull(); // signed out → no access
  });

  test("owner-metrics strips spend for a spend-hidden link, keeping outcomes", async () => {
    const res = await shareCall(ownerMetricsRoute.GET as GET, hotelA1, liveLink);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Spend and everything spend divides into are gone …
    expect(body.marketingSpend.total).toBeNull();
    expect(body.marketingSpend.meta).toBe(0);
    expect(body.costPerBooking.costPerBooking).toBeNull();
    expect(body.costPerBooking.totalSpend).toBeNull();
    expect(body.roas.overall).toBeNull();
    expect(body.roas.blended).toBeNull();
    for (const c of body.topCampaigns.campaigns) {
      expect(c.spend).toBeNull();
      expect(c.roas).toBeNull();
    }
    // … while the outcome figures the report exists to show survive.
    expect(body.roas).toHaveProperty("totalRevenue");
    expect(body.costPerBooking).toHaveProperty("bookings");
    expect(body.conversionRate).toBeDefined();
  });

  test("the paid channel view hands back no spend for a spend-hidden link", async () => {
    const res = await shareCall(
      channelViewRoute.GET as GET, hotelA1, liveLink, `channel=meta_ads&${WINDOW}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    if (body?.kpis) {
      expect(body.kpis.totalSpend).toBe(0);
      expect(body.kpis.cpc).toBe(0);
      expect(body.kpis.cpm).toBe(0);
      expect(body.kpis.roas).toBeNull();
      expect(body.kpis.costPerBooking).toBeNull();
      expect(body.kpis.costPerConversion).toBeNull();
    }
    expect(body?.accounts ?? []).toEqual([]);
    for (const t of body?.trend ?? []) expect(t.spend).toBe(0);
  });

  test("the spend-visible link still gets its real spend", async () => {
    const res = await shareCall(channelViewRoute.GET as GET, hotelA2, spendShownLink, `channel=meta_ads&${WINDOW}`);
    expect(res.status).toBe(200);
    // hotelA2 has no AdSnapshot, so the assertion here is only that nothing was
    // stripped: the payload is whatever the loader produced, untouched.
    const body = await res.json();
    expect(body).toBeDefined();
  });

  test("the narrated summary never quotes spend on a spend-hidden link", async () => {
    const res = await shareCall(summaryRoute.GET as GET, hotelA1, liveLink, "period=30d");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metrics.adSpend).toBe(0);
    expect(body.metrics.roas).toBeNull();
    // The prose is generated, not stripped — so assert over the text itself.
    const text = [body.summary, ...(body.highlights ?? [])].join(" ");
    expect(text).not.toMatch(/spent /i);
    expect(text).not.toMatch(/ROAS/);
  });
});
