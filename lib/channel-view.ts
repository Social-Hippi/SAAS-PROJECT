import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { classifySourceType, type SourceType } from "@/lib/source-classifier";
import { contentPieceIdFromUtmContent } from "@/lib/influencer-attribution";
import type { ClickIds } from "@/lib/click-ids";
import { loadInstagramReachSplit } from "@/lib/instagram-reach-split";
import {
  CHANNEL_KEYS, isChannelKey, type ChannelKey, type PaidKpis,
  type PaidChannelView, type InstagramChannelView, type InstagramPostItem,
  type FacebookChannelView,
  type InfluencerChannelView, type DirectChannelView, type OtherChannelView,
  type ChannelView,
} from "@/lib/channel-view-types";

// Re-export the client-safe surface so existing importers of "@/lib/channel-view"
// (the route, the tests) keep working unchanged.
export {
  CHANNEL_KEYS, isChannelKey, type ChannelKey, type PaidKpis,
  type PaidChannelView, type InstagramChannelView, type FacebookChannelView,
  type InfluencerChannelView, type DirectChannelView, type OtherChannelView,
  type ChannelView,
};

// ─────────────────────────────────────────────────────────────────────────────
// Channel-Filtered Dashboard View — per-channel deep-dive data. READ-ONLY over
// data already in the DB (TrackingEvent / Session / PageView / AdSnapshot /
// AdCampaignSnapshot / SocialSnapshot / PostSnapshot / InfluencerRedemption).
// No schema changes.
//
// Channel ↔ source-classifier mapping (PART 3.5): every conversion/session is
// folded with classifySourceType (R1), then mapped to a channel bucket. The six
// named channels map 1:1; email/whatsapp/other all fold into "other". Influencer
// revenue comes from the authoritative InfluencerRedemption table (R2).
//
// Money is plain `number` (rupees) like the rest of the codebase (owner-metrics,
// savings, attribution all Number() the Decimals immediately).
// ─────────────────────────────────────────────────────────────────────────────

const num = (d: { toString(): string } | null | undefined): number => (d == null ? 0 : Number(d));

/** Fold a source-classifier type into the channel bucket it belongs to. */
function channelOfType(type: SourceType): Exclude<ChannelKey, "all"> {
  switch (type) {
    case "meta_ads":
    case "google_ads":
    case "instagram_organic":
    case "facebook_organic":
    case "influencer":
    case "direct":
      return type;
    default: // email | whatsapp | other → "other"
      return "other";
  }
}

/** Inclusive list of UTC day keys (YYYY-MM-DD) spanning [start, end]. */
function dayKeys(start: Date, end: Date): string[] {
  const keys: string[] = [];
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  // Cap at 366 days so a huge custom range can't blow up the payload.
  let guard = 0;
  while (d <= last && guard < 367) {
    keys.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
    guard += 1;
  }
  return keys;
}
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

// ── Shared row selects ───────────────────────────────────────────────────────

type ConvRow = Required<ClickIds> & {
  utmSource: string | null;
  utmMedium: string | null;
  utmContent: string | null;
  utmCampaign: string | null;
  conversionValue: { toString(): string } | null;
  sessionId: string;
  createdAt: Date;
};
type SessionRow = Required<ClickIds> & {
  id: string;
  landingPath: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmContent: string | null;
  startedAt: Date;
};

function conversionsInRange(hotelClientId: string, start: Date, end: Date) {
  return agencyScoped(prisma.trackingEvent).findMany({
    where: { hotelClientId, eventType: "conversion", createdAt: { gte: start, lte: end } },
    select: {
      utmSource: true, utmMedium: true, utmContent: true, utmCampaign: true,
      // Phase 1A: click ids so a stored auto-tagged Google conversion classifies
      // as google_ads here exactly as it does live.
      gclid: true, gbraid: true, wbraid: true, fbclid: true,
      conversionValue: true, sessionId: true, createdAt: true,
    },
  }) as Promise<ConvRow[]>;
}
function sessionsInRange(hotelClientId: string, start: Date, end: Date) {
  return agencyScoped(prisma.session).findMany({
    where: { hotelClientId, startedAt: { gte: start, lte: end } },
    select: {
      id: true, landingPath: true, utmSource: true, utmMedium: true, utmContent: true, startedAt: true,
      // Required by classifySourceType: without these an auto-tagged Google
      // session (gclid, no utm) is misread as `direct` in every channel card.
      gclid: true, gbraid: true, wbraid: true, fbclid: true,
    },
  }) as Promise<SessionRow[]>;
}

// Channel payload types live in lib/channel-view-types.ts (client-safe) and are
// re-exported above. The loaders below build them.

// ── Per-channel loaders ──────────────────────────────────────────────────────

