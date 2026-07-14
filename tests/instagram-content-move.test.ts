import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// "My Instagram Content" move. Posts/content were displayed on the Manage
// Integrations page; they now live ONLY on the hotel dashboard's Instagram
// Organic channel view. This file verifies:
//   • the loader emits a `posts` payload (recent + 3 top-performing sorts) for
//     instagram_organic, and NO other channel carries posts,
//   • the Recent / Top-Performing (reach·engagement·saves) orderings are correct,
//     plus captionPreview truncation, engagementRate, postType normalisation,
//     date-range filtering, and the 50-row cap,
//   • multi-tenant isolation (Agency A never sees Agency B's posts; cross-agency
//     and soft-deleted hotels → 404),
//   • the display was removed from Integrations and added to the channel view
//     (source-level regression guards, since the suite has no React DOM harness).
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ member: null as null | Record<string, unknown>, role: "agency_admin" as string | undefined }));
vi.mock("@/lib/auth", () => ({ getCurrentMember: async () => h.member, getPlatformRole: async () => h.role }));

import { prisma } from "@/lib/prisma";
import { loadChannelView, type InstagramChannelView, type PaidChannelView } from "@/lib/channel-view";
import { GET as channelGET } from "@/app/api/agency/hotels/[hotelId]/channel-view/route";

const PREFIX = "TEST_IGC_";
const START = new Date(Date.UTC(2026, 2, 1, 0, 0, 0));
const END = new Date(Date.UTC(2026, 2, 31, 23, 59, 59));
const loginAs = (m: Record<string, unknown> | null) => { h.member = m; };

function route(hotelId: string, query = "") {
  return channelGET(new Request(`http://localhost/api/agency/hotels/${hotelId}/channel-view?${query}`), {
    params: Promise.resolve({ hotelId }),
  });
}

// A caption longer than 80 chars, to exercise the "…" truncation.
const LONG_CAPTION =
  "Wake up to misty Western Ghats and a steaming pot of estate coffee on your private veranda — paradise";

