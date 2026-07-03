import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import {
  computeAdsSummary,
  computeChannelPerformance,
  computeContentPerformance,
  computeInfluencerImpact,
  computeKpis,
  creditForModel,
  creditPercents,
  normSource,
  resolveRange,
  trueRoi,
  type AdSnapshotInput,
  type AttributionModel,
  type ChannelRow,
  type ContentInput,
  type EventInput,
  type RedemptionInput,
  type TouchpointInput,
} from "@/lib/attribution";
import {
  formatCurrency,
  formatCurrencyCents,
  formatDuration,
  formatMultiple,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { DateRangeSelector } from "./DateRangeSelector";
import { PostTypeFilter } from "./PostTypeFilter";
import { ContentPerformanceTable } from "@/components/report/ContentPerformanceTable";
import { type CampaignRow } from "@/components/dashboard/CampaignPerformanceTable";
import {
  MetaCampaignBreakdownTable,
  type MetaCampaignRow,
} from "@/components/dashboard/MetaCampaignBreakdownTable";
import { KpiStrip, type KpiCardSpec } from "@/components/dashboard/mission/KpiStrip";
import { MetaVsRealityHero } from "@/components/dashboard/mission/MetaVsRealityHero";
import { AttributionPanel } from "@/components/dashboard/mission/AttributionPanel";
import { CampaignGrid, type CampaignCard } from "@/components/dashboard/mission/CampaignGrid";
import {
  ConversionJourneys,
  type ConversionJourney,
} from "@/components/dashboard/ConversionJourneys";
import {
  attributeConversions,
  UNATTRIBUTED_KEY,
  UNATTRIBUTED_NAME,
  type CampaignDay,
} from "@/lib/campaign-attribution";
import { SpendChart } from "@/components/report/SpendChart";
import { FollowerChart } from "@/components/report/FollowerChart";
import { ReportMenu } from "./ReportMenu";
import { HotelShareManager } from "./HotelShareManager";
import { DeleteHotelDangerZone } from "./DeleteHotelDangerZone";
import { hotelShareUrl } from "@/lib/hotel-share";
import { getBudgetStatus } from "@/lib/budget";
import { BudgetStatusCard } from "@/components/dashboard/BudgetStatusCard";
import { loadGa4Dashboard } from "@/lib/ga4-dashboard";
import { Ga4WebsiteTraffic } from "@/components/dashboard/Ga4WebsiteTraffic";
import {
  IntegrationBadges,
  IntegrationEmptyState,
  type BadgeState,
} from "@/components/dashboard/IntegrationBadges";
import type { TokenState } from "@/lib/integration-status";
import { loadHotelStates } from "@/lib/integration-status";
import { missingAdDays } from "@/lib/backfill";
import { computeFunnel, stageRank, STAGE_LABEL } from "@/lib/funnel";
import { RevenueBySource } from "@/components/dashboard/RevenueBySource";
import { CommissionSavings } from "@/components/dashboard/CommissionSavings";
import { OwnerSummaryCard } from "@/components/dashboard/OwnerSummaryCard";
import { PerformanceOverview } from "@/components/dashboard/PerformanceOverview";
import { loadInfluencerPerformance } from "@/lib/influencer-dashboard";
import { InfluencerPerformance } from "@/components/dashboard/InfluencerPerformance";
import { ContactInfoBanner } from "@/components/agency/ContactInfoBanner";
import { ContactAgencyCard } from "@/components/agency/ContactAgencyCard";
import { shouldShowContactBanner } from "@/lib/agency-contact";
import { ChannelSelector } from "@/components/dashboard/ChannelSelector";
import { ChannelView } from "@/components/dashboard/ChannelView";
import { isChannelKey, type ChannelKey } from "@/lib/channel-view";

const POST_TYPES = ["image", "video", "carousel", "reels"] as const;
type PostType = (typeof POST_TYPES)[number];
const DAY_MS = 86_400_000;
import { isPixelMode } from "@/lib/tracking-mode";

function KpiCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-card border border-line bg-card p-4 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-tertiary">{hint}</p>}
    </div>
  );
}

const GENDER_LABEL: Record<string, string> = { F: "Women", M: "Men", U: "Unknown" };

