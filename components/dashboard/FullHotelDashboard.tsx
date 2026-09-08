import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { agencyScoped, runWithAgencyScope } from "@/lib/tenant";
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
import { PostTypeFilter } from "@/app/(agency)/agency/(app)/hotel/[id]/PostTypeFilter";
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
  type CampaignDay,
} from "@/lib/campaign-attribution";
import { SpendChart } from "@/components/report/SpendChart";
import { FollowerChart } from "@/components/report/FollowerChart";
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
import { loadHotelStates, snippetState } from "@/lib/integration-status";
import { trackingHealth } from "@/lib/data-health";
import { DataHealthBanner } from "@/components/dashboard/DataHealthBanner";
import { missingAdDays } from "@/lib/backfill";
import { computeFunnel, stageRank, STAGE_LABEL } from "@/lib/funnel";
import { RevenueBySource } from "@/components/dashboard/RevenueBySource";
import { CommissionSavings } from "@/components/dashboard/CommissionSavings";
import { OwnerSummaryCard } from "@/components/dashboard/OwnerSummaryCard";
import { PerformanceOverview } from "@/components/dashboard/PerformanceOverview";
import { loadInfluencerPerformance } from "@/lib/influencer-dashboard";
import { InfluencerPerformance } from "@/components/dashboard/InfluencerPerformance";
import { ContactAgencyCard } from "@/components/agency/ContactAgencyCard";
import { ChannelSelector } from "@/components/dashboard/ChannelSelector";
import { SourceSelector } from "@/components/dashboard/SourceSelector";
import { isDashboardSource, type DashboardSource } from "@/lib/dashboard-sources";
import { loadSummaryDashboard } from "@/lib/metrics/summary-dashboard";
import { AttributionHealthPanel } from "@/components/dashboard/summary/AttributionHealthPanel";
import { CustomerJourneyFunnel } from "@/components/dashboard/summary/CustomerJourneyFunnel";
import { CustomerIntentPanel } from "@/components/dashboard/summary/CustomerIntentPanel";
import { PaidPerformanceTable } from "@/components/dashboard/paid/PaidPerformanceTable";
import {
  loadMetaPaidPerformance,
  loadGooglePaidPerformance,
} from "@/lib/metrics/paid-performance";
import { AvailableFundsCard } from "@/components/dashboard/funds/AvailableFundsCard";
import { loadAdFunds } from "@/lib/metrics/funds";
import { SocialContentTable } from "@/components/dashboard/social/SocialContentTable";
import { loadSocialPerformance } from "@/lib/metrics/social-performance";
import { ChannelView } from "@/components/dashboard/ChannelView";
import { isChannelKey, type ChannelKey } from "@/lib/channel-view";
import { getSpendByPlatformFor } from "@/lib/ad-spend";
import { isPixelMode } from "@/lib/tracking-mode";

const POST_TYPES = ["image", "video", "carousel", "reels"] as const;
type PostType = (typeof POST_TYPES)[number];
const DAY_MS = 86_400_000;

// ──────────────────────────────────────────────────────────────────────────────
// THE hotel dashboard - every metric, chart, table and panel, in one place.
//
// Rendered by TWO surfaces, which is the entire point:
//
//   - /agency/hotel/[id]   the agency's view, behind a Clerk session
//   - /share/[uuid]        the hotel's public report link, token only
//
// They used to be different code. The agency page grew twenty-odd panels while
// the share report kept five, so "what the hotel can see" drifted from "what the
// agency shows them" every time either side changed. One component makes that
// drift impossible: a panel added here appears on both surfaces, or on neither.
//
// WHAT DIFFERS BETWEEN THE TWO, and it is deliberately narrow:
//
//   - CONTROLS. `viewer === "agency"` gates every link into an agency-only page
//     (integrations, journeys, the Meta/Instagram connect CTAs) and nothing
//     else. A public URL must not offer a control its reader would be bounced
//     from, and must never offer a write.
//   - AD SPEND. `showAdSpend` carries the hotel's showAdSpendToHotel flag on the
//     share path and is always true for the agency. When false, every spend
//     figure and everything spend can be divided out of is dropped BEFORE
//     render - not hidden with CSS, and not fetched into the payload.
//   - TENANCY. The agency path resolves the tenant from the session; the share
//     path wraps this component in runWithAgencyScope(agencyId, ...) with the id
//     read off the ShareLink row. Either way the SAME agencyScoped() queries
//     run, filtered by agencyId AND hotelClientId.
//
// The data-loading order and every computation below are unchanged from the
// agency page this was extracted from, so the two surfaces cannot report
// different numbers for the same hotel and range.
// ──────────────────────────────────────────────────────────────────────────────

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

