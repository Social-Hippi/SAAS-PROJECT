import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { agencyScoped, runWithAgencyScope } from "@/lib/tenant";
import { resolveRange } from "@/lib/attribution";
import { computeFunnel, stageRank, STAGE_LABEL } from "@/lib/funnel";
import { isChannelKey, type ChannelKey } from "@/lib/channel-view";
import { formatDuration, formatNumber, formatPercent } from "@/lib/format";
import { OwnerSummaryCard } from "@/components/dashboard/OwnerSummaryCard";
import { PerformanceOverview } from "@/components/dashboard/PerformanceOverview";
import { ChannelSelector } from "@/components/dashboard/ChannelSelector";
import { ChannelView } from "@/components/dashboard/ChannelView";
import { RevenueBySource } from "@/components/dashboard/RevenueBySource";
import { CommissionSavings } from "@/components/dashboard/CommissionSavings";
import { ContactAgencyCard } from "@/components/agency/ContactAgencyCard";
import { DataHealthBanner } from "@/components/dashboard/DataHealthBanner";
import { snippetState } from "@/lib/integration-status";
import { trackingHealth } from "@/lib/data-health";

// Shared, full-depth hotel dashboard body. Rendered IDENTICALLY by two surfaces:
//   • the logged-in hotel-owner dashboard (/hotel/[id]/dashboard) — Clerk auth
//   • the public share-link dashboard (/h/[shareToken]) — token auth
//
// Auth is a prop, not a baked-in assumption: callers pass `apiBase` ("/api/hotel")
// plus, for the share link, a `shareToken` that the client fetch components attach
// as the share-token header so the same read routes authorize either caller. The
// component itself never reads a Clerk session — the page above it has already
// resolved the hotel (by session or by token) and hands down only display data.
//
// Viewer-specific chrome (the editable hotel-details form, the link to People)
// is injected via `ownerSlot`. What a viewer may do is a capability question,
// and the PAGE is where capabilities were resolved — so the page composes that
// slot and this body asks no permission questions of its own.

const RANGE_PRESETS = [
  { key: "7", label: "7d" },
  { key: "30", label: "30d" },
  { key: "90", label: "90d" },
] as const;

