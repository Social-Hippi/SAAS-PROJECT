"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { CHART_TOOLTIP } from "@/lib/chart-theme";
import { formatMoney, formatNumber } from "@/lib/format";

// Sessions / booking-engine visits / bookings share a count axis; revenue gets
// its own, because plotting rupees against a handful of sessions on one scale
// flattens the counts into the baseline and tells the reader nothing.

type Point = { date: string; sessions: number; bookingEngineVisits: number; bookings: number; revenue: number };

const SERIES = [
  { key: "sessions", label: "Sessions", color: "#3b82f6", axis: "left" as const },
  { key: "bookingEngineVisits", label: "Booking engine", color: "#f59e0b", axis: "left" as const },
  { key: "bookings", label: "Bookings", color: "#22c55e", axis: "left" as const },
  { key: "revenue", label: "Revenue", color: "#a855f7", axis: "right" as const, currency: true },
];

export function InfluencerTrend({ data, currency }: { data: Point[]; currency: string | null }) {
  const hasRevenue = data.some((d) => d.revenue > 0);
  const series = hasRevenue ? SERIES : SERIES.filter((s) => !s.currency);

  return (
    <div className="p-4">
      <div style={{ width: "100%", height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: hasRevenue ? 8 : 12, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis
              dataKey="date" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false}
              axisLine={{ stroke: "#1f2937" }} minTickGap={24}
              tickFormatter={(d: string) => (typeof d === "string" ? d.slice(5) : d)}
            />
            <YAxis yAxisId="left" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
            {hasRevenue && (
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} width={52} />
            )}
            <Tooltip
              contentStyle={CHART_TOOLTIP}
              formatter={(value, name) => {
                const s = series.find((x) => x.label === name);
                const n = Number(value) || 0;
                return [s?.currency ? formatMoney(n, currency) : formatNumber(n), name] as [string, string];
              }}
            />
            {series.map((s) => (
              <Line
                key={s.key} yAxisId={s.axis} type="monotone" dataKey={s.key} name={s.label}
                stroke={s.color} strokeWidth={2} dot={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-ink-secondary">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
            {s.label}
          </li>
        ))}
        {!hasRevenue && <li className="text-ink-tertiary">Revenue appears once confirmed bookings are attributed.</li>}
      </ul>
    </div>
  );
}
