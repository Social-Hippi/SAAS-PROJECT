import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Channel-Filtered Dashboard View. Pure channel-key helpers + DB-backed loaders
// and the endpoint: per-channel structure (paid / organic / influencer / direct
// / other), source classification matching R1, empty states, auth, tenant
// isolation, the "all" passthrough, unknown-channel rejection, and the 5-min cache.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ member: null as null | Record<string, unknown>, role: "agency_admin" as string | undefined }));
vi.mock("@/lib/auth", () => ({ getCurrentMember: async () => h.member, getPlatformRole: async () => h.role }));

import { prisma } from "@/lib/prisma";
import {
  loadChannelView, isChannelKey, CHANNEL_KEYS,
  type PaidChannelView, type InstagramChannelView, type InfluencerChannelView,
  type DirectChannelView, type OtherChannelView,
} from "@/lib/channel-view";
import { GET as channelGET } from "@/app/api/agency/hotels/[hotelId]/channel-view/route";

const PREFIX = "TEST_CV_";
const START = new Date(Date.UTC(2026, 2, 1, 0, 0, 0));
const END = new Date(Date.UTC(2026, 2, 31, 23, 59, 59));
const IN = new Date(Date.UTC(2026, 2, 15, 10, 0, 0));
const loginAs = (m: Record<string, unknown> | null) => { h.member = m; };

function route(hotelId: string, query = "") {
  return channelGET(new Request(`http://localhost/api/agency/hotels/${hotelId}/channel-view?${query}`), {
    params: Promise.resolve({ hotelId }),
  });
}

// ── Pure ──
describe("channel keys", () => {
  test("isChannelKey + order", () => {
    expect(isChannelKey("meta_ads")).toBe(true);
    expect(isChannelKey("nope")).toBe(false);
    expect(CHANNEL_KEYS[0]).toBe("all");
    expect(CHANNEL_KEYS).toContain("influencer");
  });
});