function relTime(d: Date | null): string {
  if (!d) return "not synced yet";
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 60) return `${Math.max(0, mins)} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// Compact funnel + last-5 visitor journeys, server-rendered, scoped to this hotel
// via runWithAgencyScope. (Mirrors the agency dashboard's preview.)
async function loadJourneyPreview(
  agencyId: string,
  hotelId: string,
  since: Date,
  until: Date,
  includeVisitorRows: boolean,
) {
  return runWithAgencyScope(agencyId, async () => {
    const [funnelStageGroups, recentSessions] = await Promise.all([
      agencyScoped(prisma.session).groupBy({
        by: ["highestStageReached"],
        where: { hotelClientId: hotelId, startedAt: { gte: since, lte: until } },
        _count: { _all: true },
      }),
      // Skipped entirely without viewGuestDetails — the funnel below is derived
      // from the aggregate groupBy, so it is unaffected.
      includeVisitorRows
        ? agencyScoped(prisma.session).findMany({
            where: { hotelClientId: hotelId },
            orderBy: { startedAt: "desc" },
            take: 5,
            select: {
              id: true, visitorId: true, startedAt: true, totalTimeMs: true,
              pageViewCount: true, landingPath: true, exitPath: true,
            },
          })
        : [],
    ]);

    const reachedByRank: Record<number, number> = {};
    for (const g of funnelStageGroups) {
      const r = stageRank(g.highestStageReached);
      if (r > 0) reachedByRank[r] = (reachedByRank[r] ?? 0) + g._count._all;
    }
    const funnel = computeFunnel({ reachedByRank, revenue: 0 });

    const sessionIds = recentSessions.map((s) => s.id);
    const convertedSessionIds =
      sessionIds.length > 0
        ? new Set(
            (
              await agencyScoped(prisma.trackingEvent).findMany({
                where: { hotelClientId: hotelId, eventType: "conversion", sessionId: { in: sessionIds } },
                select: { sessionId: true },
              })
            ).map((r) => r.sessionId),
          )
        : new Set<string>();

    return { funnel, funnelHasData: (funnel.stages[0]?.visitors ?? 0) > 0, recentSessions, convertedSessionIds };
  });
}

export type HotelDashboardBodyProps = {
  hotelId: string;
  hotelName: string;
  agencyId: string;
  agencyName: string;
  snippetStatus: string;
  /**
   * Newest tracked event of any kind, ever. Null = nothing has ever arrived.
   *
   * Required rather than optional: it is what separates "installed but never
   * worked" from "worked, then went silent", and a caller that forgets it would
   * silently collapse those two into the reassuring one.
   */
  lastEventAt: Date | null;
  lastSyncedAt: Date | null;
  /** Agency contact details for the (read-only) ContactAgencyCard. */
  agencyContact: React.ComponentProps<typeof ContactAgencyCard>["contact"];
  /** Link base for in-dashboard navigation: "/hotel/<id>/dashboard" or "/h/<token>". */
  basePath: string;
  /** API base for the client fetch components. Both surfaces use "/api/hotel". */
  apiBase: string;
  /** Present only on the public share link; attached as the share-token header. */
  shareToken?: string;
  rangeParam?: string;
  fromParam?: string;
  toParam?: string;
  channelParam?: string;
  showRestrictedNotice?: boolean;
  /** Label for the back link from a channel deep-dive. */
  channelBackLabel?: string;
  /**
   * Whether this viewer holds the viewGuestDetails capability.
   *
   * Required, not defaulted: a default of `true` would silently show
   * visitor-level rows to any future caller that forgot the prop, which is the
   * failure mode worth making impossible. The funnel above the list stays
   * visible either way — it is aggregate counts, not individual visitors.
   */
  canViewGuestDetails: boolean;
  /**
   * Controls that only some viewers get — the editable hotel-details form, the
   * link to People. Composed by the page from the same capabilities its guards
   * used, so a rendered control and a permitted action can never disagree.
   */
  ownerSlot?: React.ReactNode;
};

export async function HotelDashboardBody({
  hotelId,
  hotelName,
  agencyId,
  agencyName,
  snippetStatus,
  lastEventAt,
  lastSyncedAt,
  agencyContact,
  basePath,
  apiBase,
  shareToken,
  rangeParam,
  fromParam,
  toParam,
  channelParam,
  showRestrictedNotice = false,
  channelBackLabel = "← Dashboard",
  canViewGuestDetails,
  ownerSlot,
}: HotelDashboardBodyProps) {
  const range = resolveRange({ range: rangeParam, from: fromParam, to: toParam });

  // ── Channel deep-dive view (Meta Ads / Instagram / Influencer / …) ──
  const channel: ChannelKey = isChannelKey(channelParam) ? channelParam : "all";
  if (channel !== "all") {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <Link href={basePath} className="text-sm text-ink-tertiary hover:underline">
            {channelBackLabel}
          </Link>
          <p className="text-sm text-ink-tertiary">{hotelName}</p>
        </div>
        <ChannelView
          hotelId={hotelId}
          channel={channel}
          from={range.fromInput}
          to={range.toInput}
          currentRange={range.key}
          apiBase={apiBase}
          shareToken={shareToken}
          ownerView
        />
      </div>
    );
  }

  // The capability decides what is FETCHED, not just what is painted. Loading
  // visitor rows and then hiding them would still put them in the HTML payload.
  const journey = await loadJourneyPreview(
    agencyId, hotelId, range.since, range.until, canViewGuestDetails,
  );

  // "Can I trust the numbers below?" — one verdict, from the signals the app
  // already records. Computed here rather than above because it needs to know
  // whether the window on screen contained any activity: a hotel that is still
  // sending visits but recorded nothing this week is a real zero, while one that
  // has gone silent for days is a measurement failure wearing the same "0".
  //
  // This replaces a test against the snippetStatus value "installed", which
  // nothing in the codebase ever writes (the tracker writes "live", alerts write
  // "error", the default is "not_installed"). Every hotel therefore failed it —
  // so a hotel whose tracking had worked for months was still being told, on
  // every load, to finish setting it up.
  const tracking = trackingHealth({
    snippet: snippetState(snippetStatus, lastEventAt),
    lastEventAt,
    hasEventsInWindow: journey.funnelHasData,
  });

  function rangeHref(key: string): string {
    return key === "30" ? basePath : `${basePath}?range=${key}`;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{hotelName}</h1>
          <p className="text-sm text-ink-tertiary">
            Managed by {agencyName} · last synced {relTime(lastSyncedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {RANGE_PRESETS.map((p) => (
            <Link
              key={p.key}
              href={rangeHref(p.key)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                range.key === p.key
                  ? "border-brand bg-brand text-white"
                  : "border-line-strong text-ink-secondary hover:bg-elevated"
              }`}
            >
              {p.label}
            </Link>
          ))}
        </div>
      </header>

      {showRestrictedNotice && (
        <div className="rounded-card border border-info/40 bg-info/10 px-4 py-3 text-sm text-ink-secondary sm:px-5">
          That area is managed by your agency and isn&apos;t available to hotel accounts. Here&apos;s your
          dashboard with everything for {hotelName}.
        </div>
      )}

      {/* Silent while tracking is healthy — including when a real zero is a real
          zero. It speaks up only when a figure below would otherwise be read as
          a business result when it is actually a measurement gap. */}
      <DataHealthBanner health={tracking} audience="hotel" agencyName={agencyName} />

      {/* Plain-English performance summary (own period toggle). */}
      <OwnerSummaryCard hotelId={hotelId} apiBase={apiBase} shareToken={shareToken} />

      {/* Full KPI set: marketing spend, cost/booking, ROAS, conversion rate,
          new-vs-returning, device split, bounce, time-on-site, top campaigns. */}
      <PerformanceOverview hotelId={hotelId} from={range.fromInput} to={range.toInput} apiBase={apiBase} shareToken={shareToken} />

      {/* Channel filter — pick a channel for its full deep-dive (Meta spend/CTR/
          CPC/CPM/campaigns, Instagram content, Facebook, Influencer, Direct, Other). */}
      <section className="space-y-2">
        <h2 className="font-medium text-ink">Channels</h2>
        <p className="text-sm text-ink-tertiary">Pick a channel to see its full performance breakdown.</p>
        <ChannelSelector current="all" />
      </section>

      {/* Revenue by Source — 3-way granularity (source / +medium / +campaign). */}
      <section className="overflow-hidden rounded-card border border-line bg-card">
        <div className="border-b border-line px-4 py-3 sm:px-5">
          <h2 className="font-medium text-ink">Revenue by Source</h2>
          <p className="mt-0.5 text-sm text-ink-tertiary">
            Booking revenue and counts per marketing source, with source / medium / campaign drill-down.
          </p>
        </div>
        <div className="p-4">
          <RevenueBySource hotelId={hotelId} apiBase={apiBase} shareToken={shareToken} />
        </div>
      </section>

      {/* Commission Saved vs OTAs — KPI + monthly trend. */}
      <section className="overflow-hidden rounded-card border border-line bg-card">
        <div className="border-b border-line px-4 py-3 sm:px-5">
          <h2 className="font-medium text-ink">Commission Saved vs OTAs</h2>
          <p className="mt-0.5 text-sm text-ink-tertiary">
            How much your direct (tracked) bookings saved versus paying OTA commission.
          </p>
        </div>
        <div className="p-4">
          <CommissionSavings hotelId={hotelId} apiBase={apiBase} shareToken={shareToken} />
        </div>
      </section>

      {/* Recent Visitor Journeys + funnel — page-by-page paths and drop-off. */}
      <section className="overflow-hidden rounded-card border border-line bg-card">
        <div className="border-b border-line px-4 py-3 sm:px-5">
          <h2 className="font-medium text-ink">
            {canViewGuestDetails ? "Recent Visitor Journeys" : "Visitor funnel"}
          </h2>
          <p className="mt-0.5 text-sm text-ink-tertiary">
            {canViewGuestDetails
              ? "The page-by-page path recent visitors took, with time on site and drop-off."
              : "How visitors move through your site, and where they drop off."}
          </p>
        </div>
        {journey.funnelHasData && (
          <div className={canViewGuestDetails ? "border-b border-line px-4 py-4" : "px-4 py-4"}>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
              Funnel · {range.label.toLowerCase()}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {journey.funnel.stages.map((st) => (
                <div key={st.stage} className="rounded-lg border border-line p-3">
                  <p className="text-xs text-ink-tertiary">{STAGE_LABEL[st.stage]}</p>
                  <p className="mt-0.5 text-lg font-semibold tabular-nums text-ink">{formatNumber(st.visitors)}</p>
                  <p className="text-xs text-ink-tertiary tabular-nums">
                    {st.conversionFromPrev == null ? "—" : formatPercent(st.conversionFromPrev)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
        {!canViewGuestDetails ? (
          // NOT the empty state. "No visitor journeys yet" would be a false
          // statement to someone whose role simply excludes them — there may be
          // thousands. Say which it is.
          <p className="px-4 py-6 text-sm text-ink-tertiary">
            Individual visitor journeys aren&apos;t part of your access level. The funnel above
            covers the same visitors in aggregate.
          </p>
        ) : journey.recentSessions.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-tertiary">
            No visitor journeys yet. They appear once your website is tracking visits.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {journey.recentSessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <code className="text-xs text-ink-tertiary">
                    {s.visitorId.length > 14 ? `${s.visitorId.slice(0, 14)}…` : s.visitorId}
                  </code>
                  {journey.convertedSessionIds.has(s.id) && (
                    <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-semibold text-success">
                      Converted
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-4 tabular-nums text-ink-secondary">
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
        )}
      </section>

      {/* Contact the managing agency. */}
      <ContactAgencyCard agencyName={agencyName} contact={agencyContact} canEdit={false} viewerIsAgency={false} />

      {/* Owner-only editable details (never rendered on the public share link). */}
      {ownerSlot}
    </div>
  );
}
