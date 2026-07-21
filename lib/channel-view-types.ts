// Client-safe channel-view types + constants. NO "server-only", no prisma — so
// client components (ChannelSelector, ChannelView) can import these without
// pulling the server query graph into the browser bundle. The server loaders
// live in lib/channel-view.ts (which re-exports everything here for callers).

import type { IntegrationHealth } from "@/lib/integration-health-types";

export const CHANNEL_KEYS = [
  "all",
  "meta_ads",
  "google_ads",
  "instagram_organic",
  "facebook_organic",
  "influencer",
  "direct",
  "other",
] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export function isChannelKey(v: unknown): v is ChannelKey {
  return typeof v === "string" && (CHANNEL_KEYS as readonly string[]).includes(v);
}

export type TrendPoint = Record<string, number | string>;

// The contract below applies to EVERY paid channel, not just Meta:
//   • conversions / costPerConversion / platformConversionValue are PLATFORM-
//     reported — whatever the ad network's own conversion tracking counted.
//   • bookings / revenue / roas / costPerBooking / conversionRate are TRACKED —
//     derived from TrackingEvent rows classified into this channel by
//     lib/source-classifier.ts.
// Mixing the two is what made Google-reported conversions display as HotelTrack
// bookings; keep the halves separate when adding a channel.
export type PaidKpis = {
  totalSpend: number; impressions: number; reach: number; frequency: number;
  cpc: number; cpm: number; ctr: number; linkClicks: number;
  // Platform-reported conversions (AdSnapshot / GoogleAdsCampaignSnapshot).
  conversions: number;
  costPerConversion: number | null;
  /**
   * Platform-reported conversion VALUE (e.g. Google's metrics.conversions_value).
   * Optional: only channels that report one populate it. NOT revenue — it is only
   * money when the advertiser configured monetary conversion values, so it must
   * never be summed into revenue or fed to a ROAS.
   */
  platformConversionValue?: number | null;
  // Tracked bookings/revenue (from TrackingEvent classified to this channel).
  bookings: number; revenue: number; roas: number | null;
  costPerBooking: number | null; conversionRate: number | null;
};
// Per-ad-account spend breakdown (a hotel can have >1 Meta account).
export type PaidAccount = { accountId: string; spend: number; impressions: number; clicks: number };
export type PaidChannelView = {
  channelType: "paid_ads";
  channelName: string;
  hasData: boolean;
  integrationStatus?: "not_connected";
  kpis?: PaidKpis;
  accounts?: PaidAccount[];          // included (non-archived) accounts, by spend desc
  archivedAccountIds?: string[];     // archived accounts excluded from the totals
  topCampaigns?: { campaignName: string; spend: number; revenue: number; bookings: number; roas: number | null; ctr: number }[];
  topCreatives?: null;
  trend?: { date: string; spend: number; revenue: number; bookings: number }[];
  /**
   * Integration Health (Linked → Flowing → Usable + diagnoses). Optional: today
   * only the Google Ads loader produces it. When a blocking diagnosis blocks
   * `paid.attribution`, consumers MUST render that diagnosis instead of the
   * booking/revenue figures — a zero we did not measure is not a zero.
   */
  health?: IntegrationHealth;
};

// One Instagram post row for the "My Instagram Content" table. postedAt is an
// ISO string because this payload crosses the JSON fetch boundary to the client.
export type InstagramPostItem = {
  id: string;
  postType: "reel" | "image" | "carousel" | "story";
  caption: string;
  captionPreview: string; // first 80 chars (+ "…" if truncated)
  permalink: string | null;
  reach: number;
  impressions: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  engagementRate: number; // (likes+comments+saves+shares)/reach * 100
  postedAt: string; // ISO 8601
};

