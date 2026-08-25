"use client";

import { CHART_TOOLTIP } from "@/lib/chart-theme";

import { useEffect, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency, formatMultiple, formatNumber } from "@/lib/format";
import { SOURCE_TYPE_LABEL, type SourceType } from "@/lib/source-classifier";
import { SHARE_TOKEN_HEADER } from "@/lib/share-token";
import { GlowCard } from "@/components/ui/spotlight-card";
import type { OwnerMetrics } from "@/lib/owner-metrics";

// Performance Overview (Tier A) — 10 owner-overview items added to the hotel
// dashboard between the Owner Summary and Revenue by Source. Client-fetches
// /api/agency/hotels/[id]/owner-metrics for the SAME date range the page is on
// (passed as from/to), so every card respects the dashboard's range selector.

// Same palette as RevenueBySource so source colors stay consistent across the page.
const SOURCE_COLOR: Record<SourceType, string> = {
  meta_ads: "#3b82f6",
  google_ads: "#ef4444",
  instagram_organic: "#ec4899",
  facebook_organic: "#6366f1",
  influencer: "#f59e0b",
  email: "#14b8a6",
  whatsapp: "#22c55e",
  direct: "#9ca3af",
  other: "#8b5cf6",
};

const NEW_COLOR = "#3b82f6"; // blue
const RETURNING_COLOR = "#22c55e"; // green
const DEVICE_COLOR: Record<string, string> = {
  Mobile: "#3b82f6",
  Desktop: "#22c55e",
  Tablet: "#f59e0b",
  Unknown: "#6b7280",
};

function InfoIcon({ text }: { text: string }) {
  return (
    <span
      className="group/info absolute right-3 top-3 cursor-help text-ink-tertiary"
      tabIndex={0}
      aria-label={text}
    >
      ⓘ
      <span className="pointer-events-none absolute right-0 top-6 z-20 hidden w-60 rounded-lg border border-line bg-elevated p-2.5 text-left text-xs font-normal normal-case leading-snug text-ink-secondary shadow-float group-hover/info:block group-focus/info:block">
        {text}
      </span>
    </span>
  );
}

function Card({
  label,
  info,
  children,
}: {
  label: string;
  info: string;
  children: React.ReactNode;
}) {
  return (
    <GlowCard className="relative rounded-card border border-line bg-card p-4">
      <p className="pr-6 text-xs font-medium uppercase tracking-wide text-ink-tertiary">{label}</p>
      <InfoIcon text={info} />
      {children}
    </GlowCard>
  );
}

function BigValue({ value, className }: { value: string; className?: string }) {
  return <p className={`mt-1 text-2xl font-semibold tabular-nums ${className ?? "text-ink"}`}>{value}</p>;
}

function Sub({ children }: { children: React.ReactNode }) {
  return <p className="mt-0.5 text-xs text-ink-tertiary">{children}</p>;
}

function ConnectAdsNote() {
  return (
    <p className="mt-1 text-xs text-warning">
      Connect Meta Ads or Google Ads to see spend and ROAS
    </p>
  );
}

function roasColor(roas: number | null): string {
  if (roas == null) return "text-ink";
  if (roas > 4) return "text-success";
  if (roas >= 2) return "text-warning";
  return "text-danger";
}

function pctOf(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

export function PerformanceOverview({
  hotelId,
  from,
  to,
  apiBase = "/api/agency/hotels",
  shareToken,
}: {
  hotelId: string;
  from: string;
  to: string;
  apiBase?: string;
  /** When set, the request is a public share-link read (sends the token header). */
  shareToken?: string;
}) {
  const [data, setData] = useState<OwnerMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(false);
    fetch(`${apiBase}/${hotelId}/owner-metrics?startDate=${from}&endDate=${to}`, {
      signal: ctrl.signal,
      headers: shareToken ? { [SHARE_TOKEN_HEADER]: shareToken } : undefined,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (abort.current === ctrl) setData(d as OwnerMetrics); })
      .catch((e) => { if ((e as Error).name !== "AbortError" && abort.current === ctrl) setError(true); })
      .finally(() => { if (abort.current === ctrl) setLoading(false); });
    return () => ctrl.abort();
  }, [hotelId, from, to, apiBase, shareToken]);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-medium text-ink">Performance Overview</h2>
        <p className="mt-0.5 text-sm text-ink-tertiary">
          Key marketing and engagement metrics for the selected period.
        </p>
      </div>

      {loading && !data ? (
        <OverviewSkeleton />
      ) : error || !data ? (
        <div className="rounded-card border border-line bg-card px-4 py-8 text-center text-sm text-ink-tertiary">
          Couldn&apos;t load performance metrics right now.
        </div>
      ) : (
        <Loaded data={data} loading={loading} />
      )}
    </section>
  );
}

