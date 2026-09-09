"use client";

import { CHART_TOOLTIP } from "@/lib/chart-theme";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency, formatNumber } from "@/lib/format";
import {
  SOURCE_TYPES,
  SOURCE_TYPE_LABEL,
  type SourceType,
} from "@/lib/source-classifier";
import { SHARE_TOKEN_HEADER } from "@/lib/share-token";
import type { Granularity, RevenueBySource as RbsData } from "@/lib/revenue-by-source";

// Revenue by Source (Part 4) — per-hotel section. Client-fetches the
// /api/agency/hotels/[hotelId]/revenue-by-source endpoint so the granularity
// toggle, date range, and source-type chips update without a full page reload.

const SOURCE_TYPE_COLOR: Record<SourceType, string> = {
  meta_ads: "#3b82f6",
  google_ads: "#ef4444",
  google_hotel_ads: "#f97316",
  ai_assistant: "#0ea5e9",
  instagram_organic: "#ec4899",
  facebook_organic: "#6366f1",
  influencer: "#f59e0b",
  email: "#14b8a6",
  whatsapp: "#22c55e",
  direct: "#9ca3af",
  other: "#8b5cf6",
};

const GRAN_LABEL: Record<Granularity, string> = {
  source: "Source",
  source_medium: "Source + Medium",
  source_medium_campaign: "Source + Medium + Campaign",
};

const RANGES = [
  { key: "7", label: "7d" },
  { key: "30", label: "30d" },
  { key: "90", label: "90d" },
];

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

// Tiny inline SVG sparkline (no per-row Recharts — too heavy for a table).
function Sparkline({ data, color }: { data: number[]; color: string }) {
  const w = 72;
  const h = 22;
  if (!data.length) return <span className="text-ink-tertiary">—</span>;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible" aria-hidden>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function TypeBadge({ type }: { type: SourceType }) {
  const color = SOURCE_TYPE_COLOR[type];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ backgroundColor: `${color}22`, color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {SOURCE_TYPE_LABEL[type]}
    </span>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-line p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-ink-tertiary">{hint}</p>}
    </div>
  );
}