describe("My Instagram Content — data layer + isolation", () => {
  let memberA: Record<string, unknown>, memberB: Record<string, unknown>;
  let agencyA: string;
  let hMain: string, hDeleted: string, hB: string;

  function post(
    agencyId: string, hotelClientId: string,
    o: { mediaId?: string; caption?: string; mediaType?: string; permalink?: string | null; postedAt: Date;
         reach: number; impressions?: number; likes?: number; comments?: number; saves?: number; shares?: number },
  ) {
    return prisma.postSnapshot.create({ data: {
      agencyId, hotelClientId, mediaId: o.mediaId ?? `m_${randomUUID()}`,
      caption: o.caption ?? "", mediaType: o.mediaType ?? "image", permalink: o.permalink ?? null,
      postedAt: o.postedAt, reach: o.reach, impressions: o.impressions ?? 0,
      likes: o.likes ?? 0, comments: o.comments ?? 0, saves: o.saves ?? 0, shares: o.shares ?? 0,
    } });
  }

  beforeAll(async () => {
    await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
    const A = await prisma.agency.create({ data: { name: `${PREFIX}A`, email: `${PREFIX}a@x.test`, subscriptionStatus: "active" } });
    const B = await prisma.agency.create({ data: { name: `${PREFIX}B`, email: `${PREFIX}b@x.test`, subscriptionStatus: "active" } });
    agencyA = A.id;
    const mA = await prisma.agencyMember.create({ data: { agencyId: A.id, clerkId: `${PREFIX}a-${Date.now()}`, email: "a@m.test", name: "A", role: "admin" } });
    const mB = await prisma.agencyMember.create({ data: { agencyId: B.id, clerkId: `${PREFIX}b-${Date.now()}`, email: "b@m.test", name: "B", role: "admin" } });
    memberA = { id: mA.id, agencyId: A.id, email: "a@socialhippi.com", role: "admin" }; memberB = { id: mB.id, agencyId: B.id, email: "b@socialhippi.com", role: "admin" };

    const mk = (a: string, t: string) => prisma.hotelClient.create({ data: { agencyId: a, name: `${PREFIX}${t}`, websiteUrl: "https://h.example", contactName: "C", contactEmail: "c@t.local", siteId: `${PREFIX}s-${t}-${Date.now()}`, conversionMethod: "both" } });
    hMain = (await mk(A.id, "Main")).id;
    hDeleted = (await mk(A.id, "Deleted")).id;
    hB = (await mk(B.id, "B1")).id;

    // Four in-window posts for hMain. reach order ≠ date order ≠ saves order so
    // every sort produces a distinct sequence we can assert on.
    // P1 newest, P2 highest reach, P3 highest saves + engagement, P4 oldest.
    await post(A.id, hMain, { mediaId: "P1", caption: "Reel sunset", mediaType: "reels", permalink: "https://instagram.com/p/P1", postedAt: new Date(Date.UTC(2026, 2, 20)), reach: 1000, likes: 50, comments: 5, saves: 5, shares: 0 }); // rate 6.0
    await post(A.id, hMain, { mediaId: "P2", caption: LONG_CAPTION, mediaType: "image", permalink: null, postedAt: new Date(Date.UTC(2026, 2, 15)), reach: 5000, likes: 200, comments: 20, saves: 10, shares: 10 }); // rate 4.8
    await post(A.id, hMain, { mediaId: "P3", caption: "Carousel tour", mediaType: "carousel", postedAt: new Date(Date.UTC(2026, 2, 10)), reach: 2000, likes: 100, comments: 10, saves: 100, shares: 5 }); // rate 10.75
    await post(A.id, hMain, { mediaId: "P4", caption: "Video walk", mediaType: "video", postedAt: new Date(Date.UTC(2026, 2, 5)), reach: 3000, likes: 80, comments: 8, saves: 8, shares: 4 }); // rate 3.33
    // Older than the window. The CONTENT TABLE is not date-filtered, so this
    // still appears (sorting last — modest metrics); but the date-ranged KPIs
    // must exclude it.
    await post(A.id, hMain, { mediaId: "POLD", caption: "Old post", mediaType: "image", postedAt: new Date(Date.UTC(2026, 1, 20)), reach: 500, likes: 10, comments: 1, saves: 1, shares: 0 });
    // Connection so hasData is true even independent of posts.
    await prisma.instagramConnection.create({ data: { agencyId: A.id, hotelClientId: hMain, igUserId: "ig1", username: "hotel_ig", encryptedToken: "x", status: "active" } });

    // Soft-deleted hotel (agency A) with a post — access must be blocked.
    await post(A.id, hDeleted, { mediaId: "PDEL", caption: "Hidden", postedAt: new Date(Date.UTC(2026, 2, 12)), reach: 4242 });
    await prisma.hotelClient.update({ where: { id: hDeleted }, data: { deletedAt: new Date() } });

    // Agency B's post — must never appear in Agency A's view.
    await post(B.id, hB, { mediaId: "PB", caption: "Competitor secret", postedAt: new Date(Date.UTC(2026, 2, 14)), reach: 8888, saves: 8888 });
  });

  afterAll(async () => {
    await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  });

  test("instagram_organic returns a posts payload with all four orderings", async () => {
    loginAs(memberA);
    const d = (await loadChannelView(hMain, "instagram_organic", START, END)) as InstagramChannelView;
    expect(d.posts).not.toBeNull();
    expect(Object.keys(d.posts!.topPerforming).sort()).toEqual(["byEngagement", "byReach", "bySaves"]);
    // The table is NOT date-filtered: the older POLD post appears in every ordering.
    const allIds = [d.posts!.recent, d.posts!.topPerforming.byReach, d.posts!.topPerforming.byEngagement, d.posts!.topPerforming.bySaves].flat().map((p) => p.id);
    expect(allIds).toContain("POLD");
  });

  test("Recent is sorted by posted date DESC", async () => {
    loginAs(memberA);
    const d = (await loadChannelView(hMain, "instagram_organic", START, END)) as InstagramChannelView;
    expect(d.posts!.recent.map((p) => p.id)).toEqual(["P1", "P2", "P3", "P4", "POLD"]);
  });

  test("Top Performing sub-toggles sort by reach / engagement / saves DESC", async () => {
    loginAs(memberA);
    const d = (await loadChannelView(hMain, "instagram_organic", START, END)) as InstagramChannelView;
    expect(d.posts!.topPerforming.byReach.map((p) => p.id)).toEqual(["P2", "P4", "P3", "P1", "POLD"]);
    expect(d.posts!.topPerforming.bySaves.map((p) => p.id)).toEqual(["P3", "P2", "P4", "P1", "POLD"]);
    expect(d.posts!.topPerforming.byEngagement.map((p) => p.id)).toEqual(["P3", "P1", "P2", "P4", "POLD"]);
  });

  test("post fields: engagementRate, captionPreview truncation, postType, permalink", async () => {
    loginAs(memberA);
    const d = (await loadChannelView(hMain, "instagram_organic", START, END)) as InstagramChannelView;
    const byId = Object.fromEntries(d.posts!.recent.map((p) => [p.id, p]));
    // engagementRate = (likes+comments+saves+shares)/reach*100. P3: 215/2000*100 = 10.75.
    expect(byId.P3.engagementRate).toBeCloseTo(10.75, 4);
    expect(byId.P1.engagementRate).toBeCloseTo(6.0, 4);
    // Caption > 80 chars truncates with an ellipsis; ≤ 80 stays intact.
    expect(byId.P2.captionPreview.endsWith("…")).toBe(true);
    expect(byId.P2.captionPreview.length).toBe(81); // 80 chars + "…"
    expect(byId.P1.captionPreview).toBe("Reel sunset");
    // mediaType normalisation → badge vocabulary.
    expect(byId.P1.postType).toBe("reel");   // "reels"
    expect(byId.P4.postType).toBe("reel");   // "video"
    expect(byId.P2.postType).toBe("image");
    expect(byId.P3.postType).toBe("carousel");
    // permalink passes through (null when absent).
    expect(byId.P1.permalink).toBe("https://instagram.com/p/P1");
    expect(byId.P2.permalink).toBeNull();
  });

  test("content table ignores the window; KPIs respect it", async () => {
    loginAs(memberA);
    const narrowStart = new Date(Date.UTC(2026, 2, 12));
    const narrowEnd = new Date(Date.UTC(2026, 2, 25));
    const d = (await loadChannelView(hMain, "instagram_organic", narrowStart, narrowEnd)) as InstagramChannelView;
    // Table still shows ALL synced posts regardless of the narrow window.
    expect(d.posts!.recent.map((p) => p.id).sort()).toEqual(["P1", "P2", "P3", "P4", "POLD"]);
    // KPIs are date-scoped: only P1 (Mar 20) + P2 (Mar 15) fall in [Mar 12, Mar 25].
    expect(d.kpis.postReach).toBe(6000); // 1000 + 5000, excludes P3/P4/POLD
  });

  test("KPIs over the full window exclude the out-of-window post", async () => {
    loginAs(memberA);
    const d = (await loadChannelView(hMain, "instagram_organic", START, END)) as InstagramChannelView;
    // P1+P2+P3+P4 reach = 11000; POLD (Feb 20, reach 500) is excluded from KPIs.
    expect(d.kpis.postReach).toBe(11000);
  });

  test("each ordering is capped at 50 rows", async () => {
    loginAs(memberA);
    const capHotel = await prisma.hotelClient.create({ data: { agencyId: agencyA, name: `${PREFIX}Cap-${Date.now()}`, websiteUrl: "https://h", contactName: "C", contactEmail: "c@t", siteId: `${PREFIX}cap-${Date.now()}`, conversionMethod: "both" } });
    for (let i = 0; i < 60; i++) {
      await post(agencyA, capHotel.id, { mediaId: `cap_${i}`, postedAt: new Date(Date.UTC(2026, 2, 10, 0, i)), reach: i, saves: i });
    }
    const d = (await loadChannelView(capHotel.id, "instagram_organic", START, END)) as InstagramChannelView;
    expect(d.posts!.recent).toHaveLength(50);
    expect(d.posts!.topPerforming.byReach).toHaveLength(50);
  });

  test("only instagram_organic carries posts — other channels do not", async () => {
    loginAs(memberA);
    const meta = (await loadChannelView(hMain, "meta_ads", START, END)) as PaidChannelView;
    expect((meta as Record<string, unknown>).posts).toBeUndefined();
    for (const ch of ["direct", "facebook_organic", "influencer", "other"] as const) {
      const d = (await loadChannelView(hMain, ch, START, END)) as Record<string, unknown>;
      expect(d.posts).toBeUndefined();
    }
  });

  test("isolation: Agency A's view never contains Agency B's posts", async () => {
    loginAs(memberA);
    const d = (await loadChannelView(hMain, "instagram_organic", START, END)) as InstagramChannelView;
    const ids = d.posts!.recent.map((p) => p.id);
    expect(ids).not.toContain("PB");
    // And the endpoint refuses Agency B's hotel outright.
    loginAs(memberA);
    expect((await route(hB, "channel=instagram_organic&startDate=2026-03-01&endDate=2026-03-31")).status).toBe(404);
  });

  test("soft-deleted hotel: posts hidden (endpoint → 404)", async () => {
    loginAs(memberA);
    const res = await route(hDeleted, "channel=instagram_organic&startDate=2026-03-01&endDate=2026-03-31");
    expect(res.status).toBe(404);
  });

  test("endpoint: owned hotel returns the posts payload", async () => {
    loginAs(memberA);
    const body = await (await route(hMain, "channel=instagram_organic&startDate=2026-03-01&endDate=2026-03-31")).json();
    expect(body.channelType).toBe("organic_social");
    expect(body.posts.recent[0].id).toBe("P1");
    expect(typeof body.posts.recent[0].postedAt).toBe("string"); // ISO over JSON
  });
});

