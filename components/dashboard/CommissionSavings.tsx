"use client";

import { CHART_TOOLTIP } from "@/lib/chart-theme";

import { useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatCurrency, formatNumber } from "@/lib/format";
import { SHARE_TOKEN_HEADER } from "@/lib/share-token";
import { GlowCard } from "@/components/ui/spotlight-card";

// Commission Saved vs OTAs (Part 5) — per-hotel. Shows the period's direct-booking
// savings (revenue × the hotel's OTA rate), a vs-previous delta, and a 12-month
// savings line trend. Client-fetches /api/agency/hotels/[id]/savings.

const MONEY_GREEN = "#16a34a";
const RANGES = [{ key: "7", label: "7d" }, { key: "30", label: "30d" }, { key: "90", label: "90d" }];

type MonthPoint = { month: string; revenue: number; savings: number; bookings: number };
type Data = {
  otaRateUsed: number;
  totalRevenue: number;
  totalSavings: number;
  bookingCount: number;
  previous: { totalSavings: number };
  monthlyTrend: MonthPoint[];
};

function isoDay(d: Date) { return d.toISOString().slice(0, 10); }
function monthLabel(m: string) { return new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" }); }

export function CommissionSavings({
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
   * and hides its own toggle — the dashboard has one date context, and a panel
   * silently showing a different window than the selector above it is how a
   * reader ends up comparing two periods without knowing.
   * Omitted (e.g. a standalone embed) → the panel keeps its own control.
   */
  from?: string;
  to?: string;
  /** When set, the request is a public share-link read (sends the token header). */
  shareToken?: string;
}) {
  const controlled = Boolean(from && to);
  const [rangeKey, setRangeKey] = useState("30");
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const abort = useRef<AbortController | null>(null);

  const { startDate, endDate } = useMemo(() => {
    if (from && to) return { startDate: from, endDate: to };
    const end = new Date();
    return { startDate: isoDay(new Date(end.getTime() - Number(rangeKey) * 86_400_000)), endDate: isoDay(end) };
  }, [rangeKey, from, to]);

  useEffect(() => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch(`${apiBase}/${hotelId}/savings?startDate=${startDate}&endDate=${endDate}`, {
      signal: ctrl.signal,
      headers: shareToken ? { [SHARE_TOKEN_HEADER]: shareToken } : undefined,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setData(d as Data); })
      .catch(() => {})
      .finally(() => { if (abort.current === ctrl) setLoading(false); });
    return () => ctrl.abort();
  }, [hotelId, startDate, endDate, apiBase, shareToken]);

  const delta = useMemo(() => {
    if (!data || data.previous.totalSavings <= 0) return null;
    return ((data.totalSavings - data.previous.totalSavings) / data.previous.totalSavings) * 100;
  }, [data]);

  const trendHasData = (data?.monthlyTrend ?? []).some((m) => m.savings > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {controlled ? (
          // Following the dashboard's range selector — no competing control, and
          // the window is stated so the number is never undated.
          <p className="text-xs text-ink-tertiary">
            {startDate} → {endDate}
          </p>
        ) : (
          <div className="inline-flex overflow-hidden rounded-lg border border-line-strong">
            {RANGES.map((r) => (
              <button key={r.key} type="button" onClick={() => setRangeKey(r.key)}
                className={`px-3 py-1.5 text-sm font-medium ${rangeKey === r.key ? "bg-brand text-white" : "bg-page text-ink-secondary hover:bg-elevated"}`}>{r.label}</button>
            ))}
          </div>
        )}
        <span className="group relative text-ink-tertiary" tabIndex={0} aria-label="How this is calculated">
          ⓘ
          <span className="pointer-events-none absolute right-0 top-6 z-10 hidden w-72 rounded-lg border border-line bg-elevated p-3 text-xs text-ink-secondary shadow-float group-hover:block group-focus:block">
            This assumes all snippet-tracked direct bookings would otherwise have gone through an OTA.
            Phone bookings, walk-ins, and bookings not tracked by the snippet are not included.
          </span>
        </span>
      </div>

      {/* KPI */}
      <GlowCard className="rounded-card border border-line p-4">
        {data == null ? (
          <p className="text-sm text-ink-tertiary">{loading ? "Loading…" : "Could not load savings."}</p>
        ) : data.otaRateUsed === 0 ? (
          <p className="text-2xl font-semibold tabular-nums text-ink">₹0 saved <span className="text-sm font-normal text-ink-tertiary">(OTA tracking disabled)</span></p>
        ) : data.bookingCount === 0 ? (
          <p className="text-sm text-ink-tertiary">No bookings tracked in this period.</p>
        ) : (
          <>
            <p className="text-3xl font-semibold tabular-nums text-success" title={formatCurrency(data.totalSavings)}>
              {formatCurrency(data.totalSavings, { compact: true })}
            </p>
            <p className="mt-1 text-sm text-ink-tertiary">
              saved this period at {data.otaRateUsed}% OTA rate · on {formatCurrency(data.totalRevenue, { compact: true })} of direct bookings
            </p>
            {delta != null && (
              <p className={`mt-0.5 text-xs ${delta >= 0 ? "text-success" : "text-danger"}`}>
                {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}% vs {formatCurrency(data.previous.totalSavings, { compact: true })} last period
              </p>
            )}
          </>
        )}
      </GlowCard>

      {/* Trend */}
      {data && trendHasData && (
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.monthlyTrend} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
              <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fontSize: 11, fill: "#9ca3af" }} tickLine={false} axisLine={{ stroke: "#1f2937" }} minTickGap={12} />
              <YAxis tickFormatter={(v: number) => formatCurrency(v, { compact: true })} tick={{ fontSize: 11, fill: "#9ca3af" }} tickLine={false} axisLine={false} width={56} />
              <Tooltip
                labelFormatter={(m) => monthLabel(String(m))}
                formatter={(value, name) => {
                  const n = String(name);
                  if (n === "savings") return [formatCurrency(Number(value) || 0), "Savings"] as [string, string];
                  if (n === "revenue") return [formatCurrency(Number(value) || 0), "Revenue"] as [string, string];
                  return [formatNumber(Number(value) || 0), "Bookings"] as [string, string];
                }}
                contentStyle={CHART_TOOLTIP}
              />
              <Line type="monotone" dataKey="savings" stroke={MONEY_GREEN} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