async function loadMetaAds(hotelClientId: string, start: Date, end: Date): Promise<PaidChannelView> {
  const [snaps, campSnaps, conversions, snapCount, archivedAccts] = await Promise.all([
    // Include ALL non-archived AdSnapshot rows (across every ad account) for the
    // hotel in the window. CTR/CPC/CPM are NOT read from the rows — they're
    // recomputed from summed numerators/denominators below (see Part 2).
    agencyScoped(prisma.adSnapshot).findMany({
      where: { hotelClientId, archived: false, date: { gte: start, lte: end } },
      select: { date: true, metaAccountId: true, spend: true, impressions: true, reach: true, clicks: true, conversions: true },
    }),
    agencyScoped(prisma.adCampaignSnapshot).findMany({
      where: { hotelClientId, archived: false, date: { gte: start, lte: end } },
      select: { campaignName: true, spend: true, impressions: true, clicks: true },
    }),
    conversionsInRange(hotelClientId, start, end),
    agencyScoped(prisma.adSnapshot).count({ where: { hotelClientId, archived: false } }),
    // Archived ad accounts (excluded from totals) — surfaced so the UI can note them.
    agencyScoped(prisma.adSnapshot).findMany({
      where: { hotelClientId, archived: true },
      select: { metaAccountId: true },
      distinct: ["metaAccountId"],
    }),
  ]);

  const metaConv = conversions.filter((c) => classifySourceType(c) === "meta_ads");
  // Sum the raw numerators/denominators across all rows + accounts.
  let totalSpend = 0, impressions = 0, reach = 0, linkClicks = 0, metaConversions = 0;
  const acctAgg = new Map<string, { accountId: string; spend: number; impressions: number; clicks: number }>();
  for (const s of snaps) {
    totalSpend += num(s.spend); impressions += s.impressions; reach += s.reach;
    linkClicks += s.clicks; metaConversions += s.conversions;
    const a = acctAgg.get(s.metaAccountId) ?? { accountId: s.metaAccountId, spend: 0, impressions: 0, clicks: 0 };
    a.spend += num(s.spend); a.impressions += s.impressions; a.clicks += s.clicks;
    acctAgg.set(s.metaAccountId, a);
  }
  const revenue = metaConv.reduce((sum, c) => sum + num(c.conversionValue), 0);
  const bookings = metaConv.length;

  // No Meta data ever for this hotel → treat as not connected.
  if (snapCount === 0) {
    return { channelType: "paid_ads", channelName: "Meta Ads", hasData: false, integrationStatus: "not_connected" };
  }

  // CTR/CPC/CPM/ROAS are recomputed from the totals — NEVER averaged across rows.
  const kpis: PaidKpis = {
    totalSpend, impressions, reach,
    frequency: reach > 0 ? impressions / reach : 0,
    cpc: linkClicks > 0 ? totalSpend / linkClicks : 0,
    cpm: impressions > 0 ? (totalSpend / impressions) * 1000 : 0,
    ctr: impressions > 0 ? (linkClicks / impressions) * 100 : 0,
    linkClicks,
    conversions: metaConversions,
    costPerConversion: metaConversions > 0 ? totalSpend / metaConversions : null,
    bookings, revenue,
    roas: totalSpend > 0 ? revenue / totalSpend : null,
    costPerBooking: bookings > 0 ? totalSpend / bookings : null,
    conversionRate: linkClicks > 0 ? (bookings / linkClicks) * 100 : null,
  };

  // Per-account spend breakdown (active accounts) + the archived ones we excluded.
  const accounts = [...acctAgg.values()].sort((a, b) => b.spend - a.spend);
  const activeIds = new Set(accounts.map((a) => a.accountId));
  const archivedAccountIds = archivedAccts.map((r) => r.metaAccountId).filter((id) => !activeIds.has(id));

  // Revenue/bookings per campaign (from conversions, by utmCampaign) joined to
  // per-campaign spend/impressions/clicks (AdCampaignSnapshot, case-insensitive name).
  const convByCampaign = new Map<string, { revenue: number; bookings: number }>();
  for (const c of metaConv) {
    const name = (c.utmCampaign ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const row = convByCampaign.get(key) ?? { revenue: 0, bookings: 0 };
    row.revenue += num(c.conversionValue); row.bookings += 1;
    convByCampaign.set(key, row);
  }
  const campAgg = new Map<string, { campaignName: string; spend: number; impressions: number; clicks: number }>();
  for (const s of campSnaps) {
    const name = s.campaignName.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const row = campAgg.get(key) ?? { campaignName: name, spend: 0, impressions: 0, clicks: 0 };
    row.spend += num(s.spend); row.impressions += s.impressions; row.clicks += s.clicks;
    campAgg.set(key, row);
  }
  const campaignKeys = new Set([...campAgg.keys(), ...convByCampaign.keys()]);
  const topCampaigns = [...campaignKeys]
    .map((key) => {
      const a = campAgg.get(key);
      const cv = convByCampaign.get(key) ?? { revenue: 0, bookings: 0 };
      const spend = a?.spend ?? 0;
      return {
        campaignName: a?.campaignName ?? key,
        spend, revenue: cv.revenue, bookings: cv.bookings,
        roas: spend > 0 ? cv.revenue / spend : null,
        ctr: a && a.impressions > 0 ? (a.clicks / a.impressions) * 100 : 0,
      };
    })
    .sort((x, y) => y.revenue - x.revenue || y.spend - x.spend)
    .slice(0, 5);

  // Daily trend: spend (snapshots) + revenue/bookings (conversions).
  const spendByDay = new Map<string, number>();
  for (const s of snaps) spendByDay.set(dayKey(s.date), (spendByDay.get(dayKey(s.date)) ?? 0) + num(s.spend));
  const revByDay = new Map<string, { revenue: number; bookings: number }>();
  for (const c of metaConv) {
    const k = dayKey(c.createdAt);
    const row = revByDay.get(k) ?? { revenue: 0, bookings: 0 };
    row.revenue += num(c.conversionValue); row.bookings += 1;
    revByDay.set(k, row);
  }
  const trend = dayKeys(start, end).map((date) => ({
    date,
    spend: spendByDay.get(date) ?? 0,
    revenue: revByDay.get(date)?.revenue ?? 0,
    bookings: revByDay.get(date)?.bookings ?? 0,
  }));

  return {
    channelType: "paid_ads", channelName: "Meta Ads",
    hasData: snaps.length > 0 || bookings > 0,
    kpis, accounts, archivedAccountIds, topCampaigns, topCreatives: null, trend,
  };
}

async function loadGoogleAds(hotelClientId: string, start: Date, end: Date): Promise<PaidChannelView> {
  // `trackedConversions` (HotelTrack TrackingEvents) is deliberately NOT called
  // `conversions` — that name is taken below by the GOOGLE-reported conversion
  // count, and keeping the two visibly distinct is the whole point of this step.
  const [conn, campSnaps, trackedConversions] = await Promise.all([
    agencyScoped(prisma.googleAdsConnection).findFirst({
      where: { hotelClientId },
      select: { customerId: true },
    }),
    agencyScoped(prisma.googleAdsCampaignSnapshot).findMany({
      where: { hotelClientId, date: { gte: start, lte: end } },
      select: {
        customerId: true, campaignId: true, campaignName: true, date: true,
        spend: true, impressions: true, clicks: true, conversions: true, conversionsValue: true,
      },
    }),
    // Phase 0: HotelTrack-tracked bookings for this channel, the same way the
    // Meta loader does it. Previously this loader read no TrackingEvent at all.
    conversionsInRange(hotelClientId, start, end),
  ]);

  // No connection at all → "not connected". A connection with no rows in-range is
  // CONNECTED but empty (the UI shows "no active campaigns", not a connect CTA).
  if (!conn || conn.customerId === "") {
    return { channelType: "paid_ads", channelName: "Google Ads", hasData: false, integrationStatus: "not_connected" };
  }
  if (campSnaps.length === 0) {
    return { channelType: "paid_ads", channelName: "Google Ads", hasData: false };
  }

  // Sum raw numerators/denominators; CTR/CPC/CPM/ROAS recomputed from totals
  // (never averaged across rows), exactly like the Meta loader. Money, conversions,
  // and value are all Ads-REPORTED (from the account's own conversion tracking).
  let totalSpend = 0, impressions = 0, clicks = 0, conversions = 0, revenue = 0;
  const acctAgg = new Map<string, { accountId: string; spend: number; impressions: number; clicks: number }>();
  const campAgg = new Map<string, { campaignName: string; spend: number; impressions: number; clicks: number; conversions: number; revenue: number }>();
  const byDay = new Map<string, { spend: number; revenue: number; bookings: number }>();

  for (const s of campSnaps) {
    const spend = num(s.spend);
    const value = num(s.conversionsValue);
    totalSpend += spend; impressions += s.impressions; clicks += s.clicks;
    conversions += s.conversions; revenue += value;

    const a = acctAgg.get(s.customerId) ?? { accountId: s.customerId, spend: 0, impressions: 0, clicks: 0 };
    a.spend += spend; a.impressions += s.impressions; a.clicks += s.clicks;
    acctAgg.set(s.customerId, a);

    const key = s.campaignName.trim().toLowerCase() || s.campaignId;
    const c = campAgg.get(key) ?? { campaignName: s.campaignName.trim() || s.campaignId, spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 };
    c.spend += spend; c.impressions += s.impressions; c.clicks += s.clicks; c.conversions += s.conversions; c.revenue += value;
    campAgg.set(key, c);

    const dk = dayKey(s.date);
    const d = byDay.get(dk) ?? { spend: 0, revenue: 0, bookings: 0 };
    d.spend += spend; d.revenue += value; d.bookings += s.conversions;
    byDay.set(dk, d);
  }

  // ── HotelTrack-TRACKED Google bookings (Phase 0) ─────────────────────────
  // Same rule the Meta loader uses, applied to the google_ads bucket. UTM-based
  // today; GCLID-based matching lands in Phase 1.
  const googleConv = trackedConversions.filter((c) => classifySourceType(c) === "google_ads");
  const trackedRevenue = googleConv.reduce((sum, c) => sum + num(c.conversionValue), 0);
  const trackedBookings = googleConv.length;

  const kpis: PaidKpis = {
    totalSpend, impressions,
    reach: 0, frequency: 0, // Google Ads reports no de-duplicated reach
    cpc: clicks > 0 ? totalSpend / clicks : 0,
    cpm: impressions > 0 ? (totalSpend / impressions) * 1000 : 0,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    linkClicks: clicks,
    conversions: Math.round(conversions),
    costPerConversion: conversions > 0 ? totalSpend / conversions : null,

    // `bookings` / `revenue` / `roas` are the SHARED fields the UI renders for
    // every paid channel — they now mean the same thing here as they do for
    // Meta: HotelTrack-tracked. Google's own numbers moved to platformReported*.
    bookings: trackedBookings,
    revenue: trackedRevenue,
    roas: totalSpend > 0 ? trackedRevenue / totalSpend : null,
    costPerBooking: trackedBookings > 0 ? totalSpend / trackedBookings : null,
    conversionRate: clicks > 0 ? (trackedBookings / clicks) * 100 : null,

    // Google's OWN conversion tracking — unchanged numbers, explicit names.
    platformReportedConversions: Math.round(conversions),
    platformReportedRevenue: revenue,
    platformReportedRoas: totalSpend > 0 ? revenue / totalSpend : null,
    trackedBookings,
    trackedRevenue,
    trackedRoas: totalSpend > 0 ? trackedRevenue / totalSpend : null,
  };

  const accounts = [...acctAgg.values()].sort((a, b) => b.spend - a.spend);
  const topCampaigns = [...campAgg.values()]
    .map((c) => ({
      campaignName: c.campaignName,
      spend: c.spend,
      revenue: c.revenue,
      bookings: Math.round(c.conversions),
      roas: c.spend > 0 ? c.revenue / c.spend : null,
      ctr: c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0,
    }))
    .sort((x, y) => y.revenue - x.revenue || y.spend - x.spend)
    .slice(0, 5);

  const trend = dayKeys(start, end).map((date) => ({
    date,
    spend: byDay.get(date)?.spend ?? 0,
    revenue: byDay.get(date)?.revenue ?? 0,
    bookings: Math.round(byDay.get(date)?.bookings ?? 0),
  }));

  return {
    channelType: "paid_ads", channelName: "Google Ads",
    hasData: true,
    kpis, accounts, topCampaigns, topCreatives: null, trend,
  };
}

async function loadInstagram(hotelClientId: string, start: Date, end: Date): Promise<InstagramChannelView> {
  const [social, posts, allPosts, conversions, sessions, connection, reachSplit] = await Promise.all([
    agencyScoped(prisma.socialSnapshot).findMany({
      where: { hotelClientId, date: { gte: start, lte: end } },
      select: { profileViews: true, websiteClicks: true, reach: true },
    }),
    // Date-ranged posts drive the "this period" KPIs (reach, engagement, etc.).
    agencyScoped(prisma.postSnapshot).findMany({
      where: { hotelClientId, postedAt: { gte: start, lte: end } },
      orderBy: { reach: "desc" },
      select: { mediaId: true, caption: true, reach: true, impressions: true, likes: true, comments: true, saves: true, shares: true },
    }),
    // The "My Instagram Content" table shows the hotel's synced posts regardless
    // of the dashboard window — agencies sync posts that are often older than the
    // selected range, and they still want to browse all of them here. Newest
    // first, capped at 50.
    agencyScoped(prisma.postSnapshot).findMany({
      where: { hotelClientId },
      orderBy: { postedAt: "desc" },
      take: 50,
      select: { mediaId: true, caption: true, mediaType: true, permalink: true, postedAt: true, reach: true, impressions: true, likes: true, comments: true, saves: true, shares: true },
    }),
    conversionsInRange(hotelClientId, start, end),
    sessionsInRange(hotelClientId, start, end),
    agencyScoped(prisma.instagramConnection).findFirst({ where: { hotelClientId }, select: { id: true } }),
    loadInstagramReachSplit(hotelClientId, start, end),
  ]);

  const igConv = conversions.filter((c) => classifySourceType(c) === "instagram_organic");
  const igSessions = sessions.filter((s) => classifySourceType(s) === "instagram_organic");
  const profileVisits = social.reduce((n, s) => n + s.profileViews, 0);
  const websiteClicks = social.reduce((n, s) => n + s.websiteClicks, 0);
  let postReach = 0, postImpressions = 0, likes = 0, comments = 0, saves = 0, shares = 0;
  for (const p of posts) {
    postReach += p.reach; postImpressions += p.impressions; likes += p.likes;
    comments += p.comments; saves += p.saves; shares += p.shares;
  }
  const interactions = likes + comments + saves + shares;
  const revenue = igConv.reduce((sum, c) => sum + num(c.conversionValue), 0);
  const bookings = igConv.length;

  const sessByDay = new Map<string, number>();
  for (const s of igSessions) sessByDay.set(dayKey(s.startedAt), (sessByDay.get(dayKey(s.startedAt)) ?? 0) + 1);
  const revByDay = new Map<string, { revenue: number; bookings: number }>();
  for (const c of igConv) {
    const k = dayKey(c.createdAt);
    const row = revByDay.get(k) ?? { revenue: 0, bookings: 0 };
    row.revenue += num(c.conversionValue); row.bookings += 1;
    revByDay.set(k, row);
  }
  const trend = dayKeys(start, end).map((date) => ({
    date, sessions: sessByDay.get(date) ?? 0,
    bookings: revByDay.get(date)?.bookings ?? 0, revenue: revByDay.get(date)?.revenue ?? 0,
  }));

  // Post-level booking attribution isn't available; surface reach/saves so the
  // table is still useful (bookings/revenue null per spec).
  const topPosts = posts.length > 0
    ? posts.slice(0, 5).map((p) => ({
        postId: p.mediaId,
        caption: (p.caption ?? "").trim().slice(0, 100),
        reach: p.reach, saves: p.saves, websiteClicks: 0,
        bookings: null, revenue: null,
      }))
    : null;

  // "My Instagram Content" table rows — built from allPosts (NOT date-filtered,
  // already newest-first & capped at 50 by the query). Map each PostSnapshot to a
  // client-shaped item, then expose four orderings (recent + three top sorts).
  const items: InstagramPostItem[] = allPosts.map(toPostItem);
  const cap = 50;
  const byReach = [...items].sort((a, b) => b.reach - a.reach).slice(0, cap);
  const byEngagement = [...items].sort((a, b) => b.engagementRate - a.engagementRate).slice(0, cap);
  const bySaves = [...items].sort((a, b) => b.saves - a.saves).slice(0, cap);
  const recent = [...items]
    .sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())
    .slice(0, cap);
  const postsPayload = items.length > 0
    ? { recent, topPerforming: { byReach, byEngagement, bySaves } }
    : null;

  return {
    channelType: "organic_social", channelName: "Instagram Organic",
    hasData: social.length > 0 || posts.length > 0 || allPosts.length > 0 || igSessions.length > 0
      || connection != null || reachSplit.influencerContent.postCount > 0 || reachSplit.unattributed.count > 0,
    kpis: {
      profileVisits, postReach, postImpressions,
      engagementRate: postReach > 0 ? (interactions / postReach) * 100 : 0,
      likes, comments, saves, shares, websiteClicks,
      sessionsFromInstagram: igSessions.length, bookings, revenue,
    },
    reachSplit,
    topPosts, posts: postsPayload, trend,
  };
}