export type FullHotelDashboardProps = {
  hotelId: string;
  /** Owning agency: from the session (agency) or the ShareLink row (share). */
  agencyId: string;
  agencyName: string;
  /** Drives the GA4 section's plan availability check. */
  agencyPlan: string;
  agencyContact: React.ComponentProps<typeof ContactAgencyCard>["contact"];
  /**
   * Which surface is rendering. Gates CONTROLS only, never data: a share reader
   * sees the same numbers, minus links into pages they cannot open.
   */
  viewer: "agency" | "share";
  /**
   * Whether ad spend and every spend-derived figure may render.
   *
   * Required rather than defaulted to true, so a caller that forgets it fails
   * CLOSED. The agency passes true; the share page passes showAdSpendToHotel.
   */
  showAdSpend: boolean;
  /** This surface's root, for in-dashboard links: "/agency/hotel/<id>" | "/share/<uuid>". */
  basePath: string;
  /** Where the channel deep-dive's back link goes. Defaults to basePath. */
  channelBackHref?: string;
  /** Label for that back link. */
  channelBackLabel?: string;
  /** API root for the client fetch components. */
  apiBase: string;
  /** Present only on the share link; sent as the share-token header. */
  shareToken?: string;
  rangeParam?: string;
  fromParam?: string;
  toParam?: string;
  postTypeParam?: string;
  channelParam?: string;
  /**
   * The top-level view: summary | website | meta_ads | google_ads | socials.
   *
   * Distinct from `channelParam`, which drives the older per-channel deep-dive.
   * Source is what the owner picks; it MAPS onto a channel for the paid and
   * social views rather than duplicating them.
   */
  sourceParam?: string;
  /** Agency-only: the edit affordance on the agency contact card. */
  canEditAgencyContact?: boolean;
  /** Rendered above the dashboard on the "all channels" view. */
  headerSlot?: React.ReactNode;
  /** Rendered below it (share-link manager, danger zone) - agency only. */
  footerSlot?: React.ReactNode;
};

/**
 * The share surface has NO Clerk session, so agencyScoped()'s session lookup
 * would throw for it. This wrapper installs the request-scoped agencyId (read
 * off the ShareLink row) around the body instead.
 *
 * It has to wrap the BODY rather than the JSX: `runWithAgencyScope(id, () =>
 * <Dashboard/>)` at the call site would only cover building the element, and
 * React awaits an async component's work afterwards — outside the store, where
 * every query would fall back to the session that isn't there.
 *
 * The agency path deliberately does NOT take the override: it keeps going
 * through requireAgencyId(), which is also what rejects a super-admin caller who
 * has no single-agency context.
 */
export async function FullHotelDashboard(props: FullHotelDashboardProps) {
  return props.viewer === "share"
    ? runWithAgencyScope(props.agencyId, () => renderDashboard(props))
    : renderDashboard(props);
}

