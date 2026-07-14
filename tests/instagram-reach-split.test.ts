import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Instagram Reach Split (owned vs influencer content). Verifies the aggregation
// loader's tenant + hotel isolation, sum integrity, date-range scoping and empty
// state; that a hotel owner reads their OWN hotel's split but is denied any other;
// that the agency link action is forbidden to non-members (hotel owners) and works
// for agency members; soft-deleted hotels are hidden; and that handle resolution +
// URL parsing degrade gracefully. A live DB holds the fixtures (cleaned by prefix).
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  member: null as null | Record<string, unknown>,
  role: "agency_admin" as string | undefined,
  userId: null as string | null,
}));
vi.mock("@/lib/auth", () => ({ getCurrentMember: async () => h.member, getPlatformRole: async () => h.role }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: h.userId }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prisma } from "@/lib/prisma";
import { runWithAgencyScope } from "@/lib/tenant";
import { loadInstagramReachSplit } from "@/lib/instagram-reach-split";
import { parseInstagramPostUrl, resolveHandleForAgency } from "@/lib/instagram-detect";
import { GET as hotelSplitGET } from "@/app/api/hotel/[hotelClientId]/instagram-reach-split/route";
import { POST as linkPOST } from "@/app/api/agency/hotels/[hotelId]/unattributed-mentions/[mentionId]/link/route";

const PREFIX = "TEST_IRS_";
const START = new Date(Date.UTC(2026, 2, 1, 0, 0, 0));
const END = new Date(Date.UTC(2026, 2, 31, 23, 59, 59));
const IN = new Date(Date.UTC(2026, 2, 15, 10, 0, 0));
const OUT = new Date(Date.UTC(2026, 0, 5, 10, 0, 0)); // January — outside the window

const loginMember = (m: Record<string, unknown> | null) => { h.member = m; };
const loginUser = (id: string | null) => { h.userId = id; };

let agencyA: string, agencyB: string;
let hMain: string, hOther: string, hEmpty: string, hB: string;
let ownerMain: string, ownerOther: string;
let memberA: Record<string, unknown>;
let infA: string, infA2: string, infB: string;

async function mkAgency(t: string): Promise<string> {
  const a = await prisma.agency.create({ data: { name: `${PREFIX}${t}`, email: `${PREFIX.toLowerCase()}${t}@x.test`, subscriptionStatus: "active" } });
  return a.id;
}
async function mkHotel(agencyId: string, t: string, ownerUserId: string | null): Promise<string> {
  const hc = await prisma.hotelClient.create({
    data: {
      agencyId, name: `${PREFIX}${t}`, websiteUrl: "https://h.example", contactName: "C", contactEmail: "c@t.local",
      siteId: `${PREFIX}s-${t}-${randomUUID()}`, conversionMethod: "both", createdByUserId: ownerUserId,
    },
  });
  return hc.id;
}
async function mkInfluencer(agencyId: string, hotelClientId: string | null, name: string): Promise<string> {
  const i = await prisma.influencer.create({ data: { agencyId, hotelClientId, name: `${PREFIX}${name}`, instagramHandle: name } });
  return i.id;
}
function ownedPost(agencyId: string, hotelClientId: string, reach: number, postedAt: Date) {
  return prisma.postSnapshot.create({
    data: { agencyId, hotelClientId, mediaId: `${PREFIX}${randomUUID()}`, mediaType: "image", permalink: "https://insta/p/x", postedAt, reach, impressions: reach * 2, likes: 10, comments: 2, saves: 3, shares: 1 },
  });
}
function infPost(agencyId: string, hotelClientId: string, influencerId: string, reach: number | null, postedAt: Date) {
  return prisma.influencerInstagramPost.create({
    data: {
      agencyId, hotelClientId, influencerId, instagramPostId: `${PREFIX}${randomUUID()}`, instagramUserId: "ig_x",
      postedAt, mediaType: "reel", permalink: "https://insta/reel/x", reach, likes: 20, comments: 4, saves: 5, shares: 2,
      taggedHotelAccount: true,
    },
  });
}
function mention(agencyId: string, hotelClientId: string, postedAt: Date) {
  return prisma.unattributedMention.create({
    data: {
      agencyId, hotelClientId, instagramPostId: `${PREFIX}${randomUUID()}`, posterUsername: "random_guest",
      posterInstagramUserId: "ig_guest", postedAt, mediaType: "image", permalink: "https://insta/p/u", taggedHotelAccount: true,
    },
  });
}

