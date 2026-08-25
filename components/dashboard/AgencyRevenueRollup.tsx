"use client";

import { CHART_TOOLTIP } from "@/lib/chart-theme";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatCurrency, formatNumber, formatMultiple } from "@/lib/format";
import { SOURCE_TYPES, SOURCE_TYPE_LABEL, type SourceType } from "@/lib/source-classifier";
import type { Granularity } from "@/lib/revenue-by-source";

// Agency Revenue Rollup (Phase R3) — agency-wide revenue across all hotels, by
// source, with KPIs, top performers, a daily stacked chart, a source table with
// per-hotel drill-down, and a hotel-performance table. Client-fetches the
// /api/agency/{overview,revenue-by-source,…} endpoints so filters update live.

const SOURCE_TYPE_COLOR: Record<SourceType, string> = {
  meta_ads: "#3b82f6", google_ads: "#ef4444", instagram_organic: "#ec4899",
  facebook_organic: "#6366f1", influencer: "#f59e0b", email: "#14b8a6",
  whatsapp: "#22c55e", direct: "#9ca3af", other: "#8b5cf6",
};
const GRAN_LABEL: Record<Granularity, string> = {
  source: "Source", source_medium: "Source + Medium", source_medium_campaign: "Source + Medium + Campaign",
};
const RANGES = [{ key: "7", label: "7d" }, { key: "30", label: "30d" }, { key: "90", label: "90d" }];

type Hotel = { id: string; name: string };
type Overview = {
  totalRevenue: number; totalBookings: number;
  // Phase 0: NULL when the agency's ad accounts report in currencies that
  // cannot be safely combined. Must render "—", never ₹0 — formatCurrency(null)
  // silently produces "₹0", which reads as "spent nothing".
  totalAdSpend: number | null; roas: number | null;
  activeHotelsCount: number; totalHotelsCount: number;
  topSource: { key: string; revenue: number } | null;
  topHotel: { hotelClientId: string; name: string; revenue: number } | null;
  topInfluencer: { influencerId: string; name: string; revenue: number } | null;
  periodOverPeriodGrowth: number | null;
  hotels: { hotelClientId: string; name: string; revenue: number; bookings: number; topSource: string | null; lastBookingAt: string | null }[];
};
type RbsGroup = { key: string; sourceType: SourceType; bookings: number; revenue: number; averageBookingValue: number; percentOfTotal: number; hotelCount: number };
type Rbs = { groups: RbsGroup[]; daily: { date: string; byType: Partial<Record<SourceType, number>> }[]; totals: { revenue: number; bookings: number } };
type DrillHotel = { hotelClientId: string; name: string; revenue: number; bookings: number; averageBookingValue: number; percentOfSource: number };