// Maps a synced PostSnapshot to a client-facing content row. mediaType from the
// Graph API is "image" | "video" | "carousel" | "reels"; we normalise to the
// badge vocabulary the table uses. engagementRate is computed here (reach == 0
// → 0) so the client never divides.
function toPostItem(p: {
  mediaId: string; caption: string | null; mediaType: string | null; permalink: string | null;
  postedAt: Date | null; reach: number; impressions: number; likes: number; comments: number;
  saves: number; shares: number;
}): InstagramPostItem {
  const caption = (p.caption ?? "").trim();
  const interactions = p.likes + p.comments + p.saves + p.shares;
  return {
    id: p.mediaId,
    postType: normalizePostType(p.mediaType),
    caption,
    captionPreview: caption.length > 80 ? `${caption.slice(0, 80)}…` : caption,
    permalink: p.permalink ?? null,
    reach: p.reach,
    impressions: p.impressions,
    likes: p.likes,
    comments: p.comments,
    saves: p.saves,
    shares: p.shares,
    engagementRate: p.reach > 0 ? (interactions / p.reach) * 100 : 0,
    postedAt: (p.postedAt ?? new Date(0)).toISOString(),
  };
}

function normalizePostType(mediaType: string | null): InstagramPostItem["postType"] {
  switch ((mediaType ?? "").toLowerCase()) {
    case "reels":
    case "reel":
    case "video":
      return "reel";
    case "carousel":
    case "carousel_album":
      return "carousel";
    case "story":
      return "story";
    default:
      return "image";
  }
}