// ── Instagram Reach Split (owned vs influencer content) ──────────────────────
// `reach` is nullable across these types: the IGAA API often can't return reach
// for other users' posts, so the UI shows "Not available" rather than 0. Sums
// (ownedContent.reach / influencerContent.reach / trend) only count rows whose
// reach is known. captionPreview is the first 80 chars (+ "…" when truncated).
export type ReachSplitTopOwned = {
  permalink: string | null; reach: number; captionPreview: string;
} | null;
export type ReachSplitTopInfluencer = {
  permalink: string; reach: number | null; influencerName: string; captionPreview: string;
} | null;
export type ReachSplitInfluencerRow = {
  influencerId: string; influencerName: string; instagramHandle: string;
  postCount: number; totalReach: number; totalEngagement: number;
  topPostPermalink: string | null;
};
export type UnattributedMentionItem = {
  id: string; posterUsername: string | null; postedAt: string; // ISO
  reach: number | null; permalink: string; mediaType: string;
};
export type ReachSplit = {
  totalReach: number; // ownedContent.reach + influencerContent.reach (known reach only)
  ownedContent: { reach: number; postCount: number; topPost: ReachSplitTopOwned };
  influencerContent: {
    reach: number; postCount: number; influencerCount: number;
    topPost: ReachSplitTopInfluencer;
    breakdown: ReachSplitInfluencerRow[]; // sorted by totalReach desc
  };
  unattributed: { count: number; items: UnattributedMentionItem[] }; // newest first, capped 50
  trendDaily: { date: string; ownedReach: number; influencerReach: number }[];
};

export type InstagramChannelView = {
  channelType: "organic_social";
  channelName: "Instagram Organic";
  hasData: boolean;
  kpis: {
    profileVisits: number; postReach: number; postImpressions: number; engagementRate: number;
    likes: number; comments: number; saves: number; shares: number;
    websiteClicks: number; sessionsFromInstagram: number; bookings: number; revenue: number;
  };
  // Owned-vs-influencer reach breakdown for the "Reach Split" dashboard section.
  reachSplit: ReachSplit;
  topPosts:
    | { postId: string; caption: string; reach: number; saves: number; websiteClicks: number; bookings: number | null; revenue: number | null }[]
    | null;
  // "My Instagram Content" table data — each sub-array capped at 50, the client
  // pages through 20 at a time. null when the hotel has no posts in the window.
  posts: {
    recent: InstagramPostItem[];
    topPerforming: {
      byReach: InstagramPostItem[];
      byEngagement: InstagramPostItem[];
      bySaves: InstagramPostItem[];
    };
  } | null;
  trend: { date: string; sessions: number; bookings: number; revenue: number }[];
};

export type FacebookChannelView = {
  channelType: "organic_social";
  channelName: "Facebook Organic";
  hasData: boolean;
  kpis: { pageVisits: number; pageFollows: number; postReach: number; websiteClicks: number; sessionsFromFacebook: number; bookings: number; revenue: number };
  trend: { date: string; sessions: number; bookings: number; revenue: number }[];
};

export type InfluencerChannelView = {
  channelType: "influencer";
  channelName: "Influencer";
  hasData: boolean;
  kpis: { activeInfluencers: number; activeCouponCodes: number; totalRedemptions: number; totalRevenue: number; averageRevenuePerInfluencer: number };
  topInfluencers: { influencerName: string; instagramHandle: string; activeCodesCount: number; redemptionsCount: number; revenue: number; avgBookingValue: number }[];
  redemptionSourceBreakdown: { snippetAuto: number; manualEntry: number };
  trend: { date: string; redemptions: number; revenue: number }[];
};

export type DirectChannelView = {
  channelType: "direct";
  channelName: "Direct";
  hasData: boolean;
  kpis: { sessions: number; bookings: number; revenue: number; avgBookingValue: number; conversionRate: number | null };
  topLandingPages: { pagePath: string; sessions: number; bookings: number }[];
  trend: { date: string; sessions: number; bookings: number; revenue: number }[];
};

export type OtherChannelView = {
  channelType: "other";
  channelName: "Other";
  hasData: boolean;
  kpis: { sessions: number; bookings: number; revenue: number };
  unknownSources: { utmSource: string; utmMedium: string; sessions: number; bookings: number; revenue: number }[];
  trend: { date: string; sessions: number; bookings: number; revenue: number }[];
};

export type ChannelView =
  | PaidChannelView | InstagramChannelView | FacebookChannelView
  | InfluencerChannelView | DirectChannelView | OtherChannelView;
