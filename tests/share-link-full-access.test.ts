import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// ACCESS LOCKDOWN — the /h/<shareToken> hotel-owner-share surface is RETIRED.
// This suite (formerly "share-link full access") now proves the OPPOSITE of what
// it used to: a valid, active share token grants NOTHING. requireShareTokenAccess
// returns null, and the /api/hotel/[hotelClientId]/* read routes answer 404 (never
// revealing that the token was actually valid), EVEN when real data exists for the
// hotel. Hotels now see outcomes only via the public /share/<uuid> report.
//
// auth() is mocked to a SIGNED-OUT session so the token header is the only thing
// that could authorize a request — and it no longer does. A live DB holds fixtures.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: h.userId }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prisma } from "@/lib/prisma";
import { SHARE_TOKEN_HEADER } from "@/lib/share-token";
import { requireShareTokenAccess, requireReadAccess } from "@/lib/hotel-auth";
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

async function mkAgency(t: string) {
  return prisma.agency.create({
    data: { name: `${PREFIX}${t}`, email: `${PREFIX.toLowerCase()}${t}@x.test`, subscriptionStatus: "active" },
  });
}
async function mkHotel(agencyId: string, t: string, token: string) {
  return prisma.hotelClient.create({
    data: {
      agencyId, name: `${PREFIX}${t}`, websiteUrl: "https://h.example", contactName: "C", contactEmail: "c@t.local",
      siteId: `${PREFIX}s-${t}-${randomUUID()}`, conversionMethod: "both", otaCommissionRate: "15.00",
      showAdSpendToHotel: false,
      shareToken: token, shareTokenRevoked: false, shareTokenCreatedAt: new Date(),
    },
  });
}

let agencyA: string;
let hotelA1: string;
const tokenA1 = mkToken();

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const A = await mkAgency("AgencyA");
  agencyA = A.id;
  hotelA1 = (await mkHotel(agencyA, "HotelA1", tokenA1)).id;

  // Real Meta spend + a booking exist for hotelA1 — the whole point is that a
  // VALID token STILL can't read any of it now that the surface is retired.
  await prisma.adSnapshot.create({
    data: {
      agencyId: agencyA, hotelClientId: hotelA1, metaAccountId: "act_test", date: day(-3),
      spend: "1000.00", impressions: 10000, reach: 8000, clicks: 200, ctr: 2, cpc: "5", cpm: "100",
      conversions: 4, roas: 3, pixelPurchases: 0, pixelLeads: 0, pixelPageViews: 0,
    },
  });
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

beforeEach(() => { h.userId = null; });

describe("ACCESS LOCKDOWN — share-token gate denies unconditionally", () => {
  test("a valid, active token no longer grants access (returns null)", async () => {
    expect(await requireShareTokenAccess(tokenA1, hotelA1)).toBeNull();
  });

  test("requireReadAccess → 404 for a valid share token, 403 for a no-token request", async () => {
    const share = await requireReadAccess(
      new Request("http://x/", { headers: { [SHARE_TOKEN_HEADER]: tokenA1 } }),
      hotelA1,
    );
    expect(share).toEqual({ ok: false, status: 404 });

    const noAuth = await requireReadAccess(new Request("http://x/"), hotelA1);
    expect(noAuth).toEqual({ ok: false, status: 403 });
  });
});

describe("ACCESS LOCKDOWN — /api/hotel/[id]/* deny a valid share token (404)", () => {
  test("every read route returns 404 even with the hotel's own valid token + real data present", async () => {
    const cases: [GET, string][] = [
      [channelViewRoute.GET as GET, `channel=meta_ads&${WINDOW}`],
      [ownerMetricsRoute.GET as GET, WINDOW],
      [summaryRoute.GET as GET, "period=30d"],
      [revenueRoute.GET as GET, `granularity=source&${WINDOW}`],
      [savingsRoute.GET as GET, WINDOW],
      [reachSplitRoute.GET as GET, "range=30d"],
    ];
    for (const [get, query] of cases) {
      const res = await shareCall(get, hotelA1, tokenA1, query);
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