export function RevenueBySource({
  hotelId,
  apiBase = "/api/agency/hotels",
  shareToken,
  from,
  to,
}: {
  hotelId: string;
  apiBase?: string;
  /**
   * The page's selected range (YYYY-MM-DD). When supplied this panel FOLLOWS it
   * and hides its own toggle, so the dashboard has one date context. Omitted →
   * the panel keeps its own control (standalone use).
   */
  from?: string;
  to?: string;
  /** When set, the request is a public share-link read (sends the token header). */
  shareToken?: string;
}) {
  const controlled = Boolean(from && to);
  const [granularity, setGranularity] = useState<Granularity>("source");
  const [rangeKey, setRangeKey] = useState("30");
  const [selectedTypes, setSelectedTypes] = useState<Set<SourceType>>(new Set());
  const [data, setData] = useState<RbsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { startDate, endDate } = useMemo(() => {
    if (from && to) return { startDate: from, endDate: to };
    const end = new Date();
    const start = new Date(end.getTime() - Number(rangeKey) * 86_400_000);
    return { startDate: isoDay(start), endDate: isoDay(end) };
  }, [rangeKey, from, to]);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ granularity, startDate, endDate });
    if (selectedTypes.size > 0) params.set("sourceTypes", [...selectedTypes].join(","));
    try {
      const res = await fetch(
        `${apiBase}/${hotelId}/revenue-by-source?${params.toString()}`,
        { signal: ctrl.signal, headers: shareToken ? { [SHARE_TOKEN_HEADER]: shareToken } : undefined },
      );
      if (!res.ok) {
        setData(null);
        setError(res.status === 404 ? "Hotel not found." : "Could not load revenue data.");
        return;
      }
      setData((await res.json()) as RbsData);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError("Could not load revenue data.");
    } finally {
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, [hotelId, granularity, startDate, endDate, selectedTypes, apiBase, shareToken]);

  useEffect(() => {
    // Legitimate data-fetch-on-change effect: load() sets loading/error/data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const toggleType = (t: SourceType) =>
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  // Daily stacked-bar data: one row per day, a numeric field per source type.
  const chartData = useMemo(() => {
    if (!data) return [];
    return data.daily.map((d) => {
      const row: Record<string, number | string> = { date: d.date.slice(5) }; // MM-DD
      for (const t of SOURCE_TYPES) row[t] = d.byType[t] ?? 0;
      return row;
    });
  }, [data]);
  // Only stack source types that actually have revenue in the period.
  const activeTypes = useMemo(() => {
    if (!data) return [] as SourceType[];
    return SOURCE_TYPES.filter((t) => data.daily.some((d) => (d.byType[t] ?? 0) > 0));
  }, [data]);

  const totals = data?.totals;
  const top = data?.topSource;

  return (
    <div className="space-y-5">
      {/* KPI cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Total revenue" value={totals ? formatCurrency(totals.revenue, { compact: true }) : "—"} hint={totals ? formatCurrency(totals.revenue) : undefined} />
        <Kpi label="Total bookings" value={totals ? formatNumber(totals.bookings) : "—"} />
        <Kpi label="Avg booking value" value={totals && totals.bookings > 0 ? formatCurrency(Math.round(totals.averageBookingValue)) : "—"} />
        <Kpi
          label="Top source"
          value={top ? top.key : "—"}
          hint={top ? `${formatCurrency(top.revenue, { compact: true })} · ${pct(top.percentOfTotal)} of total` : undefined}
        />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Granularity toggle */}
        <div className="inline-flex overflow-hidden rounded-lg border border-line-strong">
          {(Object.keys(GRAN_LABEL) as Granularity[]).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGranularity(g)}
              className={`px-3 py-1.5 text-sm font-medium ${
                granularity === g ? "bg-brand text-white" : "bg-page text-ink-secondary hover:bg-elevated"
              }`}
            >
              {GRAN_LABEL[g]}
            </button>
          ))}
        </div>
        {/* Date range — hidden when the page selector is authoritative. */}
        {controlled ? (
          <p className="text-xs text-ink-tertiary">
            {startDate} → {endDate}
          </p>
        ) : (
          <div className="inline-flex overflow-hidden rounded-lg border border-line-strong">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRangeKey(r.key)}
                className={`px-3 py-1.5 text-sm font-medium ${
                  rangeKey === r.key ? "bg-brand text-white" : "bg-page text-ink-secondary hover:bg-elevated"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Source-type chips */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setSelectedTypes(new Set())}
          className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
            selectedTypes.size === 0 ? "border-brand bg-brand/15 text-brand" : "border-line-strong text-ink-secondary hover:bg-elevated"
          }`}
        >
          All
        </button>
        {SOURCE_TYPES.map((t) => {
          const on = selectedTypes.has(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => toggleType(t)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                on ? "text-ink" : "border-line-strong text-ink-secondary hover:bg-elevated"
              }`}
              style={on ? { borderColor: SOURCE_TYPE_COLOR[t], backgroundColor: `${SOURCE_TYPE_COLOR[t]}22` } : undefined}
            >
              {SOURCE_TYPE_LABEL[t]}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-card border border-line bg-card px-4 py-6 text-center text-sm text-danger">{error}</div>
      )}

      {!error && data && data.totals.bookings === 0 && (
        <div className="rounded-card border border-line bg-card px-4 py-10 text-center text-sm text-ink-tertiary">
          No bookings recorded in this date range. Make sure your tracking snippet is installed
          and visitors are completing bookings.
        </div>
      )}

      {!error && data && data.totals.bookings > 0 && (
        <>
          {/* Table */}
          <div className={`overflow-x-auto rounded-card border border-line ${loading ? "opacity-60" : ""}`}>
            <table className="ht-table w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-tertiary">
                  <th className="px-4 py-2 font-medium">{GRAN_LABEL[granularity]}</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 text-right font-medium">Bookings</th>
                  <th className="px-4 py-2 text-right font-medium">Revenue</th>
                  <th className="px-4 py-2 text-right font-medium">Avg value</th>
                  <th className="px-4 py-2 text-right font-medium">% of total</th>
                  <th className="px-4 py-2 text-right font-medium">Trend</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((g) => (
                  <tr key={g.key} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-2.5">
                      <code className="text-xs text-ink-secondary">{g.key}</code>
                    </td>
                    <td className="px-4 py-2.5"><TypeBadge type={g.sourceType} /></td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(g.bookings)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium" title={formatCurrency(g.revenue)}>
                      {formatCurrency(g.revenue, { compact: true })}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">
                      {formatCurrency(Math.round(g.averageBookingValue))}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{pct(g.percentOfTotal)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end">
                        <Sparkline data={g.sparkline} color={SOURCE_TYPE_COLOR[g.sourceType]} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.truncated && (
            <p className="text-xs text-ink-tertiary">
              Showing the top {data.groups.length} of {formatNumber(data.distinctGroups)} source combinations by revenue.
            </p>
          )}

          {/* Daily revenue by source type — stacked bars */}
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
              Daily revenue by source type
            </p>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#9ca3af" }} tickLine={false} axisLine={{ stroke: "#1f2937" }} minTickGap={20} />
                  <YAxis tickFormatter={(v: number) => formatCurrency(v, { compact: true })} tick={{ fontSize: 11, fill: "#9ca3af" }} tickLine={false} axisLine={false} width={56} />
                  <Tooltip
                    formatter={(value, name) => [formatCurrency(Number(value) || 0), SOURCE_TYPE_LABEL[name as SourceType] ?? String(name)] as [string, string]}
                    contentStyle={CHART_TOOLTIP}
                  />
                  {activeTypes.map((t) => (
                    <Bar key={t} dataKey={t} stackId="rev" fill={SOURCE_TYPE_COLOR[t]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}

      {loading && !data && (
        <div className="rounded-card border border-line bg-card px-4 py-10 text-center text-sm text-ink-tertiary">
          Loading revenue…
        </div>
      )}
    </div>
  );
}
