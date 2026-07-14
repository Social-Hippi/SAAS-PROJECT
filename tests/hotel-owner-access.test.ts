import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// ACCESS LOCKDOWN — hotel logins are RETIRED. This suite (formerly "hotel-owner
// full visibility") now proves the OPPOSITE: the logged-in hotel-owner dashboard
// (/hotel/[id]) and its data routes grant NOTHING. requireHotelOwnerAccess denies
// everyone (owner AND agency member), the /api/hotel/[id]/* routes answer 403, and
// the owner edit action rejects — EVEN for the real owner, EVEN with real data.
//
// auth() is mocked (the gate reads it). A live DB holds the fixtures.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: h.userId }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prisma } from "@/lib/prisma";
import { requireHotelOwnerAccess } from "@/lib/hotel-auth";
import { updateHotelDetails } from "@/app/hotel/[hotelClientId]/dashboard/actions";
import { GET as channelViewGET } from "@/app/api/hotel/[hotelClientId]/channel-view/route";
import { GET as ownerMetricsGET } from "@/app/api/hotel/[hotelClientId]/owner-metrics/route";
import { GET as summaryGET } from "@/app/api/hotel/[hotelClientId]/summary/route";
import { GET as revenueGET } from "@/app/api/hotel/[hotelClientId]/revenue-by-source/route";
import { GET as savingsGET } from "@/app/api/hotel/[hotelClientId]/savings/route";

const PREFIX = "TEST_HOA_";
const loginAs = (id: string | null) => { h.userId = id; };
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const WINDOW = `startDate=${ymd(day(-14))}&endDate=${ymd(day(1))}`;

function call(
  GET: (req: Request, ctx: { params: Promise<{ hotelClientId: string }> }) => Promise<Response>,
  hotelClientId: string,
  query = WINDOW,
) {
  return GET(new Request(`http://localhost/api/hotel/${hotelClientId}/x?${query}`), {
    params: Promise.resolve({ hotelClientId }),
  });
}

async function mkAgency(t: string) {
  return prisma.agency.create({ data: { name: `${PREFIX}${t}`, email: `${PREFIX.toLowerCase()}${t}@x.test`, subscriptionStatus: "active" } });
}
async function mkHotel(agencyId: string, t: string, ownerUserId: string) {
  return prisma.hotelClient.create({
    data: {
      agencyId, name: `${PREFIX}${t}`, websiteUrl: "https://h.example", contactName: "C", contactEmail: "c@t.local",
      siteId: `${PREFIX}s-${t}-${randomUUID()}`, conversionMethod: "both", createdByUserId: ownerUserId,
      otaCommissionRate: "15.00",
    },
  });
}

let agencyA: string;
let ownerA1: string, memberAClerk: string;
let hotelA1: string;

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const A = await mkAgency("AgencyA");
  agencyA = A.id;

  ownerA1 = `user_ownerA1_${randomUUID()}`;
  memberAClerk = `user_memberA_${randomUUID()}`;
  await prisma.agencyMember.create({ data: { agencyId: A.id, clerkId: memberAClerk, email: "a@m.test", name: "A", role: "admin" } });

  hotelA1 = (await mkHotel(agencyA, "HotelA1", ownerA1)).id;

  // Real Meta spend + a booking exist — proving denial holds even with data present.
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

describe("ACCESS LOCKDOWN — requireHotelOwnerAccess denies unconditionally", () => {
  test("the real owner is now DENIED (returns null)", async () => {
    loginAs(ownerA1);
    expect(await requireHotelOwnerAccess(hotelA1)).toBeNull();
  });

  test("an agency member of the owning agency is now DENIED too", async () => {
    loginAs(memberAClerk);
    expect(await requireHotelOwnerAccess(hotelA1)).toBeNull();
  });

  test("a signed-out request is denied", async () => {
    loginAs(null);
    expect(await requireHotelOwnerAccess(hotelA1)).toBeNull();
  });
});

describe("ACCESS LOCKDOWN — /api/hotel/[id]/* deny a logged-in owner (403)", () => {
  test("the owner gets 403 from every read route (surface retired), despite real data", async () => {
    loginAs(ownerA1);
    for (const GET of [channelViewGET, ownerMetricsGET, summaryGET, savingsGET, revenueGET]) {
      const res = await call(GET, hotelA1, `channel=meta_ads&${WINDOW}`);
      expect(res.status).toBe(403);
    }
  });

  test("a member of the owning agency also gets 403", async () => {
    loginAs(memberAClerk);
    const res = await call(ownerMetricsGET, hotelA1);
    expect(res.status).toBe(403);
  });
});

describe("ACCESS LOCKDOWN — owner edits are rejected", () => {
  test("even the real owner can no longer update their hotel, and nothing is written", async () => {
    loginAs(ownerA1);
    const r = await updateHotelDetails(hotelA1, {
      contactName: "New Owner Name", contactEmail: "new@hotel.test", contactPhone: "9876543210",
      whatsappNumber: "9000000000", address: "456 New Road, City 560002", otaCommissionRate: "5", channelManager: "eZee",
    });
    expect(r.ok).toBe(false);
    const hotel = await prisma.hotelClient.findUnique({ where: { id: hotelA1 }, select: { contactName: true } });
    expect(hotel?.contactName).not.toBe("New Owner Name");
  });
});