const split = (agencyId: string, hotelClientId: string) =>
  runWithAgencyScope(agencyId, () => loadInstagramReachSplit(hotelClientId, START, END));

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });

  agencyA = await mkAgency("A");
  agencyB = await mkAgency("B");
  ownerMain = `${PREFIX}ownerMain-${randomUUID()}`;
  ownerOther = `${PREFIX}ownerOther-${randomUUID()}`;

  hMain = await mkHotel(agencyA, "Main", ownerMain);
  hOther = await mkHotel(agencyA, "Other", ownerOther);
  hEmpty = await mkHotel(agencyA, "Empty", null);
  hB = await mkHotel(agencyB, "B", null);

  const memberAClerk = `${PREFIX}memA-${randomUUID()}`;
  const m = await prisma.agencyMember.create({ data: { agencyId: agencyA, clerkId: memberAClerk, email: "a@m.test", name: "A", role: "admin" } });
  memberA = { id: m.id, agencyId: agencyA, role: "admin" };

  infA = await mkInfluencer(agencyA, hMain, "priya");
  infA2 = await mkInfluencer(agencyA, hOther, "ravi");
  infB = await mkInfluencer(agencyB, hB, "bee");

  // hMain — owned: 1000 + 2000 in-window, 9999 out-of-window.
  await ownedPost(agencyA, hMain, 1000, IN);
  await ownedPost(agencyA, hMain, 2000, IN);
  await ownedPost(agencyA, hMain, 9999, OUT);
  // hMain — influencer: 500 + null in-window, 8888 out-of-window.
  await infPost(agencyA, hMain, infA, 500, IN);
  await infPost(agencyA, hMain, infA, null, IN);
  await infPost(agencyA, hMain, infA, 8888, OUT);
  await mention(agencyA, hMain, IN);

  // hOther (same agency) — must never appear in hMain's split.
  await ownedPost(agencyA, hOther, 777, IN);
  await infPost(agencyA, hOther, infA2, 333, IN);

  // hB (other agency) — must never appear in agency A's split.
  await ownedPost(agencyB, hB, 4444, IN);
  await infPost(agencyB, hB, infB, 2222, IN);
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe("aggregation", () => {
  test("sum integrity: owned + influencer reach match per-post totals (known reach only)", async () => {
    const s = await split(agencyA, hMain);
    expect(s.ownedContent.reach).toBe(3000);       // 1000 + 2000
    expect(s.ownedContent.postCount).toBe(2);
    expect(s.influencerContent.reach).toBe(500);    // 500 + (null excluded)
    expect(s.influencerContent.postCount).toBe(2);  // both in-window posts counted
    expect(s.influencerContent.influencerCount).toBe(1);
    expect(s.totalReach).toBe(3500);                // 3000 + 500
    const row = s.influencerContent.breakdown.find((r) => r.influencerId === infA);
    expect(row?.totalReach).toBe(500);
    expect(row?.postCount).toBe(2);
  });

  test("date range scopes both owned and influencer data", async () => {
    const s = await split(agencyA, hMain);
    // The out-of-window 9999 (owned) and 8888 (influencer) must be excluded.
    expect(s.ownedContent.reach).toBe(3000);
    expect(s.influencerContent.reach).toBe(500);
    const trendOwned = s.trendDaily.reduce((n, d) => n + d.ownedReach, 0);
    expect(trendOwned).toBe(3000);
  });

  test("agency isolation: agency A's split excludes agency B's posts", async () => {
    const s = await split(agencyA, hMain);
    expect(s.totalReach).toBe(3500); // would be larger if B's 4444/2222 leaked
    const sB = await split(agencyB, hB);
    expect(sB.ownedContent.reach).toBe(4444);
    expect(sB.influencerContent.reach).toBe(2222);
  });

  test("hotel isolation within an agency: hMain excludes hOther", async () => {
    const s = await split(agencyA, hMain);
    // hOther's 777 owned + 333 influencer must not appear.
    expect(s.ownedContent.reach).toBe(3000);
    expect(s.influencerContent.breakdown.some((r) => r.influencerId === infA2)).toBe(false);
  });

  test("empty state: a hotel with no posts returns zeros", async () => {
    const s = await split(agencyA, hEmpty);
    expect(s.totalReach).toBe(0);
    expect(s.ownedContent.postCount).toBe(0);
    expect(s.influencerContent.breakdown).toHaveLength(0);
    expect(s.unattributed.count).toBe(0);
  });
});