async function loadFacebook(hotelClientId: string, start: Date, end: Date): Promise<FacebookChannelView> {
  const [conversions, sessions] = await Promise.all([
    conversionsInRange(hotelClientId, start, end),
    sessionsInRange(hotelClientId, start, end),
  ]);
  const fbConv = conversions.filter((c) => classifySourceType(c) === "facebook_organic");
  const fbSessions = sessions.filter((s) => classifySourceType(s) === "facebook_organic");
  const revenue = fbConv.reduce((sum, c) => sum + num(c.conversionValue), 0);
  const bookings = fbConv.length;

  const sessByDay = new Map<string, number>();
  for (const s of fbSessions) sessByDay.set(dayKey(s.startedAt), (sessByDay.get(dayKey(s.startedAt)) ?? 0) + 1);
  const revByDay = new Map<string, { revenue: number; bookings: number }>();
  for (const c of fbConv) {
    const k = dayKey(c.createdAt);
    const row = revByDay.get(k) ?? { revenue: 0, bookings: 0 };
    row.revenue += num(c.conversionValue); row.bookings += 1;
    revByDay.set(k, row);
  }
  const trend = dayKeys(start, end).map((date) => ({
    date, sessions: sessByDay.get(date) ?? 0,
    bookings: revByDay.get(date)?.bookings ?? 0, revenue: revByDay.get(date)?.revenue ?? 0,
  }));

  // Facebook Page metrics (visits/follows/reach) aren't synced — those KPIs are 0.
  return {
    channelType: "organic_social", channelName: "Facebook Organic",
    hasData: fbSessions.length > 0 || bookings > 0,
    kpis: { pageVisits: 0, pageFollows: 0, postReach: 0, websiteClicks: 0, sessionsFromFacebook: fbSessions.length, bookings, revenue },
    trend,
  };
}