// ── Source-level regression guards (no React DOM harness in this suite) ───────
describe("display moved: source guards", () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
  const integrations = read("app/(agency)/agency/(app)/hotel/[id]/integrations/page.tsx");
  const channelView = read("components/dashboard/ChannelView.tsx");

  test("Manage Integrations page no longer renders a posts table", () => {
    expect(integrations).not.toMatch(/Recent posts/);
    expect(integrations).not.toMatch(/recentPosts/);
    expect(integrations).not.toMatch(/postSnapshot/); // display-only fetch removed too
  });

  test("Manage Integrations page still shows connection status & account info", () => {
    expect(integrations).toMatch(/InstagramActions/);   // connect / disconnect / sync controls
    expect(integrations).toMatch(/Followers/);          // account-level stats stay
  });

  test("Instagram Organic channel view renders the content section + toggles", () => {
    expect(channelView).toMatch(/My Instagram Content/);
    expect(channelView).toMatch(/Recent/);
    expect(channelView).toMatch(/Top Performing/);
    expect(channelView).toMatch(/InstagramContent/);
  });

  test("the content section is wired ONLY into the Instagram body", () => {
    const usages = channelView.match(/<InstagramContent\b/g) ?? [];
    expect(usages).toHaveLength(1);
    // It sits inside InstagramBody, not the other channel bodies.
    const igBody = channelView.slice(channelView.indexOf("function InstagramBody"), channelView.indexOf("function InstagramContent"));
    expect(igBody).toMatch(/<InstagramContent/);
  });
});
