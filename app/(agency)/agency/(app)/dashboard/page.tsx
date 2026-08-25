import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { SnippetStatusBadge } from "@/components/ui/SnippetStatusBadge";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { RevenueTrendChart } from "@/components/dashboard/RevenueTrendChart";
import { RevenueByHotelChart } from "@/components/dashboard/RevenueByHotelChart";
import { TrafficSourceChart } from "@/components/dashboard/TrafficSourceChart";
import { AgencyRevenueRollup } from "@/components/dashboard/AgencyRevenueRollup";
import { AgencySavings } from "@/components/dashboard/AgencySavings";
import { GlowCard } from "@/components/ui/spotlight-card";
import { isPixelMode } from "@/lib/tracking-mode";
import { getSpendByPlatformForHotels, safeRoas } from "@/lib/ad-spend";
import { classifySourceType, isPaidSourceType } from "@/lib/source-classifier";
import {
  formatCurrency,
  formatMultiple,
  formatNumber,
  formatPercent,
} from "@/lib/format";

const THIRTY_DAYS_MS = 30 * 86_400_000;

function formatLastSync(d: Date | null): string {
  if (!d) return "Never synced";
  return `Synced ${new Date(d).toLocaleDateString()}`;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const SOURCE_LABELS: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
};

const KPI_ACCENT = {
  zinc: { bar: "bg-ink-disabled", text: "text-ink-tertiary" },
  blue: { bar: "bg-brand", text: "text-info" },
  amber: { bar: "bg-warning", text: "text-warning" },
  emerald: { bar: "bg-success", text: "text-success" },
  violet: { bar: "bg-accent", text: "text-accent" },
} as const;
type Accent = keyof typeof KPI_ACCENT;

function KpiCard({
  label,
  value,
  delta,
  accent = "zinc",
}: {
  label: string;
  value: string;
  // Percentage change vs prior period (null = no prior data, undefined = don't render)
  delta?: number | null;
  accent?: Accent;
}) {
  const a = KPI_ACCENT[accent];
  const deltaPill =
    delta != null && Number.isFinite(delta) ? (
      <span
        className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${
          delta >= 0 ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
        }`}
      >
        {delta >= 0 ? "↑" : "↓"} {formatPercent(Math.abs(delta))}
      </span>
    ) : null;

  return (
    <GlowCard className="rounded-card border border-line bg-card p-5 shadow-card transition hover:-translate-y-0.5 hover:border-line-strong hover:shadow-card-hover">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${a.bar}`} aria-hidden />
          <p className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">
            {label}
          </p>
        </div>
        {deltaPill}
      </div>
      <p className="mt-3 text-2xl font-bold tabular-nums tracking-tight text-ink lg:text-3xl">
        {value}
      </p>
      {delta === null ? (
        <p className="mt-1 text-[11px] text-ink-disabled">No prior period</p>
      ) : delta != null && Number.isFinite(delta) ? (
        <p className="mt-1 text-[11px] text-ink-disabled">vs prior 30 days</p>
      ) : null}
    </GlowCard>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`overflow-hidden rounded-card border border-line bg-card shadow-card ${className ?? ""}`}
    >
      <div className="border-b border-line px-4 py-3">
        <h2 className="font-medium">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-ink-tertiary">{subtitle}</p>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

// Percent change. Null if there's no prior baseline (can't compute %).
function pctChange(current: number, prior: number): number | null {
  if (prior <= 0) return current > 0 ? null : 0;
  return (current - prior) / prior;
}