async function loadInfluencer(hotelClientId: string, start: Date, end: Date): Promise<InfluencerChannelView> {
  const [redemptions, activeCodes, influencers, linkPieces, linkConversions] = await Promise.all([
    agencyScoped(prisma.influencerRedemption).findMany({
      where: { hotelClientId, redeemedAt: { gte: start, lte: end } },
      select: { influencerId: true, bookingValue: true, redemptionSource: true, redeemedAt: true, trackingEventId: true },
    }),
    agencyScoped(prisma.couponCode).count({ where: { hotelClientId, status: "ACTIVE" } }),
    agencyScoped(prisma.influencer).findMany({
      where: { OR: [{ hotelClientId }, { hotelClientId: null }], archivedAt: null },
      select: { id: true, name: true, instagramHandle: true, couponCodes: { where: { hotelClientId, status: "ACTIVE" }, select: { id: true } } },
    }),
    // Track A, link route: the ContentPieces of this hotel that point at a real
    // Influencer. utm_content carries `ht-<contentPieceId>`, so this map turns a
    // stored conversion back into an influencer by FOREIGN KEY — never by name.
    agencyScoped(prisma.contentPiece).findMany({
      where: { hotelClientId, influencerId: { not: null } },
      select: { id: true, influencerId: true },
    }),
    agencyScoped(prisma.trackingEvent).findMany({
      where: { hotelClientId, eventType: "conversion", createdAt: { gte: start, lte: end } },
      select: { id: true, utmContent: true, conversionValue: true, createdAt: true },
    }),
  ]);

  const infMeta = new Map(influencers.map((i) => [i.id, { name: i.name, handle: i.instagramHandle ?? "", codes: i.couponCodes.length }]));
  const byInfluencer = new Map<string, { revenue: number; redemptions: number }>();
  let totalRevenue = 0;
  let snippetAuto = 0, manualEntry = 0;
  for (const r of redemptions) {
    const v = num(r.bookingValue);
    totalRevenue += v;
    const row = byInfluencer.get(r.influencerId) ?? { revenue: 0, redemptions: 0 };
    row.revenue += v; row.redemptions += 1;
    byInfluencer.set(r.influencerId, row);
    if (r.redemptionSource === "manual_entry") manualEntry += 1;
    else snippetAuto += 1;
  }

  // ── Link route ───────────────────────────────────────────────────────────
  // A conversion that already produced a redemption is the SAME booking, so it
  // is excluded here rather than added on top. What remains is the revenue an
  // influencer drove through their link where no coupon was used — invisible in
  // this report before Track A.
  const pieceToInfluencer = new Map(
    linkPieces.flatMap((p) => (p.influencerId ? [[p.id, p.influencerId] as const] : [])),
  );
  const redeemedEventIds = new Set(
    redemptions.flatMap((r) => (r.trackingEventId ? [r.trackingEventId] : [])),
  );
  const byInfluencerLink = new Map<string, { revenue: number; bookings: number }>();
  const linkByDay = new Map<string, number>();
  let linkAttributedBookings = 0;
  let linkAttributedRevenue = 0;
  for (const c of linkConversions) {
    if (redeemedEventIds.has(c.id)) continue; // already counted as a redemption
    const pieceId = contentPieceIdFromUtmContent(c.utmContent);
    const influencerId = pieceId ? pieceToInfluencer.get(pieceId) : undefined;
    if (!influencerId) continue;
    const v = num(c.conversionValue);
    const row = byInfluencerLink.get(influencerId) ?? { revenue: 0, bookings: 0 };
    row.revenue += v; row.bookings += 1;
    byInfluencerLink.set(influencerId, row);
    linkAttributedBookings += 1;
    linkAttributedRevenue += v;
    linkByDay.set(dayKey(c.createdAt), (linkByDay.get(dayKey(c.createdAt)) ?? 0) + v);
  }

  const allInfluencerIds = new Set([...byInfluencer.keys(), ...byInfluencerLink.keys()]);
  const topInfluencers = [...allInfluencerIds]
    .map((id) => {
      const agg = byInfluencer.get(id) ?? { revenue: 0, redemptions: 0 };
      const link = byInfluencerLink.get(id) ?? { revenue: 0, bookings: 0 };
      const meta = infMeta.get(id);
      return {
        influencerName: meta?.name ?? "(removed influencer)",
        instagramHandle: meta?.handle ?? "",
        activeCodesCount: meta?.codes ?? 0,
        redemptionsCount: agg.redemptions,
        revenue: agg.revenue,
        avgBookingValue: agg.redemptions > 0 ? agg.revenue / agg.redemptions : 0,
        linkBookings: link.bookings,
        linkRevenue: link.revenue,
        attributedRevenue: agg.revenue + link.revenue,
      };
    })
    .sort((a, b) => b.attributedRevenue - a.attributedRevenue);

  const byDay = new Map<string, { redemptions: number; revenue: number }>();
  for (const r of redemptions) {
    const k = dayKey(r.redeemedAt);
    const row = byDay.get(k) ?? { redemptions: 0, revenue: 0 };
    row.redemptions += 1; row.revenue += num(r.bookingValue);
    byDay.set(k, row);
  }
  const trend = dayKeys(start, end).map((date) => ({
    date,
    redemptions: byDay.get(date)?.redemptions ?? 0,
    // The trend line is the influencer's full attributable revenue: coupon
    // redemptions plus link-only bookings, which are disjoint by construction.
    revenue: (byDay.get(date)?.revenue ?? 0) + (linkByDay.get(date) ?? 0),
  }));

  // "Active" now means activity by EITHER route, so an influencer who drove
  // bookings through their link but had no code redeemed is no longer invisible.
  const activeInfluencers = allInfluencerIds.size;
  const attributableRevenue = totalRevenue + linkAttributedRevenue;
  return {
    channelType: "influencer", channelName: "Influencer",
    hasData: redemptions.length > 0 || influencers.length > 0 || linkAttributedBookings > 0,
    kpis: {
      activeInfluencers, activeCouponCodes: activeCodes,
      totalRedemptions: redemptions.length, totalRevenue,
      averageRevenuePerInfluencer: activeInfluencers > 0 ? attributableRevenue / activeInfluencers : 0,
      linkAttributedBookings, linkAttributedRevenue,
    },
    topInfluencers,
    redemptionSourceBreakdown: { snippetAuto, manualEntry },
    trend,
  };
}