async function renderDashboard({
  hotelId,
  agencyId,
  agencyName,
  agencyPlan,
  agencyContact,
  viewer,
  showAdSpend,
  basePath,
  channelBackHref,
  channelBackLabel = "← All channels",
  apiBase,
  shareToken,
  rangeParam,
  fromParam,
  toParam,
  postTypeParam,
  channelParam,
  sourceParam,
  canEditAgencyContact = false,
  headerSlot,
  footerSlot,
}: FullHotelDashboardProps) {
  const isAgencyViewer = viewer === "agency";
  /** Integrations-page href, or null on a surface that carries no agency controls. */
  const manageHref = isAgencyViewer ? `/agency/hotel/${hotelId}/integrations` : null;
  const pixelMode = isPixelMode();

  // Multi-tenant: scope by id AND agencyId so one agency can't open another's hotel.
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
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
      showAdSpendToHotel: true,
    },
  });
  if (!hotel) notFound();

  // Integration health for the "needs attention" banner (broken/expired only).
  const integrationStatus = await loadHotelStates({
    hotelId: hotel.id,
    snippetStatus: hotel.snippetStatus,
    lastEventAt: hotel.lastEventAt,
    plan: agencyPlan,
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
      : await missingAdDays(agencyId, hotel.id);

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
    agencyId,
    budgetTrackingEnabled: hotel.budgetTrackingEnabled,
    monthlyAdBudget: hotel.monthlyAdBudget,
    budgetResetDay: hotel.budgetResetDay,
  });

  const range = resolveRange({ range: rangeParam, from: fromParam, to: toParam });
  const postType: PostType | null =
    postTypeParam && (POST_TYPES as readonly string[]).includes(postTypeParam)
      ? (postTypeParam as PostType)
      : null;

  // Channel-filtered view (Channel-Filtered Dashboard). A specific channel skips
  // the heavy full-dashboard queries below entirely (PART 5) and renders the
  // channel deep-dive instead. "all" falls through to the existing comprehensive
  // dashboard, unchanged.
  const source: DashboardSource = isDashboardSource(sourceParam) ? sourceParam : "summary";

  // A chosen source maps onto the existing channel deep-dive rather than a second
  // implementation of it: ChannelView is already token-aware and already
  // spend-gated, so routing here inherits both.
  const SOURCE_TO_CHANNEL: Partial<Record<DashboardSource, ChannelKey>> = {
    meta_ads: "meta_ads",
    google_ads: "google_ads",
    socials: "instagram_organic",
  };
  const sourceChannel = SOURCE_TO_CHANNEL[source];

  const channel: ChannelKey = isChannelKey(channelParam)
    ? channelParam
    : (sourceChannel ?? "all");
  if (source === "website") {
    const [ga4, websiteSummary] = await Promise.all([
      loadGa4Dashboard({
        agencyId,
        hotelId,
        since: range.since,
        until: range.until,
        // The GA4-vs-HotelTrack cross-check belongs to the Summary view, where
        // both populations are on screen together; here it would be a stray
        // number with nothing to compare against.
        trackedSessions: null,
      }),
      loadSummaryDashboard(hotelId, range),
    ]);
    return (
      <div className="space-y-6">
        {headerSlot}
        <SourceSelector current={source} />
        <Ga4WebsiteTraffic data={ga4} manageHref={manageHref} />
        <CustomerIntentPanel
          comparisons={websiteSummary.comparisons}
          lastIntent={websiteSummary.lastIntent}
          rangeLabel={range.label}
        />
        <CustomerJourneyFunnel stages={websiteSummary.funnel} />
      </div>
    );
  }

  if (channel !== "all") {
    // The per-campaign table leads the paid views; ChannelView's charts and
    // creative breakdown follow it. Loaded only for the paid sources, so the
    // Instagram and Facebook deep-dives pay nothing for it.
    const paid =
      source === "meta_ads"
        ? await loadMetaPaidPerformance(hotelId, range, showAdSpend)
        : source === "google_ads"
          ? await loadGooglePaidPerformance(hotelId, range, showAdSpend)
          : null;

    // Socials leads with the format comparison, then ChannelView's per-post
    // detail below it — same shape as the paid views.
    const social = source === "socials" ? await loadSocialPerformance(hotelId, range) : null;

    return (
      <div className="space-y-6">
        {/* The source control travels WITH the deep-dive. A view you can enter
            but not leave is the most common way a dashboard traps its reader. */}
        <SourceSelector current={source} />
        {paid && <PaidPerformanceTable data={paid} />}
        {social && <SocialContentTable data={social} />}
        <div className="space-y-1">
          <Link
            href={channelBackHref ?? basePath}
            className="text-sm text-ink-tertiary hover:underline"
          >
            {channelBackLabel}
          </Link>
          <p className="text-sm text-ink-tertiary">{hotel.name}</p>
        </div>
        <ChannelView
          hotelId={hotelId}
          channel={channel}
          from={range.fromInput}
          to={range.toInput}
          currentRange={range.key}
          apiBase={apiBase}
          shareToken={shareToken}
          // A share reader gets the read-only variant: no "Connect Meta Ads"
          // button, no link-this-mention action - the same treatment the
          // logged-in hotel dashboard already gives a non-agency viewer.
          ownerView={!isAgencyViewer}
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
          utmSource: string | null;
          utmMedium: string | null;
          utmContent: string | null;
          utmCampaign: string | null;
          gclid: string | null; gbraid: string | null; wbraid: string | null; fbclid: string | null;
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
            // Phase 0: needed to classify paid vs non-paid revenue for ROAS.
            utmSource: true,
            utmMedium: true,
            utmContent: true,
            utmCampaign: true,
            gclid: true, gbraid: true, wbraid: true, fbclid: true,
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
  const [prevConversions, prevPaidSpend, websiteVisits, prevWebsiteVisits] = await Promise.all([
    pixelMode
      ? Promise.resolve([] as {
          utmSource: string | null;
          utmMedium: string | null;
          conversionValue: import("@prisma/client").Prisma.Decimal | null;
          gclid: string | null; gbraid: string | null; wbraid: string | null; fbclid: string | null;
        }[])
      : agencyScoped(prisma.trackingEvent).findMany({
          where: {
            hotelClientId: hotel.id,
            eventType: "conversion",
            createdAt: { gte: prevSince, lt: prevUntil },
          },
          // Phase 0: source/medium so the previous period is measured on the
          // SAME paid-only basis as the current one (else every delta is noise).
          select: { utmSource: true, utmMedium: true, conversionValue: true, gclid: true, gbraid: true, wbraid: true, fbclid: true, },
        }),
    getSpendByPlatformFor(agencyId, hotel.id, prevSince, prevUntil),
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
    agencyId,
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
    utmSource: e.utmSource,
    utmMedium: e.utmMedium,
    utmContent: e.utmContent,
    utmCampaign: e.utmCampaign,
    sessionId: e.sessionId,
    conversionValue: e.conversionValue == null ? null : Number(e.conversionValue),
    gclid: e.gclid, gbraid: e.gbraid, wbraid: e.wbraid, fbclid: e.fbclid,
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
  // Phase 0: KPIs divide by CANONICAL paid spend (Meta + Google) — `ads.spend`
  // is Meta-only and stays that way (it drives the Meta-reported block).
  const paidSpend = await getSpendByPlatformFor(agencyId, hotel.id, range.since, range.until);
  const kpis = computeKpis(eventInputs, paidSpend);
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
  //
  // showAdSpend also gates it: with no spend in, computeChannelPerformance
  // returns trueRoas: null for every row, so the figure cannot be recovered from
  // the payload even if a future caller forgets to hide the column.
  const spendBySource: Record<string, number> =
    showAdSpend && metaConnected && campaignTotalSpend > 0
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
  // Phase 0: run the previous period through the SAME computeKpis, so prevRoas /
  // prevCpb are paid-only exactly like the current period. Comparing a paid ROAS
  // against a blended one produced meaningless delta badges.
  const prevKpis = computeKpis(
    prevConversions.map((e) => ({
      eventType: "conversion" as const,
      utmSource: e.utmSource,
      utmMedium: e.utmMedium,
      utmContent: null,
      utmCampaign: null,
      sessionId: "",
      conversionValue: e.conversionValue == null ? null : Number(e.conversionValue),
      gclid: e.gclid, gbraid: e.gbraid, wbraid: e.wbraid, fbclid: e.fbclid,
    })),
    prevPaidSpend,
  );
  const prevRevenue = prevKpis.revenue;
  const prevBookings = prevKpis.bookings;
  const prevSpend = prevPaidSpend.total ?? 0;
  const prevRoas = prevKpis.roas;
  const prevAdr = prevBookings > 0 ? prevRevenue / prevBookings : null;
  const prevCpb = prevKpis.costPerBooking;
  // Fractional change vs previous; null when there's no prior baseline.
  const pctDelta = (cur: number | null, prev: number | null): number | null =>
    prev == null || prev === 0 || cur == null ? null : (cur - prev) / prev;

  // A paid figure is meaningful when EITHER paid platform is in play. Meta alone
  // used to gate these cards, which hid spend/ROAS from Google-only hotels.
  const paidConnected = metaConnected || paidSpend.google > 0;
  // Spell out what the combined spend is made of, so "Ad spend" is never read as
  // Meta-only again.
  const paidSpendHint =
    paidSpend.google > 0 && paidSpend.meta > 0
      ? `${formatCurrency(paidSpend.meta, { compact: true })} Meta · ${formatCurrency(paidSpend.google, { compact: true })} Google`
      : paidSpend.google > 0
        ? "Google Ads"
        : "Meta Ads";

  const adr = kpis.bookings > 0 ? kpis.revenue / kpis.bookings : null; // avg booking value
  const trueRoasColor =
    kpis.roas == null ? "text-ink" : kpis.roas > 4 ? "text-success" : kpis.roas >= 2 ? "text-warning" : "text-danger";

  // Cost/booking divides paid ad spend by *paid-attributed tracked* bookings, so
  // with only a handful of them the figure is meaningless (e.g. ₹7.6L / 2 =
  // ₹3.8L per booking). Suppress it until tracking coverage is high enough.
  // Phase 0: the reliability floor now counts PAID bookings — the denominator
  // actually used — not every booking including organic ones.
  const MIN_CPB_BOOKINGS = 10;
  const cpbReliable = kpis.costPerBooking != null && kpis.paidBookings >= MIN_CPB_BOOKINGS;

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
    // Spend and the two ratios built on it are SPLICED OUT, not greyed out:
    // "Ad spend —" next to a real ROAS still tells the reader the spend.
    ...(showAdSpend ? [{
      // Phase 0: combined PAID spend (Meta + Google), matching the ROAS
      // denominator. Null when currencies can't be safely combined.
      label: "Ad spend",
      value: paidConnected && kpis.spend != null ? formatCurrency(kpis.spend, { compact: true }) : "—",
      title: !paidConnected
        ? "Connect Meta or Google Ads to see this metric"
        : kpis.spend == null
          ? "Ad accounts report in different currencies — see each platform separately"
          : formatCurrency(kpis.spend),
      delta: paidConnected ? pctDelta(kpis.spend, prevSpend) : null,
      goodWhenUp: false,
      hint: paidConnected ? paidSpendHint : "No ad account connected",
    },
    {
      label: "True ROAS",
      value: paidConnected ? formatMultiple(kpis.roas) : "—",
      title: paidConnected ? undefined : "Connect Meta or Google Ads to see this metric",
      delta: paidConnected ? pctDelta(kpis.roas, prevRoas) : null,
      valueClassName: paidConnected ? trueRoasColor : undefined,
      hint: paidConnected ? "Paid-channel revenue ÷ paid ad spend" : "No ad account connected",
    }] satisfies KpiCardSpec[] : []),
    { label: "Bookings", value: formatNumber(kpis.bookings), delta: pctDelta(kpis.bookings, prevBookings) },
    {
      label: "ADR",
      value: adr == null ? "—" : formatCurrency(adr, { compact: true }),
      title: adr == null ? undefined : formatCurrency(adr),
      delta: pctDelta(adr, prevAdr),
      hint: "Avg booking value",
    },
    ...(showAdSpend ? [{
      label: "Cost / booking",
      value: paidConnected && cpbReliable ? formatCurrency(kpis.costPerBooking!, { compact: true }) : "—",
      title: !paidConnected
        ? "Connect Meta or Google Ads to see this metric"
        : cpbReliable
          ? formatCurrency(kpis.costPerBooking!)
          : undefined,
      delta: paidConnected && cpbReliable ? pctDelta(kpis.costPerBooking, prevCpb) : null,
      goodWhenUp: false,
      hint: !paidConnected
        ? "No ad account connected"
        : cpbReliable
          ? "Paid ad spend ÷ paid-attributed bookings"
          : `Needs ≥${MIN_CPB_BOOKINGS} paid-attributed bookings`,
    }] satisfies KpiCardSpec[] : []),
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

  // The same verdict the hotel sees on its own dashboard, computed from the same
  // inputs by the same function — so the agency is never looking at a healthy
  // page while its client is being told their tracking has stopped. The wording
  // differs (this audience can fix it); the judgement does not.
  const tracking = trackingHealth({
    snippet: snippetState(hotel.snippetStatus, hotel.lastEventAt),
    lastEventAt: hotel.lastEventAt,
    hasEventsInWindow: funnelHasData,
  });

  // Influencer Performance (Phase R2) — per-influencer redemptions + revenue for
  // this hotel over the selected range. Not pixel-gated (coupon redemptions exist
  // independently of snippet/Pixel mode, incl. manual entries).
  const influencerPerformance = await loadInfluencerPerformance(hotel.id, {
    since: range.since,
    until: range.until,
  });

  // Intent, attribution health, the journey funnel and the period comparison —
  // one service call rather than four screens each loading their own slice.
  const summary = await loadSummaryDashboard(hotel.id, range);

  // Advertising funds + the low-balance reminder. Gated on showAdSpend: a funds
  // balance IS a spend figure, so a report withholding costs must withhold this
  // too rather than leaking the same information under a different heading.
  const funds = showAdSpend ? await loadAdFunds(hotel.id) : null;

  return (
    <div className="space-y-6">
      {headerSlot}

      {/* Backfill nudge. Agency-only: reconnecting Meta is their action, on a
          page the hotel cannot open. It lives here rather than in the header
          slot because missingDays is computed from integrationStatus above. */}
      {isAgencyViewer && missingDays > 0 && (
        <Link
          href={`/agency/hotel/${hotel.id}/integrations`}
          className="inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-1 text-xs font-medium text-warning ring-1 ring-warning/30 hover:bg-warning/25"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-warning" />
          {missingDays} day{missingDays === 1 ? "" : "s"} of data missing — reconnect Meta to backfill
        </Link>
      )}

      {/* The primary control. The older per-channel pills stay beneath it for
          the channels Source does not cover (Facebook, Influencer, Direct,
          Other) rather than being deleted along with the navigation to them. */}
      <SourceSelector current={source} />

      {/* Channel selector — "All Channels" (this full dashboard) by default;
          pick a channel to switch to its deep-dive view. */}
      <ChannelSelector current="all" />


      {/* ── Summary: the journey, what visitors did, and how much of it we can
             actually account for. These lead because they answer "what is
             happening, and can I trust it" before any single metric does. ── */}
      <CustomerJourneyFunnel stages={summary.funnel} />

      <CustomerIntentPanel
        comparisons={summary.comparisons}
        lastIntent={summary.lastIntent}
        rangeLabel={range.label}
      />

      <AttributionHealthPanel health={summary.attribution} />

      {funds && (
        <AvailableFundsCard funds={funds} hotelId={hotel.id} shareToken={shareToken} />
      )}

      {/* Owner Summary — glanceable plain-English read of recent performance,
          at the very top of the dashboard (above all sections). */}
      <OwnerSummaryCard
        hotelId={hotel.id}
        pageRangeKey={range.key}
        apiBase={apiBase}
        shareToken={shareToken}
      />

      {/* Performance Overview (Tier A) — 10 owner-overview metrics over the same
          date range as the page. Read-only on existing data; sits between the
          Owner Summary and Revenue by Source. */}
      <PerformanceOverview
        hotelId={hotel.id}
        from={range.fromInput}
        to={range.toInput}
        apiBase={apiBase}
        shareToken={shareToken}
      />

      {/* Integration status badges — click any to manage that integration */}
      <IntegrationBadges
        manageHref={manageHref}
        items={[
          { name: "Meta Ads", state: tokenBadge(integrationStatus.meta) },
          { name: "Instagram", state: tokenBadge(integrationStatus.instagram) },
          { name: "GA4", state: ga4Dashboard.connected ? "connected" : "disconnected" },
        ]}
      />

      {/* Tracking health — the snippet is the source of every visit, booking and
          revenue figure below, so its state is reported before the integrations
          that only feed part of the picture. */}
      <DataHealthBanner
        health={tracking}
        audience={isAgencyViewer ? "agency" : "hotel"}
        agencyName={agencyName}
      />

      {/* Integration health banner — only when something is broken or expired, and
          only for the agency: it is a call to action on a page the hotel cannot
          open. The hotel is told about tracking gaps by DataHealthBanner above,
          which is written for that audience. */}
      {isAgencyViewer && integrationStatus.anyBrokenOrExpired && (
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

      {/* Budget Status card (only when budget tracking is enabled). Gated on
          showAdSpend too: a monthly ad budget and its spend-to-date are exactly
          the figures the flag exists to withhold. */}
      {budgetStatus && showAdSpend && (
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
          <AttributionPanel byModel={channelByModel} showRoas={showAdSpend} />
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
            ? isAgencyViewer
              ? `Meta ad account ${hotel.metaAdAccountId}`
              : "Meta Ads"
            : isAgencyViewer
              ? "No Meta ad account mapped — map one in Settings to sync ad data."
              : "No Meta ad account is mapped to this hotel yet."
        }
      >
        {!metaConnected ? (
          <IntegrationEmptyState
            manageHref={manageHref}
            title="Meta Ads not connected"
            body={
              isAgencyViewer
                ? "Connect Meta to see ad spend, campaign performance, and ROAS."
                : "Your agency hasn't connected a Meta ad account for this hotel yet."
            }
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
        <div
          className={`grid gap-px border-b border-line bg-line ${
            showAdSpend ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-1"
          }`}
        >
          {showAdSpend && (
            <div className="bg-card p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                Meta ad spend
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {formatCurrency(ads.spend)}
              </p>
            </div>
          )}
          <div className="bg-card p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
              Bookings from ads
            </p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {formatNumber(ads.bookingsFromAds)}
            </p>
            <p className="mt-0.5 text-xs text-ink-tertiary">Meta-reported</p>
          </div>
          {showAdSpend && (
            <div className="bg-card p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                Meta ROAS
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {formatMultiple(ads.metaRoas)}
              </p>
              <p className="mt-0.5 text-xs text-ink-tertiary">Platform-reported</p>
            </div>
          )}
          {showAdSpend && !pixelMode && (
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

        {showAdSpend && (
          <div className="p-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
              Spend over time
            </p>
            <SpendChart data={ads.spendOverTime} />
          </div>
        )}

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
          Hidden entirely when Meta is disconnected, and when spend is withheld:
          the table is per-campaign spend and ROAS, so there is no useful subset
          of it left once those are gone. */}
      {metaConnected && showAdSpend && (
      <SectionCard
        title="Meta Campaign Breakdown"
        subtitle="Meta-reported (raw from Facebook). For verified booking attribution, see the Campaign Performance section below."
      >
        {metaCampaignRows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-tertiary">
            {hotel.metaAdAccountId
              ? "No Meta campaign data for this range yet — runs after the next ad sync."
              : isAgencyViewer
                ? "No Meta ad account mapped — map one in Settings to pull campaign data."
                : "No Meta ad account is mapped to this hotel yet."}
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
          subtitle={
            showAdSpend
              ? "Each Meta campaign's spend joined to the bookings our snippet actually tracked on the hotel's website — what Meta claims vs what really happened."
              : "The bookings our snippet actually tracked on the website, joined back to the campaign that drove them."
          }
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
              {showAdSpend && (
                <div className="p-4">
                  <CampaignGrid cards={campaignCards} />
                </div>
              )}
              {showAdSpend && (
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
              )}
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
                {isAgencyViewer && (
                  <Link
                    href={`/agency/hotel/${hotel.id}/journeys`}
                    className="text-xs font-medium text-brand hover:underline"
                  >
                    Full funnel analysis →
                  </Link>
                )}
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
              {isAgencyViewer && (
                <div className="border-t border-line px-4 py-3 text-sm">
                  <Link
                    href={`/agency/hotel/${hotel.id}/journeys`}
                    className="font-medium text-brand hover:underline"
                  >
                    View all journeys →
                  </Link>
                </div>
              )}
            </>
          )}
        </SectionCard>
      )}

      {/* Commission Saved vs OTAs (per-hotel) — direct-booking savings KPI + trend. */}
      <SectionCard
        title="Commission Saved vs OTAs"
        subtitle={
          isAgencyViewer
            ? "How much your direct (snippet-tracked) bookings saved vs paying OTA commission. Set the rate on the Integrations page."
            : "How much your direct (tracked) bookings saved versus paying OTA commission."
        }
      >
        <div className="p-4">
          <CommissionSavings
            hotelId={hotel.id}
            from={range.fromInput}
            to={range.toInput}
            apiBase={apiBase}
            shareToken={shareToken}
          />
        </div>
      </SectionCard>

      {/* Revenue by Source — how much booking revenue came from each marketing
          source, at three granularities. Client-fetched (toggles/date/chips). */}
      <SectionCard
        title="Revenue by Source"
        subtitle="Booking revenue and counts per marketing source, with source / medium / campaign drill-down."
      >
        <div className="p-4">
          <RevenueBySource
            hotelId={hotel.id}
            from={range.fromInput}
            to={range.toInput}
            apiBase={apiBase}
            shareToken={shareToken}
          />
        </div>
      </SectionCard>

      {/* Influencer Performance (Phase R2) — per-influencer coupon redemptions */}
      <SectionCard
        title="Influencer Performance"
        subtitle="Redemptions and attributed revenue per influencer, from coupon codes (snippet-captured or manually logged)."
      >
        <InfluencerPerformance rows={influencerPerformance} viewerIsAgency={isAgencyViewer} />
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
                  {showAdSpend && (
                    <th className="px-4 py-3 text-right font-medium">Cost / booking</th>
                  )}
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
                    {showAdSpend && (
                      <td className="px-4 py-3 text-right tabular-nums text-ink-disabled">
                        {r.costPerBooking == null
                          ? "—"
                          : formatCurrencyCents(r.costPerBooking)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {showAdSpend && (
              <p className="px-4 py-3 text-xs text-ink-tertiary">
                Cost / booking shows once influencer fees are tracked per
                collaboration.
              </p>
            )}
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
            manageHref={manageHref}
            title="Instagram not connected"
            body={
              isAgencyViewer
                ? "Connect Instagram to see organic reach, engagement, and post performance."
                : "Your agency hasn't connected this hotel's Instagram account yet."
            }
            cta="Connect Instagram"
          />
        ) : !hasSocialData ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-ink-tertiary">
              Instagram connected — run a sync from the Integrations page to pull
              reach, engagement, and posts.
            </p>
            {isAgencyViewer && (
              <Link
                href={`/agency/hotel/${hotel.id}/integrations`}
                className="mt-2 inline-block text-sm font-medium text-ink-secondary underline"
              >
                Go to Integrations →
              </Link>
            )}
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
      <Ga4WebsiteTraffic data={ga4Dashboard} manageHref={manageHref} />

      {/* Contact Agency — bottom of the dashboard. Shows the agency that OWNS
          this hotel. The edit link is agency-admin only; a hotel reading its own
          report gets the details read-only. */}
      <ContactAgencyCard
        agencyName={agencyName}
        contact={agencyContact}
        canEdit={canEditAgencyContact}
        viewerIsAgency={isAgencyViewer}
      />

      {footerSlot}
    </div>
  );
}