export default async function AgencyDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const member = await getCurrentMember();
  if (!member) redirect("/agency/onboarding");

  const sp = await searchParams;
  const deletedName = typeof sp.deleted === "string" ? sp.deleted : null;

  const pixelMode = isPixelMode();
  const now = new Date();
  const since = new Date(now.getTime() - THIRTY_DAYS_MS);
  const priorSince = new Date(now.getTime() - 2 * THIRTY_DAYS_MS);

  // Multi-tenant: everything scoped to this agency. In pixel mode we skip the
  // tracking-event queries entirely — those rows don't exist when the agency
  // uses FB Pixel instead of the HotelTrack snippet.
  const [hotels, events, priorEvents, priorConversions, hotelNameRows, recentJoins] =
    await Promise.all([
    agencyScoped(prisma.hotelClient).findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        websiteUrl: true,
        snippetStatus: true,
        lastSyncedAt: true,
      },
    }),
    pixelMode
      ? Promise.resolve([] as Array<{
          createdAt: Date;
          eventType: string;
          utmSource: string | null;
          utmMedium: string | null;
          utmContent: string | null;
          gclid: string | null; gbraid: string | null; wbraid: string | null; fbclid: string | null;
          conversionValue: import("@prisma/client").Prisma.Decimal | null;
          hotelClientId: string;
        }>)
      : agencyScoped(prisma.trackingEvent).findMany({
          where: { createdAt: { gte: since } },
          select: {
            createdAt: true,
            eventType: true,
            utmSource: true,
            // Phase 0: needed to classify paid vs non-paid revenue for ROAS.
            utmMedium: true,
            utmContent: true,
            gclid: true, gbraid: true, wbraid: true, fbclid: true,
            conversionValue: true,
            hotelClientId: true,
          },
        }),
    pixelMode
      ? Promise.resolve([] as Array<{
          eventType: string;
          hotelClientId: string;
          _count: { _all: number };
          _sum: { conversionValue: import("@prisma/client").Prisma.Decimal | null };
        }>)
      : agencyScoped(prisma.trackingEvent).groupBy({
          // hotelClientId is in the grouping so soft-deleted hotels can be
          // filtered out below — the same population the spend side uses.
          by: ["eventType", "hotelClientId"],
          where: { createdAt: { gte: priorSince, lt: since } },
          _count: { _all: true },
          _sum: { conversionValue: true },
        }),
    // Phase 0: prior-period conversions at ROW level, so the prior ROAS is
    // computed paid-only exactly like the current one. Comparing a paid ROAS
    // against a blended one makes the delta badge meaningless.
    pixelMode
      ? Promise.resolve([] as Array<{
          utmSource: string | null;
          utmMedium: string | null;
          utmContent: string | null;
          hotelClientId: string;
          gclid: string | null; gbraid: string | null; wbraid: string | null; fbclid: string | null;
          conversionValue: import("@prisma/client").Prisma.Decimal | null;
        }>)
      : agencyScoped(prisma.trackingEvent).findMany({
          where: { eventType: "conversion", createdAt: { gte: priorSince, lt: since } },
          select: {
            utmSource: true,
            utmMedium: true,
            utmContent: true,
            hotelClientId: true, // to exclude soft-deleted hotels, like the spend side
            gclid: true, gbraid: true, wbraid: true, fbclid: true,
            conversionValue: true,
          },
        }),
    agencyScoped(prisma.hotelClient).findMany({
      select: { id: true, name: true },
    }),
    // Hotels that self-signed-up in the last 7 days (Part 7 banner).
    agencyScoped(prisma.hotelInvite).findMany({
      where: { status: "COMPLETED", completedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } },
      orderBy: { completedAt: "desc" },
      select: { hotelClientId: true, hotelEmail: true },
    }),
  ]);

  // Phase 0: canonical PAID spend (Meta + Google) across this agency's hotels,
  // replacing the two Meta-only AdSnapshot aggregates this page used to run.
  // Needs `hotels`, so it follows the batch above rather than joining it.
  const dashboardHotelIds = hotels.map((h) => h.id);
  // The SAME hotel population must drive both sides of every ratio on this page.
  // `hotels` is agencyScoped, which excludes soft-deleted hotels; the event
  // queries above are agency-wide (TrackingEvent has no deletedAt), so their rows
  // are filtered to this set before ANY aggregation. Without it the ROAS
  // numerator counted a deleted hotel's bookings while the denominator no longer
  // counted its spend.
  const dashboardHotelIdSet = new Set(dashboardHotelIds);
  const [paidSpend, priorPaidSpend] = await Promise.all([
    getSpendByPlatformForHotels(member.agencyId, dashboardHotelIds, since, now),
    getSpendByPlatformForHotels(
      member.agencyId,
      dashboardHotelIds,
      priorSince,
      new Date(since.getTime() - 1),
    ),
  ]);

  // ── Aggregate the event stream in JS (one pass) ──
  type Metric = { visits: number; bookings: number; revenue: number };
  const blank = (): Metric => ({ visits: 0, bookings: 0, revenue: 0 });

  const perHotel = new Map<string, Metric>();
  const perSource = new Map<string, number>(); // visits by source
  const perDay = new Map<string, { revenue: number; bookings: number }>();
  // Phase 0: paid-attributed revenue is tracked alongside total revenue so the
  // agency ROAS KPI stops dividing ALL revenue by Meta-only spend.
  let paidRevenue = 0;

  for (const e of events) {
    // Soft-deleted hotels are excluded from `hotels`, so their events must be
    // excluded here too — see dashboardHotelIdSet above.
    if (!dashboardHotelIdSet.has(e.hotelClientId)) continue;
    const m = perHotel.get(e.hotelClientId) ?? blank();
    const day = ymd(e.createdAt);
    const dayRow = perDay.get(day) ?? { revenue: 0, bookings: 0 };
    if (e.eventType === "visit") {
      m.visits += 1;
      const src = e.utmSource ?? "direct";
      perSource.set(src, (perSource.get(src) ?? 0) + 1);
    } else {
      m.bookings += 1;
      const v = e.conversionValue == null ? 0 : Number(e.conversionValue);
      m.revenue += v;
      dayRow.bookings += 1;
      dayRow.revenue += v;
      if (isPaidSourceType(classifySourceType(e))) paidRevenue += v;
    }
    perHotel.set(e.hotelClientId, m);
    perDay.set(day, dayRow);
  }

  const totals = [...perHotel.values()].reduce(
    (acc, m) => ({
      visits: acc.visits + m.visits,
      bookings: acc.bookings + m.bookings,
      revenue: acc.revenue + m.revenue,
    }),
    blank(),
  );
  // Phase 0: combined paid spend, and PAID revenue ÷ paid spend. This KPI was
  // totals.revenue (every channel) ÷ Meta-only spend.
  //
  // `total` is NULL when the ad accounts report in currencies that cannot be
  // safely added. It is deliberately NOT coerced to 0 — "we can't combine these"
  // must never render as "₹0 spent". Every consumer below handles null.
  const totalSpend: number | null = paidSpend.total;
  const priorTotalSpend: number | null = priorPaidSpend.total;
  const roas = safeRoas(paidRevenue, totalSpend);
  const deltaSpend =
    totalSpend == null || priorTotalSpend == null ? null : pctChange(totalSpend, priorTotalSpend);

  // ── Prior period (for KPI deltas) ──
  const prior = blank();
  for (const g of priorEvents) {
    if (!dashboardHotelIdSet.has(g.hotelClientId)) continue; // same population as spend
    if (g.eventType === "visit") prior.visits += g._count._all;
    else {
      prior.bookings += g._count._all;
      prior.revenue += Number(g._sum.conversionValue ?? 0);
    }
  }
  const priorPaidRevenue = priorConversions.reduce(
    (sum, c) =>
      sum +
      (dashboardHotelIdSet.has(c.hotelClientId) &&
      isPaidSourceType(classifySourceType(c)) &&
      c.conversionValue != null
        ? Number(c.conversionValue)
        : 0),
    0,
  );
  const priorRoas = safeRoas(priorPaidRevenue, priorPaidSpend.total);

  const deltaVisits = pctChange(totals.visits, prior.visits);
  const deltaBookings = pctChange(totals.bookings, prior.bookings);
  const deltaRevenue = pctChange(totals.revenue, prior.revenue);
  const deltaRoas =
    roas == null || priorRoas == null ? undefined : pctChange(roas, priorRoas);

  // ── Build zero-filled daily series for the trend chart ──
  const dailySeries: { date: string; revenue: number; bookings: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const key = ymd(d);
    const row = perDay.get(key) ?? { revenue: 0, bookings: 0 };
    dailySeries.push({
      date: key,
      revenue: Number(row.revenue.toFixed(2)),
      bookings: row.bookings,
    });
  }

  // ── Revenue-by-hotel series ──
  const hotelNameById = new Map(hotelNameRows.map((h) => [h.id, h.name]));

  // Newly self-signed-up hotels (last 7 days) for the notification banner.
  const newlyJoined = recentJoins
    .filter((j): j is { hotelClientId: string; hotelEmail: string | null } => j.hotelClientId != null)
    .map((j) => ({ id: j.hotelClientId, name: hotelNameById.get(j.hotelClientId) ?? j.hotelEmail ?? "A new hotel" }));
  const hotelRevenue = [...perHotel.entries()]
    .map(([id, m]) => ({ hotel: hotelNameById.get(id) ?? "(unknown)", revenue: m.revenue }))
    .filter((r) => r.revenue > 0);

  // ── Traffic-source series (mapped to friendly labels) ──
  const sourceSeries = [...perSource.entries()].map(([src, visits]) => ({
    source: SOURCE_LABELS[src] ?? (src === "direct" ? "Direct" : src),
    visits,
  }));

  return (
    <div className="space-y-6">
      {deletedName && (
        <div className="rounded-lg border-l-4 border-success bg-success/10 p-3 text-sm text-ink-secondary">
          <span className="font-medium text-ink">{deletedName}</span> has been
          deleted. Data preserved.
        </div>
      )}
      {newlyJoined.map((h) => (
        <div key={h.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-l-4 border-info bg-info/10 p-3 text-sm text-ink-secondary">
          <span>
            New hotel joined: <span className="font-medium text-ink">{h.name}</span>.
          </span>
          <Link href={`/agency/hotel/${h.id}/integrations`} className="font-medium text-brand hover:underline">
            Configure their integrations →
          </Link>
        </div>
      ))}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {member.agency.name}
          </h1>
          <p className="mt-1 text-ink-tertiary">
            All hotel clients · last 30 days
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ExportMenu basePath="/api/agency/export" />
          <Link
            href="/agency/hotels/new"
            className="rounded-button bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover"
          >
            Add Hotel Client
          </Link>
        </div>
      </div>

      {/* Agency revenue rollup (Phase R3) — revenue across all hotels by source,
          with drill-down. Sits above the existing per-hotel summary + charts. */}
      <section>
        <div className="mb-3">
          <h2 className="text-lg font-semibold tracking-tight">Revenue across all hotels</h2>
          <p className="text-sm text-ink-tertiary">
            Total agency performance by source — click a source to see which hotels drive it, or a
            hotel to open its dashboard.
          </p>
        </div>
        <AgencyRevenueRollup hotels={hotels} />
      </section>

      {/* OTA commission savings across all hotels (Part 6) — KPI + per-hotel table
          + stacked monthly trend. Self-hides when the agency has no hotels. */}
      <section>
        <AgencySavings />
      </section>

      {/* Summary KPIs across all hotels */}
      {pixelMode ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <KpiCard label="Hotels" value={formatNumber(hotels.length)} accent="zinc" />
          <KpiCard
            label="Ad spend"
            value={totalSpend == null ? "—" : formatCurrency(totalSpend)}
            delta={deltaSpend}
            accent="violet"
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiCard label="Hotels" value={formatNumber(hotels.length)} accent="zinc" />
          <KpiCard
            label="Visits"
            value={formatNumber(totals.visits)}
            delta={deltaVisits}
            accent="blue"
          />
          <KpiCard
            label="Bookings"
            value={formatNumber(totals.bookings)}
            delta={deltaBookings}
            accent="amber"
          />
          <KpiCard
            label="Revenue"
            value={formatCurrency(totals.revenue)}
            delta={deltaRevenue}
            accent="emerald"
          />
          <KpiCard
            label="ROAS"
            value={formatMultiple(roas)}
            delta={deltaRoas}
            accent="violet"
          />
        </div>
      )}

      {/* Charts — only meaningful when the HotelTrack snippet is feeding events */}
      {!pixelMode && (
        <>
          <ChartCard
            title="Revenue & bookings"
            subtitle="Daily attributed revenue (area) and bookings (line) across all hotels"
          >
            <RevenueTrendChart data={dailySeries} />
          </ChartCard>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartCard
              title="Revenue by hotel"
              subtitle="Top hotels by attributed revenue (last 30 days)"
            >
              <RevenueByHotelChart data={hotelRevenue} />
            </ChartCard>
            <ChartCard
              title="Traffic by source"
              subtitle="Visits attributed to each platform via utm_source"
            >
              <TrafficSourceChart data={sourceSeries} />
            </ChartCard>
          </div>
        </>
      )}

      {pixelMode && (
        <div className="rounded-card border border-dashed border-line p-6 text-sm text-ink-tertiary">
          Per-content / per-source attribution is disabled in Facebook Pixel mode.
          The Pixel reports website conversions to Meta, not HotelTrack — open
          Meta Ads Manager for content-level breakdowns, and the{" "}
          <span className="font-medium">Paid ads performance</span> section on
          each hotel for Meta-reported ROAS.
        </div>
      )}

      {/* Hotel client grid */}
      <div>
        <h2 className="mb-3 font-medium">Hotel clients</h2>
        {hotels.length === 0 ? (
          <div className="rounded-card border border-dashed border-line p-12 text-center">
            <p className="text-ink-tertiary">
              No hotel clients yet.
            </p>
            <Link
              href="/agency/hotels/new"
              className="mt-4 inline-block rounded-button bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover"
            >
              Add your first hotel client
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {hotels.map((h) => {
              const m = perHotel.get(h.id) ?? blank();
              return (
                <Link
                  key={h.id}
                  href={`/agency/hotel/${h.id}`}
                  className="group rounded-card border border-line bg-card p-5 shadow-card transition hover:-translate-y-0.5 hover:border-line-strong hover:shadow-card-hover"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-medium group-hover:underline">
                        {h.name}
                      </h3>
                      <p className="truncate text-xs text-ink-tertiary">
                        {h.websiteUrl}
                      </p>
                    </div>
                    <SnippetStatusBadge status={h.snippetStatus} />
                  </div>

                  {!pixelMode && (
                    <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-4">
                      <div>
                        <p className="text-xs text-ink-tertiary">Visits</p>
                        <p className="text-lg font-semibold tabular-nums">
                          {formatNumber(m.visits)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-ink-tertiary">Bookings</p>
                        <p className="text-lg font-semibold tabular-nums">
                          {formatNumber(m.bookings)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-ink-tertiary">Revenue</p>
                        <p className="text-lg font-semibold tabular-nums">
                          {formatCurrency(m.revenue)}
                        </p>
                      </div>
                    </div>
                  )}

                  <p className={`text-xs text-ink-disabled ${pixelMode ? "mt-3" : "mt-3"}`}>
                    {formatLastSync(h.lastSyncedAt)}
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