// ── DB-backed ──
describe("DB-backed", () => {
  let agencyA: string;
  let hMain: string, hEmpty: string, hB: string;
  // Dedicated hotels for the Google Ads health scenarios, so their tracked rows
  // can't perturb the channel totals the other tests assert on.
  let hGadsUntagged: string, hGadsTagged: string;
  let memberA: Record<string, unknown>, memberB: Record<string, unknown>;

  function conv(a: string, hotel: string, value: number, o: { source?: string; medium?: string; campaign?: string; session?: string; when?: Date } = {}) {
    return prisma.trackingEvent.create({ data: {
      agencyId: a, hotelClientId: hotel, eventType: "conversion", pageUrl: "https://h/thx",
      conversionValue: value.toFixed(2), sessionId: o.session ?? `s_${randomUUID()}`, deviceType: "desktop",
      utmSource: o.source ?? null, utmMedium: o.medium ?? null, utmCampaign: o.campaign ?? null, createdAt: o.when ?? IN,
    } });
  }
  function sess(a: string, hotel: string, id: string, o: { source?: string; medium?: string; landing?: string } = {}) {
    return prisma.session.create({ data: {
      id, visitorId: `v_${randomUUID()}`, hotelClientId: hotel, agencyId: a, startedAt: IN,
      landingPath: o.landing ?? "/", exitPath: "/", pageViewCount: 1, totalTimeMs: 5000,
      utmSource: o.source ?? null, utmMedium: o.medium ?? null,
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
    hEmpty = (await mk(A.id, "Empty")).id;
    hB = (await mk(B.id, "B1")).id;

    // Meta ads: ₹10,000 spend across TWO accounts; campaign "Summer Sale" ₹8,000.
    // Stored ctr/cpc/cpm are deliberately 0 — the loader must RECOMPUTE them from
    // summed numerators/denominators, so a non-zero result proves no averaging.
    const adSnap = (spend: number, date: Date, imp: number, reach: number, clicks: number, account: string, conversions: number) =>
      prisma.adSnapshot.create({ data: {
        agencyId: A.id, hotelClientId: hMain, metaAccountId: account, date, spend: spend.toFixed(2),
        impressions: imp, reach, clicks, conversions,
        ctr: 0, cpc: "0", cpm: "0", roas: 0, pixelPurchases: 0, pixelLeads: 0, pixelPageViews: 0,
      } });
    await adSnap(6000, IN, 60000, 40000, 1200, "act_primary", 15);
    await adSnap(4000, new Date(Date.UTC(2026, 2, 16, 10)), 40000, 30000, 800, "act_secondary", 11);
    // An archived account's row — must be excluded from totals but surfaced.
    await prisma.adSnapshot.create({ data: {
      agencyId: A.id, hotelClientId: hMain, metaAccountId: "act_archived", date: IN, spend: "99999.00",
      impressions: 1, reach: 1, clicks: 1, conversions: 0, ctr: 0, cpc: "0", cpm: "0", roas: 0,
      pixelPurchases: 0, pixelLeads: 0, pixelPageViews: 0, archived: true,
    } });
    await prisma.adCampaignSnapshot.create({ data: { agencyId: A.id, hotelClientId: hMain, metaCampaignId: `c_${randomUUID()}`, campaignName: "Summer Sale", date: IN, spend: "8000.00", impressions: 80000, clicks: 1600, conversions: 0, purchaseValue: "0" } });

    // Conversions across channels.
    await conv(A.id, hMain, 20000, { source: "facebook", medium: "cpc", campaign: "Summer Sale" }); // meta
    await conv(A.id, hMain, 10000, { source: "instagram", medium: "paid", campaign: "Summer Sale" }); // meta
    await conv(A.id, hMain, 5000, { source: "instagram", medium: "social" }); // ig organic
    await conv(A.id, hMain, 3000, { session: "sess_direct" }); // direct
    await conv(A.id, hMain, 1000, { source: "tiktok", medium: "referral" }); // other

    // Sessions across channels.
    await sess(A.id, hMain, `sess_${randomUUID()}`, { source: "facebook", medium: "cpc" }); // meta
    await sess(A.id, hMain, `sess_${randomUUID()}`, { source: "instagram", medium: "social" }); // ig organic
    await sess(A.id, hMain, "sess_direct", { landing: "/rooms" }); // direct (matches the direct conversion)
    await sess(A.id, hMain, `sess_${randomUUID()}`, { source: "tiktok", medium: "referral" }); // other

    // Instagram organic data.
    await prisma.instagramConnection.create({ data: { agencyId: A.id, hotelClientId: hMain, igUserId: "ig1", username: "hotel_ig", encryptedToken: "x", status: "active" } });
    await prisma.socialSnapshot.create({ data: { agencyId: A.id, hotelClientId: hMain, date: IN, followers: 1000, reach: 5000, impressions: 0, views: 8000, profileViews: 300, websiteClicks: 120, engagement: 400 } });
    await prisma.postSnapshot.create({ data: { agencyId: A.id, hotelClientId: hMain, mediaId: "m1", caption: "Sunset suite", mediaType: "image", postedAt: IN, impressions: 4000, reach: 3000, likes: 200, comments: 20, saves: 50, shares: 10 } });

    // Influencer data.
    const inf = await prisma.influencer.create({ data: { agencyId: A.id, hotelClientId: hMain, name: "Priya", instagramHandle: "priya" } });
    const code = await prisma.couponCode.create({ data: { agencyId: A.id, hotelClientId: hMain, influencerId: inf.id, code: "PRIYA10", status: "ACTIVE" } });
    await prisma.influencerRedemption.create({ data: { agencyId: A.id, hotelClientId: hMain, couponCodeId: code.id, influencerId: inf.id, bookingValue: "9000.00", redemptionSource: "snippet_auto", redeemedAt: IN } });
    await prisma.influencerRedemption.create({ data: { agencyId: A.id, hotelClientId: hMain, couponCodeId: code.id, influencerId: inf.id, bookingValue: "6000.00", redemptionSource: "manual_entry", redeemedAt: IN } });

    // ── Google Ads ───────────────────────────────────────────────────────────
    // Two hotels: one whose ads aren't UTM-tagged (auto-tagging/gclid only, so
    // HotelTrack sees no google_ads traffic), one that is tagged correctly.
    hGadsUntagged = (await mk(A.id, "GadsUntagged")).id;
    hGadsTagged = (await mk(A.id, "GadsTagged")).id;
    const gadsConn = (hotel: string) => prisma.googleAdsConnection.create({ data: {
      agencyId: A.id, hotelClientId: hotel, customerId: "1234567890", customerName: "Test Ads",
      accessToken: "x", refreshToken: "y", tokenExpiresAt: new Date(Date.now() + 3600_000),
      scope: "https://www.googleapis.com/auth/adwords", status: "ACTIVE", lastSyncedAt: new Date(),
    } });
    const gadsSnap = (hotel: string, campaign: string, spend: number, clicks: number, conversions: number, value: number) =>
      prisma.googleAdsCampaignSnapshot.create({ data: {
        agencyId: A.id, hotelClientId: hotel, customerId: "1234567890",
        campaignId: `gc_${randomUUID()}`, campaignName: campaign, status: "ENABLED", date: IN,
        spend: spend.toFixed(2), impressions: 50000, clicks, conversions, conversionsValue: value.toFixed(2),
      } });
    await gadsConn(hGadsUntagged);
    // Google reports plenty of clicks + "conversions" (every conversion ACTION),
    // and a unit-less conversion value — none of which are bookings or revenue.
    await gadsSnap(hGadsUntagged, "Brand", 20000, 1240, 546, 537);
    await gadsConn(hGadsTagged);
    await gadsSnap(hGadsTagged, "Brand", 10000, 900, 300, 250);
    // Correctly tagged traffic: utm_source=google + a paid medium.
    await sess(A.id, hGadsTagged, `sess_${randomUUID()}`, { source: "google", medium: "cpc" });
    await conv(A.id, hGadsTagged, 40000, { source: "google", medium: "cpc", campaign: "Brand" });

    // Agency B isolation row.
    await conv(B.id, hB, 99000, { source: "facebook", medium: "cpc", campaign: "Other" });
  });

  afterAll(async () => {
    await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  });

  test("meta_ads: KPIs, campaigns, classification (R1)", async () => {
    loginAs(memberA);
    const d = (await loadChannelView(hMain, "meta_ads", START, END)) as PaidChannelView;
    expect(d.channelType).toBe("paid_ads");
    expect(d.hasData).toBe(true);
    expect(d.kpis!.totalSpend).toBe(10000); // excludes the ₹99,999 archived-account row
    expect(d.kpis!.revenue).toBe(30000); // only the 2 meta/cpc+paid conversions — not ig organic/direct/other
    expect(d.kpis!.bookings).toBe(2);
    expect(d.kpis!.roas).toBeCloseTo(3, 6);
    expect(d.kpis!.impressions).toBe(100000);
    // CTR/CPC/CPM RECOMPUTED from totals (stored values were 0): clicks 2000, imp 100000, spend 10000.
    expect(d.kpis!.ctr).toBeCloseTo(2.0, 6); // 2000/100000*100
    expect(d.kpis!.cpc).toBeCloseTo(5.0, 6); // 10000/2000
    expect(d.kpis!.cpm).toBeCloseTo(100.0, 6); // 10000/100000*1000
    // Meta-reported conversions + cost per conversion (from AdSnapshot.conversions).
    expect(d.kpis!.conversions).toBe(26); // 15 + 11
    expect(d.kpis!.costPerConversion).toBeCloseTo(10000 / 26, 4);
    // Per-account breakdown: two active accounts, the archived one excluded but listed.
    expect(d.accounts!.map((a) => a.accountId).sort()).toEqual(["act_primary", "act_secondary"]);
    expect(d.accounts!.find((a) => a.accountId === "act_primary")!.spend).toBe(6000);
    expect(d.archivedAccountIds).toContain("act_archived");
    expect(d.topCampaigns![0].campaignName).toBe("Summer Sale");
    expect(d.topCampaigns![0].spend).toBe(8000);
    expect(d.topCampaigns![0].revenue).toBe(30000);
    expect(d.trend!.length).toBeGreaterThan(0);
  });

  test("google_ads: not connected", async () => {
    loginAs(memberA);
    const d = (await loadChannelView(hMain, "google_ads", START, END)) as PaidChannelView;
    expect(d.hasData).toBe(false);
    expect(d.integrationStatus).toBe("not_connected");
    expect(d.channelName).toBe("Google Ads");
    // Health explains the absence rather than leaving it unexplained.
    expect(d.health!.layers.linked).toBe("failed");
    expect(d.health!.diagnoses[0].code).toBe("AUTH_NEVER_CONNECTED");
  });

  // Google-reported conversions are NOT bookings, and conversion value is NOT
  // revenue. Displaying them as such is the defect this suite locks down.
  test("google_ads: platform figures never leak into bookings/revenue", async () => {
    loginAs(memberA);
    const d = (await loadChannelView(hGadsUntagged, "google_ads", START, END)) as PaidChannelView;
    expect(d.hasData).toBe(true);
    // Platform half — preserved, clearly labelled.
    expect(d.kpis!.conversions).toBe(546);
    expect(d.kpis!.platformConversionValue).toBe(537);
    expect(d.kpis!.totalSpend).toBe(20000);
    // Tracked half — genuinely zero, because nothing was tagged google_ads.
    expect(d.kpis!.bookings).toBe(0);
    expect(d.kpis!.revenue).toBe(0);
    expect(d.kpis!.roas).toBe(0);
  });

  test("google_ads: untagged account is diagnosed, not silently zeroed", async () => {
    loginAs(memberA);
    const d = (await loadChannelView(hGadsUntagged, "google_ads", START, END)) as PaidChannelView;
    expect(d.health!.layers.linked).toBe("ok");
    expect(d.health!.layers.flowing).toBe("ok");
    expect(d.health!.layers.usable).toBe("failed");
    const diag = d.health!.diagnoses.find((x) => x.code === "ATTRIBUTION_PAID_CLICKS_UNTAGGED")!;
    expect(diag).toBeDefined();
    expect(diag.confidence).toBe("inferred");
    expect(diag.capabilitiesBlocked).toContain("paid.attribution");
    // The invariant: a negative layer always carries its reason.
    expect(d.health!.diagnoses.length).toBeGreaterThan(0);
  });

  test("google_ads: correctly tagged account attributes real bookings", async () => {
    loginAs(memberA);
    const d = (await loadChannelView(hGadsTagged, "google_ads", START, END)) as PaidChannelView;
    expect(d.kpis!.bookings).toBe(1);
    expect(d.kpis!.revenue).toBe(40000);
    expect(d.kpis!.roas).toBeCloseTo(4, 6); // 40000 / 10000
    expect(d.kpis!.costPerBooking).toBeCloseTo(10000, 6);
    // Platform figures still reported alongside, unmixed.
    expect(d.kpis!.conversions).toBe(300);
    expect(d.kpis!.platformConversionValue).toBe(250);
    expect(d.health!.overall).toBe("ok");
    expect(d.health!.diagnoses).toHaveLength(0);
    // Campaign table is built from tracked conversions joined by utm_campaign.
    const brand = d.topCampaigns!.find((c) => c.campaignName === "Brand")!;
    expect(brand.revenue).toBe(40000);
    expect(brand.bookings).toBe(1);
  });

  test("google_ads: tenant isolation", async () => {
    loginAs(memberB);
    const d = (await loadChannelView(hGadsUntagged, "google_ads", START, END)) as PaidChannelView;
    expect(d.hasData).toBe(false);
    expect(d.integrationStatus).toBe("not_connected");
  });

  test("instagram_organic: KPIs + top posts", async () => {
    loginAs(memberA);
    const d = (await loadChannelView(hMain, "instagram_organic", START, END)) as InstagramChannelView;
    expect(d.channelType).toBe("organic_social");
    expect(d.kpis.profileVisits).toBe(300);
    expect(d.kpis.websiteClicks).toBe(120);
    expect(d.kpis.sessionsFromInstagram).toBe(1);
    expect(d.kpis.bookings).toBe(1);
    expect(d.kpis.revenue).toBe(5000);
    expect(d.kpis.postReach).toBe(3000);
    expect(d.topPosts?.[0].caption).toBe("Sunset suite");
    expect(d.topPosts?.[0].bookings).toBeNull();
  });

  test("influencer: KPIs, top influencers, source breakdown", async () => {
    loginAs(memberA);
    const d = (await loadChannelView(hMain, "influencer", START, END)) as InfluencerChannelView;
    expect(d.kpis.totalRedemptions).toBe(2);
    expect(d.kpis.totalRevenue).toBe(15000);
    expect(d.kpis.activeCouponCodes).toBe(1);
    expect(d.redemptionSourceBreakdown).toEqual({ snippetAuto: 1, manualEntry: 1 });
    expect(d.topInfluencers[0].influencerName).toBe("Priya");
    expect(d.topInfluencers[0].revenue).toBe(15000);
    expect(d.topInfluencers[0].redemptionsCount).toBe(2);
  });

  test("direct: sessions, bookings, landing pages", async () => {
    loginAs(memberA);
    const d = (await loadChannelView(hMain, "direct", START, END)) as DirectChannelView;
    expect(d.kpis.sessions).toBe(1);
    expect(d.kpis.bookings).toBe(1);
    expect(d.kpis.revenue).toBe(3000);
    const rooms = d.topLandingPages.find((p) => p.pagePath === "/rooms");
    expect(rooms?.sessions).toBe(1);
    expect(rooms?.bookings).toBe(1); // direct conversion shares sess_direct → /rooms
  });

  test("other: unknown sources", async () => {
    loginAs(memberA);
    const d = (await loadChannelView(hMain, "other", START, END)) as OtherChannelView;
    expect(d.kpis.bookings).toBe(1);
    expect(d.kpis.revenue).toBe(1000);
    const tiktok = d.unknownSources.find((s) => s.utmSource === "tiktok");
    expect(tiktok).toBeTruthy();
    expect(tiktok!.bookings).toBe(1);
  });

  test("empty hotel: clean empty states (no throw)", async () => {
    loginAs(memberA);
    const meta = (await loadChannelView(hEmpty, "meta_ads", START, END)) as PaidChannelView;
    expect(meta.hasData).toBe(false);
    expect(meta.integrationStatus).toBe("not_connected");
    const direct = (await loadChannelView(hEmpty, "direct", START, END)) as DirectChannelView;
    expect(direct.hasData).toBe(false);
    expect(direct.kpis.sessions).toBe(0);
    const inf = (await loadChannelView(hEmpty, "influencer", START, END)) as InfluencerChannelView;
    expect(inf.hasData).toBe(false);
    expect(inf.kpis.totalRedemptions).toBe(0);
  });

  test("'all' returns null", async () => {
    loginAs(memberA);
    expect(await loadChannelView(hMain, "all", START, END)).toBeNull();
  });

  // ── endpoint ──
  const q = "channel=meta_ads&startDate=2026-03-01&endDate=2026-03-31";

  test("endpoint: unauthenticated → 401", async () => {
    loginAs(null);
    expect((await route(hMain, q)).status).toBe(401);
  });

  test("endpoint: another agency's hotel → 404", async () => {
    loginAs(memberB);
    expect((await route(hMain, q)).status).toBe(404);
  });

  test("endpoint: unknown channel → 400", async () => {
    loginAs(memberA);
    expect((await route(hMain, "channel=foo")).status).toBe(400);
  });

  test("endpoint: default/all returns the all marker", async () => {
    loginAs(memberA);
    const res = await route(hMain, "startDate=2026-03-01&endDate=2026-03-31"); // no channel → all
    expect(res.status).toBe(200);
    expect((await res.json()).channel).toBe("all");
  });

  test("endpoint: meta payload for an owned hotel", async () => {
    loginAs(memberA);
    const body = await (await route(hMain, q)).json();
    expect(body.channelType).toBe("paid_ads");
    expect(body.kpis.revenue).toBe(30000);
  });

  test("endpoint: response cached, expires after 5 minutes", async () => {
    loginAs(memberA);
    const cacheHotel = await prisma.hotelClient.create({ data: { agencyId: agencyA, name: `${PREFIX}Cache-${Date.now()}`, websiteUrl: "https://h", contactName: "C", contactEmail: "c@t", siteId: `${PREFIX}cs-${Date.now()}`, conversionMethod: "both" } });
    await conv(agencyA, cacheHotel.id, 2000, { source: "facebook", medium: "cpc", campaign: "C" });
    await prisma.adSnapshot.create({ data: { agencyId: agencyA, hotelClientId: cacheHotel.id, metaAccountId: "act_c", date: IN, spend: "1000.00", impressions: 10, reach: 10, clicks: 5, ctr: 0, cpc: "0", cpm: "0", conversions: 0, roas: 0, pixelPurchases: 0, pixelLeads: 0, pixelPageViews: 0 } });

    const first = await (await route(cacheHotel.id, q)).json();
    expect(first.kpis.bookings).toBe(1);

    await prisma.trackingEvent.deleteMany({ where: { hotelClientId: cacheHotel.id } });
    const cached = await (await route(cacheHotel.id, q)).json();
    expect(cached.kpis.bookings).toBe(1); // served from cache

    const realNow = Date.now;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 6 * 60_000);
    try {
      const fresh = await (await route(cacheHotel.id, q)).json();
      expect(fresh.kpis.bookings).toBe(0); // recomputed
    } finally {
      spy.mockRestore();
    }
  });
});