function isoDay(d: Date) { return d.toISOString().slice(0, 10); }
function pct(n: number) { return `${n.toFixed(1)}%`; }
function fmtDay(iso: string | null) { return iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—"; }

export function AgencyRevenueRollup({ hotels }: { hotels: Hotel[] }) {
  const router = useRouter();
  const [granularity, setGranularity] = useState<Granularity>("source");
  const [rangeKey, setRangeKey] = useState("30");
  const [selectedHotels, setSelectedHotels] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<SourceType>>(new Set());
  const [overview, setOverview] = useState<Overview | null>(null);
  const [rbs, setRbs] = useState<Rbs | null>(null);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState<{ key: string; hotels: DrillHotel[] | null } | null>(null);
  const rbsAbort = useRef<AbortController | null>(null);

  const { startDate, endDate } = useMemo(() => {
    const end = new Date();
    return { startDate: isoDay(new Date(end.getTime() - Number(rangeKey) * 86_400_000)), endDate: isoDay(end) };
  }, [rangeKey]);

  const baseParams = useCallback(() => {
    const p = new URLSearchParams({ startDate, endDate });
    for (const id of selectedHotels) p.append("hotel", id);
    return p;
  }, [startDate, endDate, selectedHotels]);

  // Overview (KPIs + top performers + hotel table) — depends on dates + hotels.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/agency/overview?${baseParams().toString()}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setOverview(d as Overview))
      .catch(() => {});
    return () => ctrl.abort();
  }, [baseParams]);

  // Revenue-by-source (chart + table) — also depends on granularity + chips.
  useEffect(() => {
    rbsAbort.current?.abort();
    const ctrl = new AbortController();
    rbsAbort.current = ctrl;
    // Data-fetch effect: show the loading state while the request is in flight.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    const p = baseParams();
    p.set("granularity", granularity);
    if (selectedTypes.size) p.set("sourceTypes", [...selectedTypes].join(","));
    fetch(`/api/agency/revenue-by-source?${p.toString()}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setRbs(d as Rbs); })
      .catch(() => {})
      .finally(() => { if (rbsAbort.current === ctrl) setLoading(false); });
    return () => ctrl.abort();
  }, [baseParams, granularity, selectedTypes]);

  const openDrill = async (key: string) => {
    setDrill({ key, hotels: null });
    const r = await fetch(`/api/agency/revenue-by-source/${encodeURIComponent(key)}/hotels?${baseParams().toString()}`);
    const d = r.ok ? ((await r.json()) as { hotels: DrillHotel[] }) : { hotels: [] };
    setDrill({ key, hotels: d.hotels });
  };

  const chartData = useMemo(() => {
    if (!rbs) return [];
    return rbs.daily.map((d) => {
      const row: Record<string, number | string> = { date: d.date.slice(5) };
      for (const t of SOURCE_TYPES) row[t] = d.byType[t] ?? 0;
      return row;
    });
  }, [rbs]);
  const activeTypes = useMemo(
    () => (rbs ? SOURCE_TYPES.filter((t) => rbs.daily.some((d) => (d.byType[t] ?? 0) > 0)) : []),
    [rbs],
  );

  if (hotels.length === 0) {
    return (
      <div className="rounded-card border border-line bg-card px-4 py-12 text-center">
        <p className="text-sm text-ink-tertiary">No hotels yet — add your first hotel to start tracking revenue.</p>
        <a href="/agency/hotels/new" className="mt-3 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white">Add your first hotel</a>
      </div>
    );
  }

  const noBookings = overview != null && overview.totalBookings === 0 && (rbs?.totals.bookings ?? 0) === 0;

  return (
    <div className="space-y-5">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-lg border border-line-strong">
          {RANGES.map((r) => (
            <button key={r.key} type="button" onClick={() => setRangeKey(r.key)}
              className={`px-3 py-1.5 text-sm font-medium ${rangeKey === r.key ? "bg-brand text-white" : "bg-page text-ink-secondary hover:bg-elevated"}`}>{r.label}</button>
          ))}
        </div>
        <HotelFilter hotels={hotels} selected={selectedHotels} onChange={setSelectedHotels} />
      </div>

      {/* ROW 1 — KPI cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Total revenue" value={overview ? formatCurrency(overview.totalRevenue, { compact: true }) : "—"}
          hint={overview?.periodOverPeriodGrowth != null ? `${overview.periodOverPeriodGrowth >= 0 ? "▲" : "▼"} ${Math.abs(overview.periodOverPeriodGrowth).toFixed(1)}% vs prev period` : "vs prev period —"}
          tone={overview?.periodOverPeriodGrowth != null ? (overview.periodOverPeriodGrowth >= 0 ? "text-success" : "text-danger") : undefined} />
        <Kpi label="Total bookings" value={overview ? formatNumber(overview.totalBookings) : "—"} />
        <Kpi label="ROAS" value={overview ? (overview.roas == null ? "—" : formatMultiple(overview.roas)) : "—"}
          hint={
            overview
              ? overview.totalAdSpend == null
                ? "Ad spend — (accounts report in different currencies)"
                : `Ad spend ${formatCurrency(overview.totalAdSpend, { compact: true })}`
              : undefined
          } />
        <Kpi label="Active hotels" value={overview ? `${overview.activeHotelsCount} of ${overview.totalHotelsCount}` : "—"} hint="generating bookings" />
      </div>

      {/* ROW 2 — Top performers */}
      <div className="grid gap-3 sm:grid-cols-3">
        <TopCard label="Top source" name={overview?.topSource ? overview.topSource.key : "—"} value={overview?.topSource ? formatCurrency(overview.topSource.revenue, { compact: true }) : ""} />
        <TopCard label="Top hotel" name={overview?.topHotel?.name ?? "—"} value={overview?.topHotel ? formatCurrency(overview.topHotel.revenue, { compact: true }) : ""} />
        <TopCard label="Top influencer" name={overview?.topInfluencer?.name ?? "—"} value={overview?.topInfluencer ? formatCurrency(overview.topInfluencer.revenue, { compact: true }) : ""} />
      </div>

      {noBookings ? (
        <div className="rounded-card border border-line bg-card px-4 py-10 text-center text-sm text-ink-tertiary">
          No bookings recorded in this date range. Make sure tracking snippets are installed on your hotels&apos; websites.
        </div>
      ) : (
        <>
          {/* ROW 3 — daily stacked revenue by source type */}
          <section className="rounded-card border border-line">
            <div className="border-b border-line px-4 py-3"><h2 className="font-medium">Daily revenue by source</h2></div>
            <div className="p-4">
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#9ca3af" }} tickLine={false} axisLine={{ stroke: "#1f2937" }} minTickGap={20} />
                    <YAxis tickFormatter={(v: number) => formatCurrency(v, { compact: true })} tick={{ fontSize: 11, fill: "#9ca3af" }} tickLine={false} axisLine={false} width={56} />
                    <Tooltip formatter={(v, n) => [formatCurrency(Number(v) || 0), SOURCE_TYPE_LABEL[n as SourceType] ?? String(n)] as [string, string]}
                      contentStyle={CHART_TOOLTIP} />
                    {activeTypes.map((t) => <Bar key={t} dataKey={t} stackId="rev" fill={SOURCE_TYPE_COLOR[t]} />)}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </section>

          {/* ROW 4 — revenue by source table */}
          <section className="overflow-hidden rounded-card border border-line">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <h2 className="font-medium">Revenue by source</h2>
              <div className="inline-flex overflow-hidden rounded-lg border border-line-strong">
                {(Object.keys(GRAN_LABEL) as Granularity[]).map((g) => (
                  <button key={g} type="button" onClick={() => setGranularity(g)}
                    className={`px-3 py-1.5 text-xs font-medium ${granularity === g ? "bg-brand text-white" : "bg-page text-ink-secondary hover:bg-elevated"}`}>{GRAN_LABEL[g]}</button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 px-4 pt-3">
              <Chip on={selectedTypes.size === 0} onClick={() => setSelectedTypes(new Set())} label="All" />
              {SOURCE_TYPES.map((t) => (
                <Chip key={t} on={selectedTypes.has(t)} color={SOURCE_TYPE_COLOR[t]} label={SOURCE_TYPE_LABEL[t]}
                  onClick={() => setSelectedTypes((p) => { const n = new Set(p); if (n.has(t)) n.delete(t); else n.add(t); return n; })} />
              ))}
            </div>
            <div className={`overflow-x-auto p-1 ${loading ? "opacity-60" : ""}`}>
              <table className="ht-table w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-tertiary">
                    <th className="px-4 py-2 font-medium">{GRAN_LABEL[granularity]}</th>
                    <th className="px-4 py-2 text-right font-medium">Bookings</th>
                    <th className="px-4 py-2 text-right font-medium">Revenue</th>
                    <th className="px-4 py-2 text-right font-medium">Avg value</th>
                    <th className="px-4 py-2 text-right font-medium"># Hotels</th>
                    <th className="px-4 py-2 text-right font-medium">% of total</th>
                  </tr>
                </thead>
                <tbody>
                  {(rbs?.groups ?? []).map((g) => (
                    <tr key={g.key} onClick={() => openDrill(g.key)}
                      className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-elevated">
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SOURCE_TYPE_COLOR[g.sourceType] }} />
                          <code className="text-xs text-ink-secondary">{g.key}</code>
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(g.bookings)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-medium">{formatCurrency(g.revenue, { compact: true })}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">{formatCurrency(Math.round(g.averageBookingValue))}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">{formatNumber(g.hotelCount)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{pct(g.percentOfTotal)}</td>
                    </tr>
                  ))}
                  {rbs && rbs.groups.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-tertiary">No revenue for these filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* ROW 5 — hotel performance table */}
          <section className="overflow-hidden rounded-card border border-line">
            <div className="border-b border-line px-4 py-3"><h2 className="font-medium">Hotel performance</h2></div>
            <div className="overflow-x-auto">
              <table className="ht-table w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-tertiary">
                    <th className="px-4 py-2 font-medium">Hotel</th>
                    <th className="px-4 py-2 text-right font-medium">Revenue</th>
                    <th className="px-4 py-2 text-right font-medium">Bookings</th>
                    <th className="px-4 py-2 font-medium">Top source</th>
                    <th className="px-4 py-2 font-medium">Last booking</th>
                  </tr>
                </thead>
                <tbody>
                  {(overview?.hotels ?? []).map((hRow) => (
                    <tr key={hRow.hotelClientId} onClick={() => router.push(`/agency/hotel/${hRow.hotelClientId}`)}
                      className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-elevated">
                      <td className="px-4 py-2.5 font-medium text-ink">{hRow.name}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-medium">{formatCurrency(hRow.revenue, { compact: true })}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(hRow.bookings)}</td>
                      <td className="px-4 py-2.5 text-ink-secondary"><code className="text-xs">{hRow.topSource ?? "—"}</code></td>
                      <td className="px-4 py-2.5 text-ink-tertiary">{fmtDay(hRow.lastBookingAt)}</td>
                    </tr>
                  ))}
                  {overview && overview.hotels.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-tertiary">No hotel revenue in this range.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {drill && (
        <Drawer title={`Hotels contributing · ${drill.key}`} onClose={() => setDrill(null)}>
          {drill.hotels == null ? (
            <p className="text-sm text-ink-tertiary">Loading…</p>
          ) : drill.hotels.length === 0 ? (
            <p className="text-sm text-ink-tertiary">No hotels for this source in range.</p>
          ) : (
            <ul className="space-y-2">
              {drill.hotels.map((d) => (
                <li key={d.hotelClientId} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-card px-3 py-2">
                  <button type="button" onClick={() => router.push(`/agency/hotel/${d.hotelClientId}`)} className="truncate text-left text-sm font-medium text-ink hover:underline">{d.name}</button>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-medium tabular-nums">{formatCurrency(d.revenue, { compact: true })}</p>
                    <p className="text-xs text-ink-tertiary tabular-nums">{formatNumber(d.bookings)} bookings · {pct(d.percentOfSource)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Drawer>
      )}
    </div>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-card border border-line p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className={`mt-0.5 text-xs ${tone ?? "text-ink-tertiary"}`}>{hint}</p>}
    </div>
  );
}
function TopCard({ label, name, value }: { label: string; name: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-ink">{name}</p>
      {value && <p className="text-sm text-ink-tertiary tabular-nums">{value}</p>}
    </div>
  );
}
function Chip({ on, label, color, onClick }: { on: boolean; label: string; color?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${on ? "text-ink" : "border-line-strong text-ink-secondary hover:bg-elevated"}`}
      style={on && color ? { borderColor: color, backgroundColor: `${color}22` } : on ? { borderColor: "var(--color-brand)" } : undefined}>{label}</button>
  );
}
function HotelFilter({ hotels, selected, onChange }: { hotels: Hotel[]; selected: Set<string>; onChange: (s: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  const label = selected.size === 0 ? "All hotels" : `${selected.size} hotel${selected.size === 1 ? "" : "s"}`;
  return (
    <div className="relative w-full sm:w-auto">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-line-strong bg-elevated px-5 py-3 text-base font-medium text-ink shadow transition-colors hover:bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-page sm:w-auto sm:min-w-[300px]"
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className="text-lg leading-none text-ink-tertiary">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 max-h-64 w-64 overflow-y-auto rounded-lg border border-line bg-elevated p-2 shadow-float">
            <button type="button" onClick={() => onChange(new Set())} className="mb-1 w-full rounded px-2 py-1 text-left text-xs text-brand hover:bg-card">All hotels</button>
            {hotels.map((h) => (
              <label key={h.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-card">
                <input type="checkbox" checked={selected.has(h.id)} onChange={() => { const n = new Set(selected); if (n.has(h.id)) n.delete(h.id); else n.add(h.id); onChange(n); }} className="h-4 w-4 rounded border-line-strong" />
                <span className="truncate">{h.name}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="h-full w-full max-w-sm overflow-y-auto border-l border-line bg-elevated p-5 shadow-float" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-ink">{title}</h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-ink-tertiary hover:bg-line-strong" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