async function loadDirect(hotelClientId: string, start: Date, end: Date): Promise<DirectChannelView> {
  const [conversions, sessions] = await Promise.all([
    conversionsInRange(hotelClientId, start, end),
    sessionsInRange(hotelClientId, start, end),
  ]);
  const directSessions = sessions.filter((s) => classifySourceType(s) === "direct");
  const directConv = conversions.filter((c) => classifySourceType(c) === "direct");
  const revenue = directConv.reduce((sum, c) => sum + num(c.conversionValue), 0);
  const bookings = directConv.length;

  // Landing pages of direct sessions; bookings per page via session→landingPath join.
  const landingBySession = new Map(directSessions.map((s) => [s.id, s.landingPath]));
  const pageAgg = new Map<string, { sessions: number; bookings: number }>();
  for (const s of directSessions) {
    const row = pageAgg.get(s.landingPath) ?? { sessions: 0, bookings: 0 };
    row.sessions += 1; pageAgg.set(s.landingPath, row);
  }
  for (const c of directConv) {
    const path = landingBySession.get(c.sessionId);
    if (path == null) continue;
    const row = pageAgg.get(path);
    if (row) row.bookings += 1;
  }
  const topLandingPages = [...pageAgg.entries()]
    .map(([pagePath, v]) => ({ pagePath, sessions: v.sessions, bookings: v.bookings }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 5);

  const sessByDay = new Map<string, number>();
  for (const s of directSessions) sessByDay.set(dayKey(s.startedAt), (sessByDay.get(dayKey(s.startedAt)) ?? 0) + 1);
  const revByDay = new Map<string, { revenue: number; bookings: number }>();
  for (const c of directConv) {
    const k = dayKey(c.createdAt);
    const row = revByDay.get(k) ?? { revenue: 0, bookings: 0 };
    row.revenue += num(c.conversionValue); row.bookings += 1;
    revByDay.set(k, row);
  }
  const trend = dayKeys(start, end).map((date) => ({
    date, sessions: sessByDay.get(date) ?? 0,
    bookings: revByDay.get(date)?.bookings ?? 0, revenue: revByDay.get(date)?.revenue ?? 0,
  }));

  return {
    channelType: "direct", channelName: "Direct",
    hasData: directSessions.length > 0 || bookings > 0,
    kpis: {
      sessions: directSessions.length, bookings, revenue,
      avgBookingValue: bookings > 0 ? revenue / bookings : 0,
      conversionRate: directSessions.length > 0 ? (bookings / directSessions.length) * 100 : null,
    },
    topLandingPages, trend,
  };
}

async function loadOther(hotelClientId: string, start: Date, end: Date): Promise<OtherChannelView> {
  const [conversions, sessions] = await Promise.all([
    conversionsInRange(hotelClientId, start, end),
    sessionsInRange(hotelClientId, start, end),
  ]);
  const otherSessions = sessions.filter((s) => channelOfType(classifySourceType(s)) === "other");
  const otherConv = conversions.filter((c) => channelOfType(classifySourceType(c)) === "other");
  const revenue = otherConv.reduce((sum, c) => sum + num(c.conversionValue), 0);
  const bookings = otherConv.length;

  // Group the unmatched UTM combinations so the agency can investigate them.
  const key = (s: string | null, m: string | null) => `${(s ?? "(none)").toLowerCase()}|${(m ?? "(none)").toLowerCase()}`;
  const combos = new Map<string, { utmSource: string; utmMedium: string; sessions: number; bookings: number; revenue: number }>();
  for (const s of otherSessions) {
    const k = key(s.utmSource, s.utmMedium);
    const row = combos.get(k) ?? { utmSource: s.utmSource ?? "(none)", utmMedium: s.utmMedium ?? "(none)", sessions: 0, bookings: 0, revenue: 0 };
    row.sessions += 1; combos.set(k, row);
  }
  for (const c of otherConv) {
    const k = key(c.utmSource, c.utmMedium);
    const row = combos.get(k) ?? { utmSource: c.utmSource ?? "(none)", utmMedium: c.utmMedium ?? "(none)", sessions: 0, bookings: 0, revenue: 0 };
    row.bookings += 1; row.revenue += num(c.conversionValue); combos.set(k, row);
  }
  const unknownSources = [...combos.values()].sort((a, b) => b.revenue - a.revenue || b.sessions - a.sessions).slice(0, 20);

  const sessByDay = new Map<string, number>();
  for (const s of otherSessions) sessByDay.set(dayKey(s.startedAt), (sessByDay.get(dayKey(s.startedAt)) ?? 0) + 1);
  const revByDay = new Map<string, { revenue: number; bookings: number }>();
  for (const c of otherConv) {
    const k = dayKey(c.createdAt);
    const row = revByDay.get(k) ?? { revenue: 0, bookings: 0 };
    row.revenue += num(c.conversionValue); row.bookings += 1;
    revByDay.set(k, row);
  }
  const trend = dayKeys(start, end).map((date) => ({
    date, sessions: sessByDay.get(date) ?? 0,
    bookings: revByDay.get(date)?.bookings ?? 0, revenue: revByDay.get(date)?.revenue ?? 0,
  }));

  return {
    channelType: "other", channelName: "Other",
    hasData: otherSessions.length > 0 || bookings > 0,
    kpis: { sessions: otherSessions.length, bookings, revenue },
    unknownSources, trend,
  };
}

/**
 * Load one channel's deep-dive payload. Returns null for "all" (the frontend
 * falls back to the existing dashboard). Every query is agency-scoped + filtered
 * by hotelClientId; only the selected channel's queries run.
 */
export async function loadChannelView(
  hotelClientId: string,
  channel: ChannelKey,
  start: Date,
  end: Date,
): Promise<ChannelView | null> {
  switch (channel) {
    case "all":
      return null;
    case "meta_ads":
      return loadMetaAds(hotelClientId, start, end);
    case "google_ads":
      return loadGoogleAds(hotelClientId, start, end);
    case "instagram_organic":
      return loadInstagram(hotelClientId, start, end);
    case "facebook_organic":
      return loadFacebook(hotelClientId, start, end);
    case "influencer":
      return loadInfluencer(hotelClientId, start, end);
    case "direct":
      return loadDirect(hotelClientId, start, end);
    case "other":
      return loadOther(hotelClientId, start, end);
  }
}