// Follower-demographics mini-card: a breakdown's dimensions as share-of-total.
function DemographicCard({
  title,
  rows,
  genderLabels,
}: {
  title: string;
  rows: { dimension: string; value: number }[];
  genderLabels?: boolean;
}) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <div className="rounded-card border border-line bg-card p-4 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">{title}</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-ink-tertiary">—</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {rows.map((r) => {
            const label = genderLabels ? (GENDER_LABEL[r.dimension] ?? r.dimension) : r.dimension;
            const pct = total > 0 ? (r.value / total) * 100 : 0;
            return (
              <li key={r.dimension} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-ink-secondary">{label}</span>
                <span className="tabular-nums text-ink-tertiary">{pct.toFixed(0)}%</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-card border border-line bg-card shadow-card">
      <div className="border-b border-line px-4 py-3">
        <h2 className="font-medium">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-ink-tertiary">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

export default async function HotelDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const member = await getCurrentMember();
  if (!member) redirect("/agency/onboarding");
  const pixelMode = isPixelMode();

  // Multi-tenant: scope by id AND agencyId so one agency can't open another's hotel.
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id },
    select: {
      id: true,
      name: true,
      websiteUrl: true,
      contactEmail: true,
      metaAdAccountId: true,
      metaAccountConnectedAt: true,
      budgetTrackingEnabled: true,
      monthlyAdBudget: true,
      budgetResetDay: true,
      snippetStatus: true,
      lastEventAt: true,
      lastSyncedAt: true,
      shareToken: true,
      shareTokenCreatedAt: true,
      shareTokenRevoked: true,
      showAdSpendToHotel: true,
    },
  });
  if (!hotel) notFound();

  // Integration health for the "needs attention" banner (broken/expired only).
  const integrationStatus = await loadHotelStates({
    hotelId: hotel.id,
    snippetStatus: hotel.snippetStatus,
    lastEventAt: hotel.lastEventAt,
    plan: member.agency.plan,
    pixelMode,
  });
  // ── Connection gating: hide an integration's data when it's disconnected ──
  // A disconnect deletes the token/connection row (snapshots are kept), so the
  // state becomes "not_connected"; we then show "—"/empty states instead of
  // stale historical numbers. "expired" still shows the last data (amber badge)
  // since it was real — only a true disconnect hides it.
  const metaConnected = integrationStatus.meta !== "not_connected";
  const igConnected = integrationStatus.instagram !== "not_connected";
  const tokenBadge = (s: TokenState): BadgeState =>
    s === "connected" || s === "expiring" ? "connected" : s === "expired" ? "warning" : "disconnected";

  // Cumulative days of missing Meta ad data, shown as a badge when the token
  // isn't healthy (a reconnect will backfill the gap).
  const missingDays =
    integrationStatus.meta === "connected"
      ? 0
      : await missingAdDays(member.agencyId, hotel.id);

  // "Fresh start" after an ad-account change: the new account is mapped (within
  // the last 24h) but no non-archived AdSnapshot has landed yet. Show a calm
  // "sync in progress" note instead of an empty/zero Paid Ads section.
  const liveAdSnapshotCount = hotel.metaAdAccountId
    ? await agencyScoped(prisma.adSnapshot).count({
        where: { hotelClientId: hotel.id, archived: false },
      })
    : 0;
  const metaFreshStart =
    !!hotel.metaAdAccountId &&
    liveAdSnapshotCount === 0 &&
    hotel.metaAccountConnectedAt != null &&
    Date.now() - hotel.metaAccountConnectedAt.getTime() < DAY_MS;

  // Budget status for the dashboard card (null when tracking is off → card hidden).
  const budgetStatus = await getBudgetStatus({
    id: hotel.id,
    agencyId: member.agencyId,
    budgetTrackingEnabled: hotel.budgetTrackingEnabled,
    monthlyAdBudget: hotel.monthlyAdBudget,
    budgetResetDay: hotel.budgetResetDay,
  });

  // Hotel-owner share link + its access audit trail (last viewed / views in the
  // last 30 days), so the agency can see engagement and get a nudge to follow up
  // when the hotel hasn't looked in a while. All scoped to this agency.
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);
  const [lastAccess, shareViews30d, shareViewsTotal] = await Promise.all([
    agencyScoped(prisma.hotelShareAccess).findFirst({
      where: { hotelClientId: hotel.id },
      orderBy: { accessedAt: "desc" },
      select: { accessedAt: true },
    }),
    agencyScoped(prisma.hotelShareAccess).count({
      where: { hotelClientId: hotel.id, accessedAt: { gte: thirtyDaysAgo } },
    }),
    agencyScoped(prisma.hotelShareAccess).count({
      where: { hotelClientId: hotel.id },
    }),
  ]);
  const shareUrl = hotel.shareToken ? hotelShareUrl(hotel.shareToken) : null;
  const shareAccess = {
    lastViewedAt: lastAccess?.accessedAt.toISOString() ?? null,
    daysSinceLastView: lastAccess
      ? Math.floor((Date.now() - lastAccess.accessedAt.getTime()) / DAY_MS)
      : null,
    views30d: shareViews30d,
    totalViews: shareViewsTotal,
  };

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  const range = resolveRange({
    range: one(sp.range),
    from: one(sp.from),
    to: one(sp.to),
  });
  const rawPostType = one(sp.postType);
  const postType: PostType | null =
    rawPostType && (POST_TYPES as readonly string[]).includes(rawPostType)
      ? (rawPostType as PostType)
      : null;

  // Channel-filtered view (Channel-Filtered Dashboard). A specific channel skips
  // the heavy full-dashboard queries below entirely (PART 5) and renders the
  // channel deep-dive instead. "all" falls through to the existing comprehensive
  // dashboard, unchanged.
  const channelParam = one(sp.channel);
  const channel: ChannelKey = isChannelKey(channelParam) ? channelParam : "all";
  if (channel !== "all") {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <Link href="/agency/hotels" className="text-sm text-ink-tertiary hover:underline">
            ← Hotel Clients
          </Link>
          <p className="text-sm text-ink-tertiary">{hotel.name}</p>
        </div>
        <ChannelView
          hotelId={hotel.id}
          channel={channel}
          from={range.fromInput}
          to={range.toInput}
          currentRange={range.key}
        />
      </div>
    );
  }

  // All five queries scoped to this agency + hotel + range.
  const [content, events, snapshots] = await Promise.all([
    agencyScoped(prisma.contentPiece).findMany({
      where: { hotelClientId: hotel.id },
      select: {
        id: true,
        title: true,
        contentType: true,
        platform: true,
        couponCode: true,
        influencerName: true,
      },
    }),
    pixelMode
      ? Promise.resolve([] as Array<{
          eventType: "visit" | "conversion";
          utmContent: string | null;
          utmCampaign: string | null;
          sessionId: string;
          conversionValue: import("@prisma/client").Prisma.Decimal | null;
        }>)
      : agencyScoped(prisma.trackingEvent).findMany({
          where: {
            hotelClientId: hotel.id,
            createdAt: { gte: range.since, lte: range.until },
          },
          select: {
            eventType: true,
            utmContent: true,
            utmCampaign: true,
            sessionId: true,
            conversionValue: true,
          },
        }),
    agencyScoped(prisma.adSnapshot).findMany({
      where: {
        hotelClientId: hotel.id,
        archived: false,
        date: { gte: range.since, lte: range.until },
      },
      orderBy: { date: "asc" },
      select: { date: true, spend: true, conversions: true, roas: true },
    }),
  ]);

  const contentIds = content.map((c) => c.id);
  const redemptions =
    contentIds.length > 0
      ? await agencyScoped(prisma.couponRedemption).findMany({
          where: {
            contentPieceId: { in: contentIds },
            redemptionDate: { gte: range.since, lte: range.until },
          },
          select: { contentPieceId: true, orderValue: true },
        })
      : [];

  // ── Campaign attribution: Meta campaigns ↔ real tracked bookings ──
  // Materialized per-day rows (refreshed by the Meta sync) + the raw events
  // needed for the per-conversion journey drill-down. Hidden in pixel mode
  // (no snippet events to attribute). All queries agency-scoped.
  const [
    campaignPerfRows,
    campaignSnapRows,
    recentConversionRows,
    attrConvRows,
    visitorSourceRows,
  ] = pixelMode
    ? [[], [], [], [], []]
    : await Promise.all([
        agencyScoped(prisma.campaignPerformance).findMany({
          where: {
            hotelClientId: hotel.id,
            archived: false,
            date: { gte: range.since, lte: range.until },
          },
          select: {
            campaignKey: true,
            campaignName: true,
            metaSpend: true,
            metaReportedConversions: true,
            realBookings: true,
            realBookingValue: true,
          },
        }),
        agencyScoped(prisma.adCampaignSnapshot).findMany({
          where: {
            hotelClientId: hotel.id,
            archived: false,
            date: { gte: range.since, lte: range.until },
          },
          select: {
            date: true,
            metaCampaignId: true,
            campaignName: true,
            spend: true,
            conversions: true,
            purchaseValue: true,
          },
        }),
        agencyScoped(prisma.trackingEvent).findMany({
          where: {
            hotelClientId: hotel.id,
            eventType: "conversion",
            createdAt: { gte: range.since, lte: range.until },
          },
          orderBy: { createdAt: "desc" },
          take: 15,
          select: {
            id: true,
            sessionId: true,
            utmCampaign: true,
            utmContent: true,
            pageUrl: true,
            conversionValue: true,
            createdAt: true,
          },
        }),
        // ALL in-range conversions (capped) for the multi-touch channel table —
        // distinct from the 15-row drill-down above.
        agencyScoped(prisma.trackingEvent).findMany({
          where: {
            hotelClientId: hotel.id,
            eventType: "conversion",
            createdAt: { gte: range.since, lte: range.until },
          },
          orderBy: { createdAt: "desc" },
          take: 2000,
          select: {
            id: true,
            sessionId: true,
            visitorId: true,
            utmSource: true,
            conversionValue: true,
            createdAt: true,
          },
        }),
        // Distinct (source, session) pairs over in-range VISITS — the "visitors
        // brought" denominator for the channel table's conversion rate.
        agencyScoped(prisma.trackingEvent).groupBy({
          by: ["utmSource", "sessionId"],
          where: {
            hotelClientId: hotel.id,
            eventType: "visit",
            createdAt: { gte: range.since, lte: range.until },
          },
        }),
      ]);
  // Visit history for every in-range conversion session (30 days back, matching
  // the snippet's cookie window) — feeds the campaign-attribution drill-down AND
  // the multi-touch touchpoint synthesis for legacy conversions. Plus the real
  // Touchpoint rows captured for new conversions.
  const convSessionIds = [
    ...new Set([
      ...recentConversionRows.map((c) => c.sessionId),
      ...attrConvRows.map((c) => c.sessionId),
    ]),
  ];
  const attrConvIds = attrConvRows.map((c) => c.id);
  const [journeyVisitRows, attrTouchpointRows] = await Promise.all([
    convSessionIds.length > 0
      ? agencyScoped(prisma.trackingEvent).findMany({
          where: {
            hotelClientId: hotel.id,
            eventType: "visit",
            sessionId: { in: convSessionIds },
            createdAt: {
              gte: new Date(range.since.getTime() - 30 * DAY_MS),
              lte: range.until,
            },
          },
          orderBy: { createdAt: "asc" },
          select: {
            sessionId: true,
            utmCampaign: true,
            utmContent: true,
            utmSource: true,
            pageUrl: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
    attrConvIds.length > 0
      ? agencyScoped(prisma.touchpoint).findMany({
          where: { conversionId: { in: attrConvIds } },
          orderBy: [{ conversionId: "asc" }, { position: "asc" }],
          select: { conversionId: true, position: true, utmSource: true },
        })
      : Promise.resolve([]),
  ]);

  // ── Meta Campaign Breakdown: raw per-campaign numbers straight from Meta
  //    (AdCampaignSnapshot), with NO snippet/UTM matching. Independent of the
  //    snippet, so it loads even in pixel mode. Agency-scoped. ──
  const metaCampaignSnaps = await agencyScoped(prisma.adCampaignSnapshot).findMany({
    where: {
      hotelClientId: hotel.id,
      archived: false,
      date: { gte: range.since, lte: range.until },
    },
    select: {
      date: true,
      metaCampaignId: true,
      campaignName: true,
      spend: true,
      impressions: true,
      clicks: true,
      conversions: true,
      purchaseValue: true,
    },
  });

  // ── Previous-period totals for the KPI strip's % change badges. Same tables,
  //    a window of equal length immediately before the selected range. ──
  const periodMs = range.until.getTime() - range.since.getTime();
  const prevSince = new Date(range.since.getTime() - periodMs);
  const prevUntil = range.since;
  const [prevConversions, prevSpendAgg, websiteVisits, prevWebsiteVisits] = await Promise.all([
    pixelMode
      ? Promise.resolve([] as { conversionValue: import("@prisma/client").Prisma.Decimal | null }[])
      : agencyScoped(prisma.trackingEvent).findMany({
          where: {
            hotelClientId: hotel.id,
            eventType: "conversion",
            createdAt: { gte: prevSince, lt: prevUntil },
          },
          select: { conversionValue: true },
        }),
    agencyScoped(prisma.adSnapshot).aggregate({
      where: { hotelClientId: hotel.id, archived: false, date: { gte: prevSince, lt: prevUntil } },
      _sum: { spend: true },
    }),
    // Website visits = distinct browsing sessions in the range (Phase 1 journey
    // capture; recorded regardless of pixel mode, unlike snippet "visit" events).
    // Plus the previous-period count for the KPI delta badge.
    agencyScoped(prisma.session).count({
      where: { hotelClientId: hotel.id, startedAt: { gte: range.since, lte: range.until } },
    }),
    agencyScoped(prisma.session).count({
      where: { hotelClientId: hotel.id, startedAt: { gte: prevSince, lt: prevUntil } },
    }),
  ]);

  // ── Organic social (Instagram) — all scoped to this agency + hotel ──
  // `priorFollowerSnap` is the last reading BEFORE the range, so follower growth
  // can be measured against the prior period. Post metrics drive engagement rate
  // (account-level engagement isn't synced), and the top-posts table.
  const [socialAccount, socialSnaps, priorFollowerSnap, topPosts, postAgg, postTypeAgg, audienceRows] =
    await Promise.all([
      agencyScoped(prisma.instagramConnection).findFirst({
        where: { hotelClientId: hotel.id, tokenType: "igaa_direct" },
        select: { status: true, username: true, lastSyncedAt: true },
      }),
      agencyScoped(prisma.socialSnapshot).findMany({
        where: {
          hotelClientId: hotel.id,
          date: { gte: range.since, lte: range.until },
        },
        orderBy: { date: "asc" },
        select: {
          date: true,
          followers: true,
          reach: true,
          impressions: true,
          views: true,
          profileViews: true,
          websiteClicks: true,
        },
      }),
      agencyScoped(prisma.socialSnapshot).findFirst({
        where: { hotelClientId: hotel.id, date: { lt: range.since } },
        orderBy: { date: "desc" },
        select: { followers: true },
      }),
      agencyScoped(prisma.postSnapshot).findMany({
        where: {
          hotelClientId: hotel.id,
          postedAt: { gte: range.since, lte: range.until },
          ...(postType ? { mediaType: postType } : {}),
        },
        orderBy: { reach: "desc" },
        take: 10,
        select: {
          mediaId: true,
          caption: true,
          mediaType: true,
          permalink: true,
          postedAt: true,
          reach: true,
          likes: true,
          comments: true,
          engagement: true,
          saves: true,
          shares: true,
          videoViews: true,
        },
      }),
      agencyScoped(prisma.postSnapshot).aggregate({
        where: {
          hotelClientId: hotel.id,
          postedAt: { gte: range.since, lte: range.until },
        },
        _sum: {
          engagement: true,
          reach: true,
          likes: true,
          comments: true,
          saves: true,
          shares: true,
        },
      }),
      // Per-post-type performance (for "top performing post type").
      agencyScoped(prisma.postSnapshot).groupBy({
        by: ["mediaType"],
        where: {
          hotelClientId: hotel.id,
          postedAt: { gte: range.since, lte: range.until },
        },
        _sum: { engagement: true, reach: true, likes: true, comments: true, saves: true, shares: true },
        _count: { _all: true },
      }),
      // Follower demographics (best-effort; empty for <100-follower accounts).
      agencyScoped(prisma.instagramAudience).findMany({
        where: { hotelClientId: hotel.id },
        orderBy: { value: "desc" },
        select: { breakdown: true, dimension: true, value: true },
      }),
    ]);

  // ── Stories: last 30 days only (older stories disappear from the Graph API,
  //    but we still keep their snapshots — query window is a UX cap, not data
  //    retention). ────────────────────────────────────────────────────────
  const storyWindowStart = new Date(Date.now() - 30 * DAY_MS);
  const [recentStories, storyAgg] = await Promise.all([
    agencyScoped(prisma.storySnapshot).findMany({
      where: {
        hotelClientId: hotel.id,
        postedAt: { gte: storyWindowStart },
      },
      orderBy: { postedAt: "desc" },
      take: 20,
      select: {
        storyId: true,
        mediaType: true,
        postedAt: true,
        reach: true,
        impressions: true,
        tapsForward: true,
        tapsBack: true,
        exits: true,
        replies: true,
      },
    }),
    agencyScoped(prisma.storySnapshot).aggregate({
      where: {
        hotelClientId: hotel.id,
        postedAt: { gte: range.since, lte: range.until },
      },
      _sum: { impressions: true, exits: true },
    }),
  ]);
  const storyImpressionsRange = storyAgg._sum.impressions ?? 0;
  const storyExitsRange = storyAgg._sum.exits ?? 0;
  const storyCompletionRate =
    storyImpressionsRange > 0
      ? (storyImpressionsRange - storyExitsRange) / storyImpressionsRange
      : null;

  // ── Website Traffic (GA4 OAuth) section + cross-validation ──
  // Total distinct snippet visit-sessions over the range (null in pixel mode),
  // for the GA4-vs-HotelTrack validation card.
  const trackedSessions = pixelMode
    ? null
    : (
        await agencyScoped(prisma.trackingEvent).findMany({
          where: {
            hotelClientId: hotel.id,
            eventType: "visit",
            createdAt: { gte: range.since, lte: range.until },
          },
          select: { sessionId: true },
          distinct: ["sessionId"],
        })
      ).length;
  const ga4Dashboard = await loadGa4Dashboard({
    agencyId: member.agencyId,
    hotelId: hotel.id,
    since: range.since,
    until: range.until,
    trackedSessions,
  });

  const hasSocialData =
    socialSnaps.length > 0 || topPosts.length > 0 || recentStories.length > 0;
  const followerSeries = socialSnaps.map((s) => ({
    date: s.date.toISOString().slice(0, 10),
    followers: s.followers,
  }));
  const currentFollowers = socialSnaps.length
    ? socialSnaps[socialSnaps.length - 1].followers
    : (priorFollowerSnap?.followers ?? 0);
  const priorFollowers =
    priorFollowerSnap?.followers ?? (socialSnaps.length ? socialSnaps[0].followers : 0);
  const followerGrowth = currentFollowers - priorFollowers;
  const followerGrowthPct = priorFollowers > 0 ? followerGrowth / priorFollowers : null;
  const socialReach = socialSnaps.reduce((sum, s) => sum + s.reach, 0);
  // "views" is the v22+ successor to account impressions; fall back to legacy
  // impressions for historical rows synced before the metric switch.
  const socialViews = socialSnaps.reduce((sum, s) => sum + (s.views || s.impressions), 0);
  const socialProfileViews = socialSnaps.reduce((sum, s) => sum + s.profileViews, 0);
  const socialWebsiteClicks = socialSnaps.reduce((sum, s) => sum + s.websiteClicks, 0);
  const postReachSum = postAgg._sum.reach ?? 0;
  // Engagement rate = (likes + comments + saves + shares) / reach.
  const totalInteractions =
    (postAgg._sum.likes ?? 0) +
    (postAgg._sum.comments ?? 0) +
    (postAgg._sum.saves ?? 0) +
    (postAgg._sum.shares ?? 0);
  const engagementRate = postReachSum > 0 ? totalInteractions / postReachSum : null;
  // Save-to-reach ratio — proxy for "compelling content".
  const saveToReach = postReachSum > 0 ? (postAgg._sum.saves ?? 0) / postReachSum : null;
  // Profile-visit conversion — profile views ÷ views (did content drive interest).
  const profileVisitConversion = socialViews > 0 ? socialProfileViews / socialViews : null;
  // Top performing post type by engagement rate (interactions ÷ reach), needs a
  // little reach to be meaningful.
  const postTypePerf = postTypeAgg
    .filter((g) => g.mediaType && (g._sum.reach ?? 0) >= 50)
    .map((g) => {
      const reach = g._sum.reach ?? 0;
      const interactions =
        (g._sum.likes ?? 0) + (g._sum.comments ?? 0) + (g._sum.saves ?? 0) + (g._sum.shares ?? 0);
      return { type: g.mediaType as string, rate: reach > 0 ? interactions / reach : 0, count: g._count._all };
    })
    .sort((a, b) => b.rate - a.rate);
  const topPostType = postTypePerf[0] ?? null;
  // Demographics grouped by breakdown (top dimensions per breakdown).
  const audienceByBreakdown = {
    country: audienceRows.filter((r) => r.breakdown === "country").slice(0, 5),
    age: audienceRows.filter((r) => r.breakdown === "age").sort((a, b) => a.dimension.localeCompare(b.dimension)),
    gender: audienceRows.filter((r) => r.breakdown === "gender"),
  };
  const hasAudience = audienceRows.length > 0;
  const socialLastUpdated = socialAccount?.lastSyncedAt ?? null;

  // ── Normalise Prisma Decimals -> plain numbers for the pure helpers ──
  const contentInputs: ContentInput[] = content;
  const eventInputs: EventInput[] = events.map((e) => ({
    eventType: e.eventType,
    utmContent: e.utmContent,
    utmCampaign: e.utmCampaign,
    sessionId: e.sessionId,
    conversionValue: e.conversionValue == null ? null : Number(e.conversionValue),
  }));
  const snapshotInputs: AdSnapshotInput[] = snapshots.map((s) => ({
    date: s.date,
    spend: Number(s.spend),
    conversions: s.conversions,
    roas: s.roas,
  }));
  const redemptionInputs: RedemptionInput[] = redemptions.map((r) => ({
    contentPieceId: r.contentPieceId,
    orderValue: Number(r.orderValue),
  }));

  // ── Compute ──
  const ads = computeAdsSummary(snapshotInputs);
  const kpis = computeKpis(eventInputs, ads.spend);
  const contentPerf = computeContentPerformance(contentInputs, eventInputs);
  const influencerRows = computeInfluencerImpact(contentInputs, redemptionInputs);

  const paidCampaigns = contentPerf.filter((c) => c.contentType === "paid_ad");
  const realAdRevenue = paidCampaigns.reduce((sum, c) => sum + c.revenue, 0);
  const realRoi = trueRoi(realAdRevenue, ads.spend);

  // ── Campaign performance: aggregate the per-day rows over the range ──
  const campaignAgg = new Map<string, CampaignRow>();
  for (const r of campaignPerfRows) {
    const row =
      campaignAgg.get(r.campaignKey) ??
      ({
        campaignKey: r.campaignKey,
        campaignName: r.campaignName,
        unattributed: r.campaignKey === UNATTRIBUTED_KEY,
        spend: 0,
        realBookings: 0,
        realRevenue: 0,
        realRoas: null,
        metaConversions: 0,
      } satisfies CampaignRow);
    row.spend += Number(r.metaSpend);
    row.metaConversions += r.metaReportedConversions;
    row.realBookings += r.realBookings;
    row.realRevenue += Number(r.realBookingValue);
    campaignAgg.set(r.campaignKey, row);
  }
  const campaignRows = [...campaignAgg.values()].map((r) => ({
    ...r,
    realRoas: r.spend > 0 ? r.realRevenue / r.spend : null,
  }));
  const matchedCampaignRows = campaignRows.filter((r) => !r.unattributed);
  const campaignTotalSpend = matchedCampaignRows.reduce((s, r) => s + r.spend, 0);
  const campaignRealRevenue = matchedCampaignRows.reduce((s, r) => s + r.realRevenue, 0);
  const campaignRealRoi = trueRoi(campaignRealRevenue, campaignTotalSpend);
  const matchedBookings = matchedCampaignRows.reduce((s, r) => s + r.realBookings, 0);
  const totalTrackedConversions = kpis.bookings;

  // ── Multi-touch attribution ──────────────────────────────────────────────
  // For every in-range conversion build an ordered touchpoint list: the real
  // Touchpoint rows when present, else synthesized from the session's visit
  // history + the conversion's own source (legacy "single-touch" data). Then
  // precompute all three models server-side so the dashboard toggle is instant.
  const realTpByConv = new Map<string, { position: number; source: string | null }[]>();
  for (const t of attrTouchpointRows) {
    if (!t.conversionId) continue;
    const list = realTpByConv.get(t.conversionId) ?? [];
    list.push({ position: t.position, source: t.utmSource });
    realTpByConv.set(t.conversionId, list);
  }
  const visitsBySession = new Map<string, typeof journeyVisitRows>();
  for (const v of journeyVisitRows) {
    const list = visitsBySession.get(v.sessionId) ?? [];
    list.push(v);
    visitsBySession.set(v.sessionId, list);
  }
  type ConvAttr = {
    id: string;
    value: number;
    touchpoints: TouchpointInput[];
    isSingleTouch: boolean;
  };
  const convAttr: ConvAttr[] = attrConvRows.map((c): ConvAttr => {
    const value = c.conversionValue == null ? 0 : Number(c.conversionValue);
    const real = realTpByConv.get(c.id);
    if (real && real.length > 0) {
      return {
        id: c.id,
        value,
        touchpoints: real.map((t) => ({ position: t.position, source: t.source })),
        isSingleTouch: false,
      };
    }
    // Synthesize from prior visits in the session + the conversion's own source.
    const visits = (visitsBySession.get(c.sessionId) ?? []).filter(
      (v) => v.createdAt <= c.createdAt,
    );
    const sources: string[] = [];
    for (const v of visits) {
      const s = normSource(v.utmSource);
      if (sources.length === 0 || sources[sources.length - 1] !== s) sources.push(s);
    }
    const convSrc = normSource(c.utmSource);
    if (sources.length === 0 || sources[sources.length - 1] !== convSrc) sources.push(convSrc);
    return {
      id: c.id,
      value,
      touchpoints: sources.map((s, i) => ({ position: i + 1, source: s })),
      isSingleTouch: true,
    };
  });
  const attrByConvId = new Map<string, ConvAttr>(convAttr.map((c) => [c.id, c]));

  // "Visitors brought" denominator: distinct sessions per normalized source.
  const visitorsBySource: Record<string, number> = {};
  {
    const setBySource = new Map<string, Set<string>>();
    for (const r of visitorSourceRows as {
      utmSource: string | null;
      sessionId: string;
    }[]) {
      const s = normSource(r.utmSource);
      const set = setBySource.get(s) ?? new Set<string>();
      set.add(r.sessionId);
      setBySource.set(s, set);
    }
    for (const [s, set] of setBySource) visitorsBySource[s] = set.size;
  }

  // Per-source ad spend (v1): all matched Meta campaign spend maps to the
  // documented paid source ("facebook" per the setup guide). Sources without
  // known spend show True ROAS "—". A per-source spend join is a follow-up.
  // When Meta is disconnected, spend is unknown → drop it so True ROAS reads "—"
  // (snippet-attributed visitors/bookings/revenue stay — they're real).
  const spendBySource: Record<string, number> =
    metaConnected && campaignTotalSpend > 0
      ? { [normSource("facebook")]: campaignTotalSpend }
      : {};

  const conversionsForAttr = convAttr.map((c) => ({
    touchpoints: c.touchpoints,
    value: c.value,
  }));
  const channelByModel: Record<AttributionModel, ChannelRow[]> = {
    first: computeChannelPerformance("first", conversionsForAttr, visitorsBySource, spendBySource),
    last: computeChannelPerformance("last", conversionsForAttr, visitorsBySource, spendBySource),
    position: computeChannelPerformance("position", conversionsForAttr, visitorsBySource, spendBySource),
  };

  // ── Per-conversion journeys (the drill-down proof artifact) ──
  const journeyCampaignDays: CampaignDay[] = campaignSnapRows.map((s) => ({
    date: s.date.toISOString().slice(0, 10),
    campaignId: s.metaCampaignId,
    campaignName: s.campaignName,
    spend: Number(s.spend),
    conversions: s.conversions,
    purchaseValue: Number(s.purchaseValue),
  }));
  const attributedRecent = attributeConversions(
    recentConversionRows.map((e) => ({
      id: e.id,
      sessionId: e.sessionId,
      utmCampaign: e.utmCampaign,
      utmContent: e.utmContent,
      pageUrl: e.pageUrl,
      conversionValue: e.conversionValue == null ? null : Number(e.conversionValue),
      createdAt: e.createdAt,
    })),
    journeyVisitRows,
    journeyCampaignDays,
  );
  const journeys: ConversionJourney[] = attributedRecent.map((a) => {
    const conv = a.conversion;
    const sessionVisits = journeyVisitRows.filter(
      (v) => v.sessionId === conv.sessionId && v.createdAt <= conv.createdAt,
    );
    const first = sessionVisits[0] ?? null;
    const between = first
      ? sessionVisits.slice(1).map((v) => v.pageUrl)
      : [];
    // Collapse consecutive repeats of the same page.
    const pagesVisited = between.filter((p, i) => i === 0 || p !== between[i - 1]).slice(0, 12);
    return {
      id: conv.id,
      convertedAt: conv.createdAt.toISOString(),
      conversionValue: conv.conversionValue,
      bookingPage: conv.pageUrl,
      firstTouch: first
        ? {
            campaign: first.utmCampaign,
            adTag: first.utmContent,
            source: first.utmSource,
            date: first.createdAt.toISOString(),
            landingPage: first.pageUrl,
          }
        : null,
      pagesVisited,
      daysToConvert: first
        ? Math.floor((conv.createdAt.getTime() - first.createdAt.getTime()) / DAY_MS)
        : null,
      attributedTo: a.campaignName,
      attributionReason: a.reason,
      ...(() => {
        const ma = attrByConvId.get(conv.id);
        if (!ma) return {};
        return {
          touchpoints: ma.touchpoints.map((t) => ({
            position: t.position,
            source: normSource(t.source),
          })),
          isSingleTouch: ma.isSingleTouch,
          modelCredits: {
            first: creditPercents(creditForModel("first", ma.touchpoints)),
            last: creditPercents(creditForModel("last", ma.touchpoints)),
            position: creditPercents(creditForModel("position", ma.touchpoints)),
          },
        };
      })(),
    };
  });

  // ── Aggregate the raw Meta campaign snapshots per campaign over the range ──
  const metaCampAgg = new Map<
    string,
    { campaignId: string; campaignName: string; spend: number; impressions: number; clicks: number; metaBookings: number; revenue: number }
  >();
  for (const r of metaCampaignSnaps) {
    const row =
      metaCampAgg.get(r.metaCampaignId) ??
      {
        campaignId: r.metaCampaignId,
        campaignName: r.campaignName,
        spend: 0,
        impressions: 0,
        clicks: 0,
        metaBookings: 0,
        revenue: 0,
      };
    row.spend += Number(r.spend);
    row.impressions += r.impressions;
    row.clicks += r.clicks;
    row.metaBookings += r.conversions;
    row.revenue += Number(r.purchaseValue);
    row.campaignName = r.campaignName; // latest name wins on a rename
    metaCampAgg.set(r.metaCampaignId, row);
  }
  const metaCampaignRows: MetaCampaignRow[] = [...metaCampAgg.values()].map((r) => ({
    campaignId: r.campaignId,
    campaignName: r.campaignName,
    spend: r.spend,
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.impressions > 0 ? r.clicks / r.impressions : 0,
    metaBookings: r.metaBookings,
    metaRoas: r.spend > 0 ? r.revenue / r.spend : null,
  }));

  // ── Mission-control derived metrics ──────────────────────────────────────
  // Previous-period rollups for the delta badges.
  const prevRevenue = prevConversions.reduce((s, e) => s + (e.conversionValue == null ? 0 : Number(e.conversionValue)), 0);
  const prevBookings = prevConversions.length;
  const prevSpend = Number(prevSpendAgg._sum.spend ?? 0);
  const prevRoas = prevSpend > 0 ? prevRevenue / prevSpend : null;
  const prevAdr = prevBookings > 0 ? prevRevenue / prevBookings : null;
  const prevCpb = prevBookings > 0 ? prevSpend / prevBookings : null;
  // Fractional change vs previous; null when there's no prior baseline.
  const pctDelta = (cur: number | null, prev: number | null): number | null =>
    prev == null || prev === 0 || cur == null ? null : (cur - prev) / prev;

  const adr = kpis.bookings > 0 ? kpis.revenue / kpis.bookings : null; // avg booking value
  const trueRoasColor =
    kpis.roas == null ? "text-ink" : kpis.roas > 4 ? "text-success" : kpis.roas >= 2 ? "text-warning" : "text-danger";

  // Cost/booking divides total ad spend by *tracked* bookings, so with only a
  // handful of tracked conversions the figure is meaningless (e.g. ₹7.6L / 2 =
  // ₹3.8L per booking). Suppress it until tracking coverage is high enough.
  const MIN_CPB_BOOKINGS = 10;
  const cpbReliable = kpis.costPerBooking != null && kpis.bookings >= MIN_CPB_BOOKINGS;

  const kpiCards: KpiCardSpec[] = [
    {
      label: "Website visits",
      value: formatNumber(websiteVisits),
      delta: pctDelta(websiteVisits, prevWebsiteVisits),
      hint: "Tracked sessions",
    },
    {
      label: "Revenue",
      value: formatCurrency(kpis.revenue, { compact: true }),
      title: formatCurrency(kpis.revenue),
      delta: pctDelta(kpis.revenue, prevRevenue),
    },
    {
      label: "Ad spend",
      value: metaConnected ? formatCurrency(ads.spend, { compact: true }) : "—",
      title: metaConnected ? formatCurrency(ads.spend) : "Connect Meta Ads to see this metric",
      delta: metaConnected ? pctDelta(ads.spend, prevSpend) : null,
      goodWhenUp: false,
      hint: metaConnected ? undefined : "Meta not connected",
    },
    {
      label: "True ROAS",
      value: metaConnected ? formatMultiple(kpis.roas) : "—",
      title: metaConnected ? undefined : "Connect Meta Ads to see this metric",
      delta: metaConnected ? pctDelta(kpis.roas, prevRoas) : null,
      valueClassName: metaConnected ? trueRoasColor : undefined,
      hint: metaConnected ? "Real revenue ÷ spend" : "Meta not connected",
    },
    { label: "Bookings", value: formatNumber(kpis.bookings), delta: pctDelta(kpis.bookings, prevBookings) },
    {
      label: "ADR",
      value: adr == null ? "—" : formatCurrency(adr, { compact: true }),
      title: adr == null ? undefined : formatCurrency(adr),
      delta: pctDelta(adr, prevAdr),
      hint: "Avg booking value",
    },
    {
      label: "Cost / booking",
      value: metaConnected && cpbReliable ? formatCurrency(kpis.costPerBooking!, { compact: true }) : "—",
      title: !metaConnected
        ? "Connect Meta Ads to see this metric"
        : cpbReliable
          ? formatCurrency(kpis.costPerBooking!)
          : undefined,
      delta: metaConnected && cpbReliable ? pctDelta(kpis.costPerBooking, prevCpb) : null,
      goodWhenUp: false,
      hint: !metaConnected
        ? "Meta not connected"
        : cpbReliable
          ? "Ad spend ÷ tracked bookings"
          : `Needs ≥${MIN_CPB_BOOKINGS} tracked bookings`,
    },
  ];

  // Meta-vs-reality hero (ad campaigns: Meta's claims vs verified bookings).
  const metaVsReality = {
    metaBookings: ads.bookingsFromAds,
    metaRevenue: ads.metaReportedRevenue,
    realBookings: matchedBookings,
    realRevenue: campaignRealRevenue,
  };

  // Per-campaign 7-day spend sparkline series, keyed by campaign id.
  const last7 = Array.from({ length: 7 }, (_, i) =>
    new Date(range.until.getTime() - (6 - i) * DAY_MS).toISOString().slice(0, 10),
  );
  const sparkByCampaign = new Map<string, Map<string, number>>();
  for (const r of metaCampaignSnaps) {
    const d = r.date.toISOString().slice(0, 10);
    const m = sparkByCampaign.get(r.metaCampaignId) ?? new Map<string, number>();
    m.set(d, (m.get(d) ?? 0) + Number(r.spend));
    sparkByCampaign.set(r.metaCampaignId, m);
  }
  // Join verified campaign rows (by name) to the raw Meta rows (impressions/
  // clicks/CTR/id/sparkline) for the card grid.
  const metaByName = new Map(metaCampaignRows.map((m) => [m.campaignName.trim().toLowerCase(), m]));
  const campaignCards: CampaignCard[] = matchedCampaignRows
    .map((c): CampaignCard => {
      const meta = metaByName.get(c.campaignName.trim().toLowerCase());
      const id = meta?.campaignId ?? c.campaignKey;
      const dayMap = meta ? sparkByCampaign.get(meta.campaignId) : undefined;
      const spark = dayMap ? last7.map((d) => dayMap.get(d) ?? 0) : [];
      return {
        campaignKey: c.campaignKey,
        campaignName: c.campaignName,
        spend: c.spend,
        realBookings: c.realBookings,
        realRevenue: c.realRevenue,
        realRoas: c.realRoas,
        metaBookings: c.metaConversions,
        metaRevenue: meta?.metaRoas != null ? meta.metaRoas * (meta.spend ?? 0) : 0,
        impressions: meta?.impressions ?? 0,
        clicks: meta?.clicks ?? 0,
        ctr: meta?.ctr ?? 0,
        variancePct: c.realBookings > 0 ? ((c.metaConversions - c.realBookings) / c.realBookings) * 100 : null,
        spark,
      };
    })
    .sort((a, b) => (b.realRoas ?? -1) - (a.realRoas ?? -1));

  // ── Recent visitor journeys (snippet v2) — compact preview; full page-by-page
  //    view lives at /agency/hotel/[id]/journeys. Journey/funnel data comes from
  //    the v2 snippet and exists independently of the Pixel-vs-attribution
  //    distinction, so it is NOT gated on pixel mode (the card self-handles the
  //    empty state). All reads agency-scoped + hotel-scoped. ──
  const recentSessions = await agencyScoped(prisma.session).findMany({
    where: { hotelClientId: hotel.id },
    orderBy: { startedAt: "desc" },
    take: 5,
    select: {
      id: true,
      visitorId: true,
      startedAt: true,
      totalTimeMs: true,
      pageViewCount: true,
      landingPath: true,
      exitPath: true,
    },
  });
  const recentSessionIds = recentSessions.map((s) => s.id);
  const convertedSessionIds =
    recentSessionIds.length > 0
      ? new Set(
          (
            await agencyScoped(prisma.trackingEvent).findMany({
              where: {
                hotelClientId: hotel.id,
                eventType: "conversion",
                sessionId: { in: recentSessionIds },
              },
              select: { sessionId: true },
            })
          ).map((r) => r.sessionId),
        )
      : new Set<string>();

  // ── Compact funnel summary for the dashboard card (Phase 2). Cumulative
  //    visitor counts per stage over the selected range; links to /journeys. ──
  const funnelStageGroups = await agencyScoped(prisma.session).groupBy({
    by: ["highestStageReached"],
    where: {
      hotelClientId: hotel.id,
      startedAt: { gte: range.since, lte: range.until },
    },
    _count: { _all: true },
  });
  const funnelReachedByRank: Record<number, number> = {};
  for (const g of funnelStageGroups) {
    const r = stageRank(g.highestStageReached);
    if (r > 0) funnelReachedByRank[r] = (funnelReachedByRank[r] ?? 0) + g._count._all;
  }
  const funnelSummary = computeFunnel({ reachedByRank: funnelReachedByRank, revenue: 0 });
  const funnelHasData = (funnelSummary.stages[0]?.visitors ?? 0) > 0;

  // Influencer Performance (Phase R2) — per-influencer redemptions + revenue for
  // this hotel over the selected range. Not pixel-gated (coupon redemptions exist
  // independently of snippet/Pixel mode, incl. manual entries).
  const influencerPerformance = await loadInfluencerPerformance(hotel.id, {
    since: range.since,
    until: range.until,
  });

  return (
    <div className="space-y-6">
      {/* Header strip — hotel + last sync (left), period selector + actions (right) */}
      <div className="space-y-4">
        <Link href="/agency/hotels" className="text-sm text-ink-tertiary hover:underline">
          ← Hotel Clients
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">{hotel.name}</h1>
            <p className="mt-0.5 text-sm text-ink-tertiary">
              {hotel.websiteUrl}
              {hotel.lastSyncedAt && (
                <span className="ml-2 text-ink-disabled">
                  · Last synced{" "}
                  {new Date(hotel.lastSyncedAt).toLocaleString("en-IN", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-col items-end">
              <DateRangeSelector
                current={range.key}
                fromInput={range.fromInput}
                toInput={range.toInput}
              />
              <span className="mt-1 text-xs text-ink-disabled">vs previous period</span>
            </div>
            <Link
              href={`/agency/hotel/${hotel.id}/integrations`}
              className="rounded-button border border-line-strong bg-elevated px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-line-strong"
            >
              Manage Integrations
            </Link>
            <ReportMenu
              hotelId={hotel.id}
              from={range.fromInput}
              to={range.toInput}
            />
          </div>
        </div>
        {missingDays > 0 && (
          <Link
            href={`/agency/hotel/${hotel.id}/integrations`}
            className="inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-1 text-xs font-medium text-warning ring-1 ring-warning/30 hover:bg-warning/25"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-warning" />
            {missingDays} day{missingDays === 1 ? "" : "s"} of data missing — reconnect Meta to backfill
          </Link>
        )}
      </div>

      {/* Channel selector — "All Channels" (this full dashboard) by default;
          pick a channel to switch to its deep-dive view. */}
      <ChannelSelector current="all" />

      {/* Non-blocking nudge for existing (pre-deploy) agencies missing contact
          info. New signups never see it (their signup required the info). */}
      {shouldShowContactBanner(member.agency) && <ContactInfoBanner />}

      {/* Owner Summary — glanceable plain-English read of recent performance,
          at the very top of the dashboard (above all sections). */}
      <OwnerSummaryCard hotelId={hotel.id} />

      {/* Performance Overview (Tier A) — 10 owner-overview metrics over the same
          date range as the page. Read-only on existing data; sits between the
          Owner Summary and Revenue by Source. */}
      <PerformanceOverview hotelId={hotel.id} from={range.fromInput} to={range.toInput} />

      {/* Integration status badges — click any to manage that integration */}
      <IntegrationBadges
        hotelId={hotel.id}
        items={[
          { name: "Meta Ads", state: tokenBadge(integrationStatus.meta) },
          { name: "Instagram", state: tokenBadge(integrationStatus.instagram) },
          { name: "GA4", state: ga4Dashboard.connected ? "connected" : "disconnected" },
        ]}
      />

      {/* Integration health banner — only when something is broken or expired */}
      {integrationStatus.anyBrokenOrExpired && (
        <Link
          href={`/agency/hotel/${hotel.id}/integrations`}
          className="flex items-center justify-between gap-3 rounded-card border-l-4 border-warning bg-warning/10 px-4 py-3 text-sm text-ink-secondary hover:bg-warning/20"
        >
          <span>
            <strong>An integration needs attention.</strong> A connection for this
            hotel is broken or expired — data may be missing from this dashboard.
          </span>
          <span className="shrink-0 font-medium underline">Fix it →</span>
        </Link>
      )}

      {/* Budget Status card (only when budget tracking is enabled) */}
      {budgetStatus && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <BudgetStatusCard
            status={{
              spendPaise: budgetStatus.spendPaise,
              budgetPaise: budgetStatus.budgetPaise,
              pct: budgetStatus.pct,
              state: budgetStatus.state,
            }}
          />
        </div>
      )}

      {/* Section 1 — Mission control: KPI strip, Meta-vs-reality hero, channels */}
      {!pixelMode && (
        <div className="space-y-6">
          <KpiStrip cards={kpiCards} />
          {metaConnected && <MetaVsRealityHero data={metaVsReality} />}
          <AttributionPanel byModel={channelByModel} />
        </div>
      )}

      {/* Section 2 — Content performance (attribution-dependent; hidden in pixel mode) */}
      {!pixelMode && (
        <SectionCard
          title="Content performance"
          subtitle="Every content piece for this hotel, attributed via its utm_content tag. Click a column to sort."
        >
          <ContentPerformanceTable rows={contentPerf} />
        </SectionCard>
      )}

      {/* Section 3 — Paid ads */}
      <SectionCard
        title="Paid ads performance"
        subtitle={
          hotel.metaAdAccountId
            ? `Meta ad account ${hotel.metaAdAccountId}`
            : "No Meta ad account mapped — map one in Settings to sync ad data."
        }
      >
        {!metaConnected ? (
          <IntegrationEmptyState
            hotelId={hotel.id}
            title="Meta Ads not connected"
            body="Connect Meta to see ad spend, campaign performance, and ROAS."
            cta="Connect Meta"
          />
        ) : (
          <>
        {metaFreshStart && (
          <div className="border-b border-line bg-info/10 px-4 py-3 text-sm text-ink-secondary">
            <p className="font-medium text-ink">Meta sync in progress.</p>
            <p className="mt-0.5">
              Data from your new ad account will appear within 24 hours, after the
              next sync at 2am UTC.
            </p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4">
          <div className="bg-card p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
              Meta ad spend
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {formatCurrency(ads.spend)}
            </p>
          </div>
          <div className="bg-card p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
              Bookings from ads
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {formatNumber(ads.bookingsFromAds)}
            </p>
            <p className="mt-0.5 text-xs text-ink-tertiary">Meta-reported</p>
          </div>
          <div className="bg-card p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
              Meta ROAS
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {formatMultiple(ads.metaRoas)}
            </p>
            <p className="mt-0.5 text-xs text-ink-tertiary">Platform-reported</p>
          </div>
          {!pixelMode && (
            <div className="bg-card p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                True ROI
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {realRoi == null ? "—" : formatPercent(realRoi)}
              </p>
              <p className="mt-0.5 text-xs text-ink-tertiary">Real bookings ÷ spend</p>
            </div>
          )}
        </div>

        <div className="p-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
            Spend over time
          </p>
          <SpendChart data={ads.spendOverTime} />
        </div>

        {!pixelMode && (
          <div className="border-t border-line">
            <p className="px-4 pt-4 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
              Campaign breakdown
            </p>
            {paidCampaigns.length === 0 ? (
              <p className="px-4 py-6 text-sm text-ink-tertiary">
                No paid-ad content for this hotel yet.
              </p>
            ) : (
            <div className="overflow-x-auto">
              <table className="ht-table w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-ink-tertiary">
                  <tr>
                    <th className="px-4 py-2 font-medium">Campaign</th>
                    <th className="px-4 py-2 text-right font-medium">Sessions</th>
                    <th className="px-4 py-2 text-right font-medium">Bookings</th>
                    <th className="px-4 py-2 text-right font-medium">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {paidCampaigns.map((c) => (
                    <tr
                      key={c.id}
                      className="border-t border-line"
                    >
                      <td className="px-4 py-2 font-medium">{c.title}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatNumber(c.sessions)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatNumber(c.bookings)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatCurrency(c.revenue)}
                      </td>
                    </tr>
                  ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
          </>
        )}
      </SectionCard>

      {/* Section 3.4 — Meta Campaign Breakdown: raw per-campaign numbers from
          Meta, NO snippet matching. Sits above the verified attribution below.
          Hidden entirely when Meta is disconnected. */}
      {metaConnected && (
      <SectionCard
        title="Meta Campaign Breakdown"
        subtitle="Meta-reported (raw from Facebook). For verified booking attribution, see the Campaign Performance section below."
      >
        {metaCampaignRows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-tertiary">
            {hotel.metaAdAccountId
              ? "No Meta campaign data for this range yet — runs after the next ad sync."
              : "No Meta ad account mapped — map one in Settings to pull campaign data."}
          </p>
        ) : (
          <>
            <MetaCampaignBreakdownTable rows={metaCampaignRows} />
            <p className="border-t border-line px-4 py-3 text-xs text-ink-tertiary">
              {metaCampaignRows.length} campaign{metaCampaignRows.length === 1 ? "" : "s"} · {range.label} ·
              numbers exactly as Meta reports them, before HotelTrack attribution. Use the date range
              selector at the top to switch between last 7 / 30 / 90 days.
            </p>
          </>
        )}
      </SectionCard>
      )}

      {/* Section 3.5 — Campaign performance: Meta's claims vs reality (verified).
          Meta-dependent — hidden entirely when Meta is disconnected. */}
      {!pixelMode && metaConnected && (
        <SectionCard
          title="Campaign performance"
          subtitle="Each Meta campaign's spend joined to the bookings our snippet actually tracked on the hotel's website — what Meta claims vs what really happened."
        >
          {matchedBookings === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-medium">
                Campaign performance will appear once we&apos;ve collected at least 5
                conversions across your ads.
              </p>
              <p className="mt-1 text-sm text-ink-tertiary">
                Currently tracking: {formatNumber(totalTrackedConversions)} conversion
                {totalTrackedConversions === 1 ? "" : "s"}.
                {totalTrackedConversions < 5 &&
                  ` Need: ${5 - totalTrackedConversions} more.`}
                {totalTrackedConversions >= 5 &&
                  " None carried a utm_campaign matching a Meta campaign yet — check that your ad URLs include utm_campaign tags."}
              </p>
            </div>
          ) : (
            <>
              <div className="p-4">
                <CampaignGrid cards={campaignCards} />
              </div>
              <div className="grid grid-cols-1 gap-px border-t border-line bg-line sm:grid-cols-3">
                <div className="bg-card p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                    Total ad spend (selected period)
                  </p>
                  <p className="mt-1 text-xl font-semibold tabular-nums">
                    {formatCurrency(campaignTotalSpend)}
                  </p>
                </div>
                <div className="bg-card p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                    Real revenue from ads
                  </p>
                  <p className="mt-1 text-xl font-semibold tabular-nums">
                    {formatCurrency(campaignRealRevenue)}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-tertiary">Snippet-tracked bookings</p>
                </div>
                <div className="bg-card p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                    Real ROI
                  </p>
                  <p
                    className={`mt-1 text-xl font-semibold tabular-nums ${
                      campaignRealRoi == null
                        ? ""
                        : campaignRealRoi >= 0
                          ? "text-success"
                          : "text-danger"
                    }`}
                  >
                    {campaignRealRoi == null ? "—" : formatPercent(campaignRealRoi)}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-tertiary">
                    (Revenue − spend) ÷ spend
                  </p>
                </div>
              </div>
            </>
          )}

          <div className="border-t border-line">
            <p className="px-4 pt-4 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
              Recent tracked bookings
            </p>
            <ConversionJourneys journeys={journeys} />
          </div>
        </SectionCard>
      )}

      {/* Recent Visitor Journeys (snippet v2) — compact preview, full view at
          /journeys. Shown regardless of pixel mode (journey data is snippet-
          driven and independent of the attribution-vs-Pixel distinction). */}
      {(
        <SectionCard
          title="Recent Visitor Journeys"
          subtitle="The page-by-page path each visitor took, with time on page and drop-off."
        >
          {funnelHasData && (
            <div className="border-b border-line px-4 py-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                  Funnel · {range.label.toLowerCase()}
                </p>
                <Link
                  href={`/agency/hotel/${hotel.id}/journeys`}
                  className="text-xs font-medium text-brand hover:underline"
                >
                  Full funnel analysis →
                </Link>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {funnelSummary.stages.map((st) => (
                  <div key={st.stage} className="rounded-lg border border-line p-3">
                    <p className="text-xs text-ink-tertiary">{STAGE_LABEL[st.stage]}</p>
                    <p className="mt-0.5 text-lg font-semibold tabular-nums">
                      {formatNumber(st.visitors)}
                    </p>
                    <p className="text-xs text-ink-tertiary tabular-nums">
                      {st.conversionFromPrev == null ? "—" : formatPercent(st.conversionFromPrev)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {recentSessions.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-ink-tertiary">
              No visitor journeys yet. They appear once this hotel installs the v2
              tracking snippet and visitors browse the site.
            </p>
          ) : (
            <>
              <ul className="divide-y divide-line">
                {recentSessions.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
                    <div className="flex min-w-0 items-center gap-2">
                      <code className="text-xs text-ink-tertiary" title={s.visitorId}>
                        {s.visitorId.length > 14 ? `${s.visitorId.slice(0, 14)}…` : s.visitorId}
                      </code>
                      {convertedSessionIds.has(s.id) && (
                        <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-semibold text-success">
                          Converted
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-ink-secondary tabular-nums">
                      <span className="truncate text-ink-tertiary" title={`${s.landingPath} → ${s.exitPath ?? "—"}`}>
                        {s.landingPath}
                        {s.exitPath && s.exitPath !== s.landingPath ? ` → ${s.exitPath}` : ""}
                      </span>
                      <span>{s.pageViewCount} pg</span>
                      <span>{formatDuration(s.totalTimeMs)}</span>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="border-t border-line px-4 py-3 text-sm">
                <Link
                  href={`/agency/hotel/${hotel.id}/journeys`}
                  className="font-medium text-brand hover:underline"
                >
                  View all journeys →
                </Link>
              </div>
            </>
          )}
        </SectionCard>
      )}

      {/* Commission Saved vs OTAs (per-hotel) — direct-booking savings KPI + trend. */}
      <SectionCard
        title="Commission Saved vs OTAs"
        subtitle="How much your direct (snippet-tracked) bookings saved vs paying OTA commission. Set the rate on the Integrations page."
      >
        <div className="p-4">
          <CommissionSavings hotelId={hotel.id} />
        </div>
      </SectionCard>

      {/* Revenue by Source — how much booking revenue came from each marketing
          source, at three granularities. Client-fetched (toggles/date/chips). */}
      <SectionCard
        title="Revenue by Source"
        subtitle="Booking revenue and counts per marketing source, with source / medium / campaign drill-down."
      >
        <div className="p-4">
          <RevenueBySource hotelId={hotel.id} />
        </div>
      </SectionCard>

      {/* Influencer Performance (Phase R2) — per-influencer coupon redemptions */}
      <SectionCard
        title="Influencer Performance"
        subtitle="Redemptions and attributed revenue per influencer, from coupon codes (snippet-captured or manually logged)."
      >
        <InfluencerPerformance rows={influencerPerformance} />
      </SectionCard>

      {/* Section 4 — Influencer impact */}
      <SectionCard
        title="Influencer impact"
        subtitle="Coupon redemptions and revenue per influencer collaboration."
      >
        {influencerRows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-tertiary">
            No influencer content for this hotel yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="ht-table w-full text-left text-sm">
              <thead className="bg-card text-xs uppercase tracking-wide text-ink-tertiary">
                <tr>
                  <th className="px-4 py-3 font-medium">Influencer</th>
                  <th className="px-4 py-3 font-medium">Coupon</th>
                  <th className="px-4 py-3 text-right font-medium">Redemptions</th>
                  <th className="px-4 py-3 text-right font-medium">Revenue</th>
                  <th className="px-4 py-3 text-right font-medium">Cost / booking</th>
                </tr>
              </thead>
              <tbody>
                {influencerRows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-line"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium">{r.influencerName}</div>
                      <div className="text-xs text-ink-tertiary">{r.title}</div>
                    </td>
                    <td className="px-4 py-3">
                      {r.couponCode ? (
                        <code className="rounded bg-elevated px-1.5 py-0.5 text-xs">
                          {r.couponCode}
                        </code>
                      ) : (
                        <span className="text-ink-disabled">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatNumber(r.redemptions)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCurrency(r.revenue)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-ink-disabled">
                      {r.costPerBooking == null
                        ? "—"
                        : formatCurrencyCents(r.costPerBooking)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-4 py-3 text-xs text-ink-tertiary">
              Cost / booking shows once influencer fees are tracked per
              collaboration.
            </p>
          </div>
        )}
      </SectionCard>

      {/* Section 5 — Social media performance (organic Instagram) */}
      <SectionCard
        title="Social media performance"
        subtitle={
          socialAccount?.username ? `Organic Instagram · @${socialAccount.username}` : "Organic Instagram"
        }
      >
        {!igConnected ? (
          <IntegrationEmptyState
            hotelId={hotel.id}
            title="Instagram not connected"
            body="Connect Instagram to see organic reach, engagement, and post performance."
            cta="Connect Instagram"
          />
        ) : !hasSocialData ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-ink-tertiary">
              Instagram connected — run a sync from the Integrations page to pull
              reach, engagement, and posts.
            </p>
            <Link
              href={`/agency/hotel/${hotel.id}/integrations`}
              className="mt-2 inline-block text-sm font-medium text-ink-secondary underline"
            >
              Go to Integrations →
            </Link>
          </div>
        ) : (
          <div className="space-y-5 p-4">
            <p className="text-xs text-ink-tertiary">
              {socialLastUpdated
                ? `Last updated ${new Date(socialLastUpdated).toLocaleString()} · `
                : ""}
              Refreshes on a schedule, not in real time.
            </p>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <KpiCard
                label="Followers"
                value={formatNumber(currentFollowers)}
                hint={`${followerGrowth >= 0 ? "+" : "−"}${formatNumber(
                  Math.abs(followerGrowth),
                )} vs prior${
                  followerGrowthPct != null ? ` · ${formatPercent(Math.abs(followerGrowthPct))}` : ""
                }`}
              />
              <KpiCard label="Reach" value={formatNumber(socialReach)} hint="Unique accounts" />
              <KpiCard label="Views" value={formatNumber(socialViews)} hint="Content plays & displays" />
              <KpiCard label="Profile views" value={formatNumber(socialProfileViews)} />
              <KpiCard
                label="Website clicks"
                value={formatNumber(socialWebsiteClicks)}
                hint="Link-in-bio taps"
              />
              <KpiCard
                label="Engagement rate"
                value={engagementRate == null ? "—" : formatPercent(engagementRate)}
                hint="(likes + comments + saves + shares) ÷ reach"
              />
              <KpiCard
                label="Save-to-reach"
                value={saveToReach == null ? "—" : formatPercent(saveToReach)}
                hint="Saves ÷ reach — content that resonates"
              />
              <KpiCard
                label="Profile-visit conv."
                value={profileVisitConversion == null ? "—" : formatPercent(profileVisitConversion)}
                hint="Profile views ÷ views"
              />
              <KpiCard
                label="Story completion"
                value={storyCompletionRate == null ? "—" : formatPercent(storyCompletionRate)}
                hint="(impressions − exits) ÷ impressions"
              />
            </div>

            {/* Within-API limits notice — sets expectations on what Meta exposes. */}
            <div className="rounded-lg border-l-4 border-info bg-info/10 p-3 text-xs text-ink-secondary">
              <span className="font-semibold text-ink">Note:</span> Some Instagram
              metrics like video retention time and skip rate are only available
              in the Instagram app itself — Meta does not expose these through
              their API. For weekly retention reports, hotels can screenshot these
              from the Instagram app and share with their agency.
            </div>

            {topPostType && (
              <div className="rounded-lg border border-line bg-card px-4 py-3 text-sm">
                <span className="text-ink-tertiary">Top performing post type: </span>
                <span className="font-semibold capitalize text-ink">{topPostType.type}</span>
                <span className="text-ink-tertiary">
                  {" "}— {formatPercent(topPostType.rate)} engagement rate across{" "}
                  {topPostType.count} post{topPostType.count === 1 ? "" : "s"}
                </span>
              </div>
            )}

            {hasAudience && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                  Follower demographics
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <DemographicCard title="Top countries" rows={audienceByBreakdown.country} />
                  <DemographicCard title="Age range" rows={audienceByBreakdown.age} />
                  <DemographicCard title="Gender" rows={audienceByBreakdown.gender} genderLabels />
                </div>
              </div>
            )}

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                Follower growth
              </p>
              <FollowerChart data={followerSeries} />
            </div>

            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                  Top posts by reach
                </p>
                <PostTypeFilter current={postType ?? "all"} />
              </div>
              {topPosts.length === 0 ? (
                <p className="text-sm text-ink-tertiary">
                  No {postType ? `${postType} ` : ""}posts published in this range.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className="ht-table w-full text-left text-sm">
                    <thead className="bg-card text-xs uppercase tracking-wide text-ink-tertiary">
                      <tr>
                        <th className="px-4 py-2 font-medium">Post</th>
                        <th className="px-4 py-2 font-medium">Type</th>
                        <th className="px-4 py-2 text-right font-medium">Reach</th>
                        <th className="px-4 py-2 text-right font-medium">Likes</th>
                        <th className="px-4 py-2 text-right font-medium">Comments</th>
                        <th className="px-4 py-2 text-right font-medium">Engagement</th>
                        <th className="px-4 py-2 text-right font-medium">Saves</th>
                        <th className="px-4 py-2 text-right font-medium">Shares</th>
                        <th className="px-4 py-2 text-right font-medium">Plays</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topPosts.map((p) => (
                        <tr key={p.mediaId} className="border-t border-line">
                          <td className="px-4 py-2">
                            {p.permalink ? (
                              <a
                                href={p.permalink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-medium hover:underline"
                              >
                                {p.caption ? p.caption.slice(0, 60) : p.mediaType ?? "Post"}
                              </a>
                            ) : (
                              <span className="font-medium">
                                {p.caption ? p.caption.slice(0, 60) : p.mediaType ?? "Post"}
                              </span>
                            )}
                            {p.postedAt && (
                              <span className="block text-xs text-ink-tertiary">
                                {new Date(p.postedAt).toLocaleDateString()}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-xs capitalize text-ink-tertiary">
                            {p.mediaType ?? "—"}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatNumber(p.reach)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatNumber(p.likes)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {formatNumber(p.comments)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {formatNumber(p.engagement)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatNumber(p.saves)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatNumber(p.shares)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {p.mediaType === "reels" || p.videoViews > 0
                              ? formatNumber(p.videoViews)
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                Stories performance · last 30 days
              </p>
              {recentStories.length === 0 ? (
                <p className="text-sm text-ink-tertiary">
                  No stories captured in the last 30 days. Stories expire 24h
                  after posting — the cron at <code>/api/social/sync-stories</code>{" "}
                  runs every 2 hours to catch them.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className="ht-table w-full text-left text-sm">
                    <thead className="bg-card text-xs uppercase tracking-wide text-ink-tertiary">
                      <tr>
                        <th className="px-4 py-2 font-medium">Story</th>
                        <th className="px-4 py-2 text-right font-medium">Reach</th>
                        <th className="px-4 py-2 text-right font-medium">Impressions</th>
                        <th className="px-4 py-2 text-right font-medium">Taps fwd</th>
                        <th className="px-4 py-2 text-right font-medium">Exits</th>
                        <th className="px-4 py-2 text-right font-medium">Replies</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentStories.map((s) => (
                        <tr key={s.storyId} className="border-t border-line">
                          <td className="px-4 py-2">
                            <span className="text-xs capitalize text-ink-tertiary">
                              {s.mediaType ?? "story"}
                            </span>
                            {s.postedAt && (
                              <span className="block text-xs text-ink-tertiary">
                                {new Date(s.postedAt).toLocaleString()}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatNumber(s.reach)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {formatNumber(s.impressions)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {formatNumber(s.tapsForward)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{formatNumber(s.exits)}</td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {formatNumber(s.replies)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </SectionCard>

      {/* Section 6 — Website Traffic (Google Analytics 4, OAuth) */}
      <Ga4WebsiteTraffic data={ga4Dashboard} hotelId={hotel.id} />

      {/* Contact Agency — bottom of the hotel-facing dashboard. Shows the agency
          that OWNS this hotel (member.agency). Edit link for admins only. */}
      <ContactAgencyCard
        agencyName={member.agency.name}
        contact={member.agency}
        canEdit={member.role === "admin"}
        viewerIsAgency
      />

      {/* Shareable read-only dashboard link for the hotel owner */}
      <SectionCard
        title="Share with hotel"
        subtitle="A private, read-only dashboard the hotel owner can open on any browser — no login required. They only ever see this hotel's data."
      >
        <HotelShareManager
          hotelId={hotel.id}
          hotelName={hotel.name}
          agencyName={member.agency.name}
          contactEmail={hotel.contactEmail}
          shareUrl={shareUrl}
          createdAt={hotel.shareTokenCreatedAt?.toISOString() ?? null}
          revoked={hotel.shareTokenRevoked}
          showAdSpend={hotel.showAdSpendToHotel}
          access={shareAccess}
        />
      </SectionCard>

      {/* Danger Zone — admins only. Analysts never see it (UX); the action
          re-checks the role server-side regardless. */}
      {member.role === "admin" && (
        <DeleteHotelDangerZone hotelId={hotel.id} hotelName={hotel.name} />
      )}
    </div>
  );
}