describe("hotel-owner access", () => {
  const callHotel = (hotelClientId: string) =>
    hotelSplitGET(new Request(`http://localhost/api/hotel/${hotelClientId}/instagram-reach-split?range=30d`), {
      params: Promise.resolve({ hotelClientId }),
    });

  test("ACCESS LOCKDOWN: the owner is denied even their OWN hotel's split (surface retired)", async () => {
    loginUser(ownerMain);
    const res = await callHotel(hMain);
    expect(res.status).toBe(403);
  });

  test("owner CANNOT read another hotel's split (same agency or not)", async () => {
    loginUser(ownerMain);
    expect((await callHotel(hOther)).status).toBe(403);
    expect((await callHotel(hB)).status).toBe(403);
  });

  test("soft-deleted hotel is hidden from its owner", async () => {
    loginUser(ownerMain);
    await prisma.hotelClient.update({ where: { id: hMain }, data: { deletedAt: new Date() } });
    try {
      expect((await callHotel(hMain)).status).toBe(403);
    } finally {
      await prisma.hotelClient.update({ where: { id: hMain }, data: { deletedAt: null } });
    }
  });
});

describe("link unattributed mention (agency action)", () => {
  const callLink = (hotelId: string, mentionId: string, influencerId: string) =>
    linkPOST(new Request(`http://localhost/api/agency/hotels/${hotelId}/unattributed-mentions/${mentionId}/link`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ influencerId }),
    }), { params: Promise.resolve({ hotelId, mentionId }) });

  test("hotel owner (non-member) cannot link — 403", async () => {
    loginMember(null); // a hotel owner is not an AgencyMember → getCurrentMember null
    const m = await mention(agencyA, hMain, IN);
    const res = await callLink(hMain, m.id, infA);
    expect(res.status).toBe(403);
    // the mention must remain unlinked
    expect(await prisma.unattributedMention.findUnique({ where: { id: m.id } })).not.toBeNull();
  });

  test("agency member links a mention → promotes to influencer post, removes mention", async () => {
    loginMember(memberA);
    const m = await mention(agencyA, hMain, IN);
    const res = await callLink(hMain, m.id, infA);
    expect(res.status).toBe(200);
    expect(await prisma.unattributedMention.findUnique({ where: { id: m.id } })).toBeNull();
    const promoted = await prisma.influencerInstagramPost.findUnique({ where: { instagramPostId: m.instagramPostId } });
    expect(promoted?.influencerId).toBe(infA);
  });
});

describe("graceful degradation", () => {
  test("handle resolution returns null (no crash) when no connection exists", async () => {
    await expect(resolveHandleForAgency(agencyA, hMain, "somehandle")).resolves.toBeNull();
  });

  test("post-URL parsing handles valid and invalid input", () => {
    expect(parseInstagramPostUrl("https://www.instagram.com/p/ABC123/")?.shortcode).toBe("ABC123");
    expect(parseInstagramPostUrl("https://www.instagram.com/reel/XYZ789/")?.mediaType).toBe("reel");
    expect(parseInstagramPostUrl("https://example.com/not-instagram")).toBeNull();
    expect(parseInstagramPostUrl("garbage")).toBeNull();
  });
});