function Loaded({ data, loading }: { data: OwnerMetrics; loading: boolean }) {
  const {
    marketingSpend,
    costPerBooking,
    roas,
    conversionRate,
    newVsReturning,
    deviceSplit,
    bounceRate,
    averageTimeOnSite,
    topCampaigns,
    bookingsBySource,
    meta,
  } = data;
  // Phase 0: gate on EITHER paid platform. Gating on Meta alone hid spend, ROAS
  // and cost/booking from hotels that run Google Ads only.
  const paidConnected = meta.paidConnected;

  return (
    <div className={`space-y-4 ${loading ? "opacity-60" : ""}`}>
      {/* Row 1 — 4 KPI cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* 1. Marketing Spend — Meta + Google. Phase 0: this card used to show a
            Meta-only figure labelled as the total across connected accounts, and
            said "Google Ads coming soon" while Google Ads was already syncing. */}
        <Card label="Marketing Spend" info="Total paid ad spend across connected ad accounts in this period (Meta Ads + Google Ads).">
          <BigValue
            value={
              marketingSpend.total == null ? "—" : formatCurrency(marketingSpend.total, { compact: true })
            }
          />
          {paidConnected ? (
            marketingSpend.mixedCurrency ? (
              <Sub>
                {formatCurrency(marketingSpend.meta, { compact: true })} Meta · {formatNumber(marketingSpend.google)} Google
                {" "}— accounts report in different currencies, so no combined total is shown
              </Sub>
            ) : (
              <Sub>
                {formatCurrency(marketingSpend.meta, { compact: true })} Meta · {formatCurrency(marketingSpend.google, { compact: true })} Google
              </Sub>
            )
          ) : (
            <ConnectAdsNote />
          )}
        </Card>

        {/* 2. Cost per Booking — paid spend ÷ PAID-attributed bookings. */}
        <Card label="Cost per Booking" info="Paid ad spend divided by the bookings attributed to paid channels (Meta Ads / Google Ads) in this period.">
          <BigValue
            value={
              paidConnected && costPerBooking.costPerBooking != null
                ? formatCurrency(costPerBooking.costPerBooking, { compact: true })
                : "—"
            }
          />
          {paidConnected ? (
            <Sub>
              {formatNumber(costPerBooking.paidBookings)} paid of {formatNumber(costPerBooking.bookings)} bookings
              {costPerBooking.totalSpend != null
                ? ` · ${formatCurrency(costPerBooking.totalSpend, { compact: true })} spend`
                : ""}
            </Sub>
          ) : (
            <ConnectAdsNote />
          )}
        </Card>

        {/* 3. ROAS — PAID revenue ÷ PAID spend. Phase 0: this was previously ALL
            booking revenue (direct, organic, influencer…) ÷ Meta-only spend. */}
        <Card label="ROAS" info="Return on ad spend — paid-channel revenue ÷ paid ad spend. Only revenue attributed to Meta Ads or Google Ads counts. Shown as “—” when there's no paid ad spend to divide by.">
          <BigValue value={paidConnected ? formatMultiple(roas.overall) : "—"} className={paidConnected ? roasColor(roas.overall) : undefined} />
          {paidConnected ? (
            <Sub>
              Meta: {formatMultiple(roas.meta)} · Google: {formatMultiple(roas.google)} ·{" "}
              {formatCurrency(roas.paidRevenue, { compact: true })} from ads
            </Sub>
          ) : (
            <ConnectAdsNote />
          )}
        </Card>

        {/* 4. Conversion Rate */}
        <Card label="Conversion Rate" info="Share of website visitor sessions that ended in a tracked booking.">
          <BigValue value={conversionRate.sessions > 0 ? `${conversionRate.conversionRate.toFixed(1)}%` : "—"} />
          <Sub>
            {formatNumber(conversionRate.bookings)} bookings from {formatNumber(conversionRate.sessions)} visitors
          </Sub>
        </Card>
      </div>

      {/* Row 2 — 4 stat cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* 5. New vs Returning */}
        <Card label="New vs Returning" info="Among ad-driven sessions, how many came from first-time visitors vs visitors seen before this period.">
          {newVsReturning.totalAdVisitors === 0 ? (
            <p className="mt-2 text-sm text-ink-tertiary">No ad-driven visitors</p>
          ) : (
            <div className="mt-2 space-y-2">
              <BarRow label="New" value={newVsReturning.newVisitors} pct={pctOf(newVsReturning.newVisitors, newVsReturning.totalAdVisitors)} color={NEW_COLOR} />
              <BarRow label="Returning" value={newVsReturning.returningVisitors} pct={pctOf(newVsReturning.returningVisitors, newVsReturning.totalAdVisitors)} color={RETURNING_COLOR} />
            </div>
          )}
          <Sub>{formatNumber(newVsReturning.totalAdVisitors)} visitors from ads</Sub>
        </Card>

        {/* 6. Device Split */}
        <Card label="Device Split" info="Sessions by device, from each session's first page view (mobile < 768px, tablet 768–1024px, desktop > 1024px).">
          <DeviceSplitBar split={deviceSplit} />
        </Card>

        {/* 7. Bounce Rate */}
        <Card label="Bounce Rate" info="Sessions with 1 page view and under 10 seconds on site, as a share of all sessions.">
          <BigValue value={bounceRate.totalSessions > 0 ? `${bounceRate.bounceRate.toFixed(1)}%` : "—"} />
          <Sub>
            {formatNumber(bounceRate.bouncedSessions)} of {formatNumber(bounceRate.totalSessions)} sessions bounced
          </Sub>
        </Card>

        {/* 8. Avg Time on Site */}
        <Card label="Avg Time on Site" info="Average session duration across sessions with recorded time on site.">
          <BigValue value={averageTimeOnSite.sessions > 0 ? averageTimeOnSite.averageFormatted : "—"} />
          <Sub>{formatNumber(averageTimeOnSite.sessions)} sessions analyzed</Sub>
        </Card>
      </div>

      {/* Row 3 — Top campaigns table */}
      <div className="relative overflow-hidden rounded-card border border-line bg-card">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="text-sm font-medium text-ink">Top 5 Campaigns</h3>
          <span className="text-xs text-ink-tertiary">by booking revenue</span>
        </div>
        {topCampaigns.campaigns.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-tertiary">
            No campaign data in this period. Make sure UTM parameters are set on ad links.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="ht-table w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink-tertiary">
                <tr>
                  <th className="px-4 py-2 font-medium">Campaign</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 text-right font-medium">Spend</th>
                  <th className="px-4 py-2 text-right font-medium">Revenue</th>
                  <th className="px-4 py-2 text-right font-medium">Bookings</th>
                  <th className="px-4 py-2 text-right font-medium">ROAS</th>
                  <th className="px-4 py-2 text-right font-medium">Cost/Booking</th>
                </tr>
              </thead>
              <tbody>
                {topCampaigns.campaigns.map((c) => (
                  <tr key={c.campaignName} className="border-t border-line">
                    <td className="max-w-[14rem] truncate px-4 py-2.5 font-medium text-ink" title={c.campaignName}>{c.campaignName}</td>
                    <td className="px-4 py-2.5"><SourceBadge source={c.source} /></td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">
                      {c.spend == null ? "—" : formatCurrency(c.spend, { compact: true })}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink" title={formatCurrency(c.revenue)}>
                      {formatCurrency(c.revenue, { compact: true })}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">{formatNumber(c.bookings)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">{formatMultiple(c.roas)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">
                      {c.costPerBooking == null ? "—" : formatCurrency(c.costPerBooking, { compact: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Row 4 — Bookings by source chart */}
      <div className="rounded-card border border-line bg-card">
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-sm font-medium text-ink">Bookings by Source</h3>
          <p className="mt-0.5 text-xs text-ink-tertiary">Booking revenue per marketing source this period.</p>
        </div>
        <div className="p-4">
          <BookingsBySourceChart data={bookingsBySource} />
        </div>
      </div>
    </div>
  );
}

function BarRow({ label, value, pct, color }: { label: string; value: number; pct: number; color: string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-ink-secondary">
        <span>{label}: {formatNumber(value)}</span>
        <span className="tabular-nums text-ink-tertiary">{pct.toFixed(0)}%</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-elevated">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

function DeviceSplitBar({ split }: { split: OwnerMetrics["deviceSplit"] }) {
  const segments = [
    { label: "Mobile", count: split.mobile },
    { label: "Desktop", count: split.desktop },
    { label: "Tablet", count: split.tablet },
    { label: "Unknown", count: split.unknown },
  ].filter((s) => s.count > 0);
  const total = segments.reduce((sum, s) => sum + s.count, 0);

  if (total === 0) {
    return <p className="mt-2 text-sm text-ink-tertiary">No data</p>;
  }
  return (
    <div className="mt-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-elevated">
        {segments.map((s) => (
          <div
            key={s.label}
            className="h-full"
            style={{ width: `${pctOf(s.count, total)}%`, backgroundColor: DEVICE_COLOR[s.label] }}
            title={`${s.label}: ${formatNumber(s.count)} (${pctOf(s.count, total).toFixed(0)}%)`}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-secondary">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5" title={`${formatNumber(s.count)} sessions`}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: DEVICE_COLOR[s.label] }} />
            {s.label} {pctOf(s.count, total).toFixed(0)}%
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourceBadge({ source }: { source: "meta" | "google" | "other" }) {
  const map = {
    meta: { label: "Meta", color: SOURCE_COLOR.meta_ads },
    google: { label: "Google", color: SOURCE_COLOR.google_ads },
    other: { label: "Other", color: SOURCE_COLOR.other },
  } as const;
  const { label, color } = map[source];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ backgroundColor: `${color}22`, color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function BookingsBySourceChart({ data }: { data: OwnerMetrics["bookingsBySource"] }) {
  if (data.totalBookings === 0) {
    return (
      <p className="py-8 text-center text-sm text-ink-tertiary">
        No bookings recorded in this period yet.
      </p>
    );
  }
  const rows = data.sources.map((s) => ({
    label: SOURCE_TYPE_LABEL[s.type],
    revenue: s.revenue,
    bookings: s.bookings,
    type: s.type,
  }));
  // Height grows with the number of bars so labels never crowd on mobile.
  const height = Math.max(140, rows.length * 38 + 16);

  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <XAxis type="number" tickFormatter={(v: number) => formatCurrency(v, { compact: true })} tick={{ fontSize: 11, fill: "#9ca3af" }} tickLine={false} axisLine={{ stroke: "#1f2937" }} />
          <YAxis type="category" dataKey="label" width={104} tick={{ fontSize: 11, fill: "#9ca3af" }} tickLine={false} axisLine={false} />
          <Tooltip
            cursor={{ fill: "#ffffff10" }}
            formatter={(value, _name, item) => {
              const p = (item as { payload?: { bookings: number; revenue: number } } | undefined)?.payload;
              const pct = pctOf(Number(value) || 0, data.totalRevenue);
              const bookings = p ? formatNumber(p.bookings) : "0";
              return [`${formatCurrency(Number(value) || 0)} · ${bookings} bookings · ${pct.toFixed(1)}% of revenue`, "Revenue"] as [string, string];
            }}
            contentStyle={CHART_TOOLTIP}
          />
          <Bar dataKey="revenue" radius={[0, 4, 4, 0]}>
            {rows.map((r) => (
              <Cell key={r.type} fill={SOURCE_COLOR[r.type]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-card border border-line bg-card" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-card border border-line bg-card" />
        ))}
      </div>
      <div className="h-40 animate-pulse rounded-card border border-line bg-card" />
    </div>
  );
}
