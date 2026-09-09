import { formatNumber, formatCurrency, formatPercent } from "@/lib/format";
import type { Ga4Dashboard } from "@/lib/ga4-dashboard";

// "Website Traffic" dashboard section, rendered from GA4 (OAuth) snapshots. Pure
// presentation — the page passes the aggregated Ga4Dashboard (or the empty state
// when GA4 isn't connected). All data is READ from stored snapshots; no GA4 API
// call happens here.

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function Kpi({ label, value, valueClass, hint }: { label: string; value: string; valueClass?: string; hint?: string }) {
  return (
    <div className="bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass ?? "text-ink"}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-tertiary">{hint}</p>}
    </div>
  );
}

const CHANNELS: { key: keyof Ga4Dashboard["channels"]; label: string; color: string }[] = [
  { key: "organic", label: "Organic Search", color: "bg-success" },
  { key: "paid", label: "Paid Search", color: "bg-orange-500" },
  { key: "social", label: "Social", color: "bg-pink-500" },
  { key: "direct", label: "Direct", color: "bg-ink-tertiary" },
  { key: "referral", label: "Referral", color: "bg-cyan-500" },
];

function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-card border border-line">
      <div className="border-b border-line px-4 py-3">
        <h2 className="font-medium">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-ink-tertiary">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

// Compact table used by the expanded sections. `align` marks right-aligned
// (numeric) columns; the first column is the label.
function DataTable({
  head,
  align,
  rows,
}: {
  head: string[];
  align: boolean[];
  rows: (string | number)[][];
}) {
  if (rows.length === 0) return <p className="px-4 py-6 text-center text-sm text-ink-tertiary">No data in this period.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-tertiary">
            {head.map((h, i) => (
              <th key={h} className={`px-4 py-2 font-medium ${align[i] ? "text-right" : "text-left"}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-line/60 last:border-0">
              {r.map((cell, ci) => (
                <td
                  key={ci}
                  className={`px-4 py-2 ${align[ci] ? "text-right tabular-nums text-ink-secondary" : "truncate text-ink"} ${ci === 0 ? "max-w-[16rem]" : ""}`}
                  title={ci === 0 ? String(cell) : undefined}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Self-contained SVG sparkline for the daily trend (sessions area + conversions
// dots). Responsive via a fixed viewBox with non-uniform scaling.
function MiniTrend({ points }: { points: Ga4Dashboard["trend"] }) {
  if (points.length < 2) return null;
  const W = 100, H = 30;
  const maxS = Math.max(1, ...points.map((p) => p.sessions));
  const step = W / (points.length - 1);
  const x = (i: number) => i * step;
  const y = (v: number) => H - (v / maxS) * (H - 2) - 1;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(p.sessions).toFixed(2)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const totalConv = points.reduce((s, p) => s + p.keyEvents, 0);
  return (
    <div className="p-4">
      <div className="mb-2 flex items-center justify-between text-xs text-ink-tertiary">
        <span>{points[0].date}</span>
        <span>Peak {formatNumber(maxS)} sessions/day{totalConv > 0 ? ` · ${formatNumber(totalConv)} conversions` : ""}</span>
        <span>{points[points.length - 1].date}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-24 w-full" role="img" aria-label="Daily sessions trend">
        <path d={area} className="fill-brand/10" />
        <path d={line} className="fill-none stroke-brand" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

export function Ga4WebsiteTraffic({
  data,
  manageHref,
}: {
  data: Ga4Dashboard;
  /**
   * Integrations-page href, or null on a read-only surface (the public /share
   * report). Connecting GA4 is the agency's job on a page the hotel cannot open,
   * so a link-holder is told the state without being handed a dead control.
   */
  manageHref: string | null;
}) {
  if (!data.connected) {
    return (
      <SectionCard title="Website Traffic" subtitle="Full traffic picture from Google Analytics 4.">
        <div className="p-8 text-center">
          <p className="text-sm text-ink-tertiary">
            {manageHref
              ? "Connect GA4 to see website traffic data."
              : "Google Analytics isn't connected for this hotel yet."}
          </p>
          {manageHref && (
            <a
              href={manageHref}
              className="mt-3 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover"
            >
              Go to Integrations →
            </a>
          )}
        </div>
      </SectionCard>
    );
  }

  if (data.days === 0) {
    return (
      <SectionCard title="Website Traffic" subtitle="From Google Analytics 4.">
        <div className="p-8 text-center text-sm text-ink-tertiary">
          GA4 is connected — run a sync on the Integrations page to pull the last 30 days.
        </div>
      </SectionCard>
    );
  }

  const bounceColor =
    data.bounceRate > 0.6 ? "text-danger" : data.bounceRate >= 0.4 ? "text-warning" : "text-success";
  const channelTotal = CHANNELS.reduce((s, c) => s + data.channels[c.key], 0);
  const deviceTotal = data.device.mobile + data.device.desktop + data.device.tablet;
  const ctr = data.ads && data.ads.impressions > 0 ? data.ads.clicks / data.ads.impressions : null;

  // Cross-validation (snippet vs GA4) — only when the snippet is in use.
  const tracked = data.trackedSessions;
  const variance = tracked != null && data.sessions > 0 ? ((tracked - data.sessions) / data.sessions) * 100 : null;
  const bigGap = variance != null && Math.abs(variance) > 20;

  const srcMedium = (s: string, m: string) => `${s} / ${m}`;
  const windowSub = `GA4 · last ${data.days} day${data.days === 1 ? "" : "s"}`;

  return (
    <div className="space-y-6">
      <SectionCard
        title="Website Traffic"
        subtitle={`Google Analytics 4 · last ${data.days} day${data.days === 1 ? "" : "s"}${data.propertyName ? ` · ${data.propertyName}` : ""}`}
      >
        {/* 1. Traffic KPIs */}
        <div className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4">
          <Kpi label="Total sessions" value={formatNumber(data.sessions)} />
          <Kpi label="Unique visitors" value={formatNumber(data.users)} />
          <Kpi label="Avg session" value={fmtDuration(data.avgSessionDuration)} />
          <Kpi label="Bounce rate" value={formatPercent(data.bounceRate)} valueClass={bounceColor} />
        </div>

        {/* 2. Traffic source breakdown */}
        <div className="border-b border-line p-4">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-tertiary">Traffic sources</p>
          <ul className="space-y-2">
            {CHANNELS.map((c) => {
              const v = data.channels[c.key];
              const pct = channelTotal > 0 ? (v / channelTotal) * 100 : 0;
              return (
                <li key={c.key} className="flex items-center gap-3 text-sm">
                  <span className="w-28 shrink-0 text-ink-secondary">{c.label}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-line-strong">
                    <span className={`block h-full rounded-full ${c.color}`} style={{ width: `${pct}%` }} />
                  </span>
                  <span className="w-24 shrink-0 text-right tabular-nums text-ink-tertiary">
                    {formatNumber(v)} · {pct.toFixed(0)}%
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        {/* 3. Google Ads (only when there's spend/clicks) */}
        {data.ads && (
          <div className="border-b border-line p-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">Google Ads</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Kpi label="Clicks" value={formatNumber(data.ads.clicks)} />
              <Kpi label="Impressions" value={formatNumber(data.ads.impressions)} />
              <Kpi label="CTR" value={ctr == null ? "—" : formatPercent(ctr)} />
              <Kpi label="Cost" value={formatCurrency(data.ads.cost / 100)} />
              <Kpi label="Conversions" value={formatNumber(data.ads.conversions)} />
            </div>
            <p className="mt-2 text-xs text-ink-tertiary">
              Google Ads conversions are Google-reported — compare with HotelTrack&apos;s
              tracked bookings above.
            </p>
          </div>
        )}

        {/* 4. Geographic + 5. Device */}
        <div className="grid gap-px border-b border-line bg-line md:grid-cols-2">
          <div className="bg-card p-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">Top countries</p>
            <GeoTable rows={data.topCountries} />
            {data.topCities.length > 0 && (
              <>
                <p className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-ink-tertiary">Top cities</p>
                <GeoTable rows={data.topCities} />
              </>
            )}
          </div>
          <div className="bg-card p-4">
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-tertiary">Devices</p>
            <ul className="space-y-2 text-sm">
              {([["Mobile", data.device.mobile], ["Desktop", data.device.desktop], ["Tablet", data.device.tablet]] as const).map(
                ([label, v]) => {
                  const pct = deviceTotal > 0 ? (v / deviceTotal) * 100 : 0;
                  return (
                    <li key={label} className="flex items-center gap-3">
                      <span className="w-16 shrink-0 text-ink-secondary">{label}</span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-line-strong">
                        <span className="block h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="w-20 shrink-0 text-right tabular-nums text-ink-tertiary">{pct.toFixed(0)}%</span>
                    </li>
                  );
                },
              )}
            </ul>
            <p className="mt-3 text-xs text-ink-tertiary">
              Mobile-heavy traffic? Prioritise the mobile booking experience.
            </p>
          </div>
        </div>

        {/* Cross-validation card */}
        {variance != null && (
          <div className="p-4">
            <div className={`rounded-lg border-l-4 p-4 text-sm ${bigGap ? "border-warning bg-warning/10" : "border-info bg-info/10"}`}>
              <p className="font-medium text-ink">Tracking validation</p>
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-ink-secondary">
                <span>HotelTrack tracked: <span className="font-semibold tabular-nums">{formatNumber(tracked!)}</span> sessions</span>
                <span>GA4 reported: <span className="font-semibold tabular-nums">{formatNumber(data.sessions)}</span> sessions</span>
                <span>
                  Variance:{" "}
                  <span className={`font-semibold tabular-nums ${bigGap ? "text-warning" : "text-success"}`}>
                    {variance > 0 ? "+" : ""}{variance.toFixed(1)}%
                  </span>
                </span>
              </div>
              <p className="mt-1.5 text-xs text-ink-tertiary">
                {bigGap
                  ? "Large discrepancy detected. The snippet may not be installed on all pages."
                  : "Well within the normal range — your tracking covers the site."}
              </p>
            </div>
          </div>
        )}
      </SectionCard>

      {/* ── Engagement (Report 4) ─────────────────────────────────────────── */}
      <SectionCard title="Engagement" subtitle={windowSub}>
        <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-5">
          <Kpi label="Engaged sessions" value={formatNumber(data.engagement.engagedSessions)} />
          <Kpi label="Engagement rate" value={formatPercent(data.engagement.engagementRate)} />
          <Kpi label="Avg engagement" value={fmtDuration(data.engagement.avgEngagementSeconds)} hint="per session" />
          <Kpi label="Pages / session" value={data.engagement.screenPageViewsPerSession.toFixed(1)} />
          <Kpi label="Conversions" value={formatNumber(data.keyEvents)} hint="GA4 key events" />
        </div>
      </SectionCard>

      {/* ── Acquisition: source / medium / campaign (Report 1) ────────────── */}
      <SectionCard title="Acquisition detail" subtitle="Source, medium & campaign — the attribution layer beneath the channel buckets.">
        <DataTable
          head={["Source / Medium", "Sessions", "Users", "Conversions"]}
          align={[false, true, true, true]}
          rows={data.sources.map((s) => [
            srcMedium(s.source, s.medium), formatNumber(s.sessions), formatNumber(s.users), formatNumber(s.keyEvents),
          ])}
        />
        {data.campaigns.length > 0 && (
          <>
            <p className="border-t border-line px-4 pt-3 text-xs font-medium uppercase tracking-wide text-ink-tertiary">Campaigns</p>
            <DataTable
              head={["Campaign", "Sessions", "Users", "Conversions"]}
              align={[false, true, true, true]}
              rows={data.campaigns.map((c) => [c.campaign, formatNumber(c.sessions), formatNumber(c.users), formatNumber(c.keyEvents)])}
            />
          </>
        )}
      </SectionCard>

      {/* ── Landing page × source (Report 2) ──────────────────────────────── */}
      <SectionCard title="Landing pages × source" subtitle="Which pages visitors land on, from which source, and whether they convert.">
        <DataTable
          head={["Landing page", "Source / Medium", "Sessions", "Conversions"]}
          align={[false, false, true, true]}
          rows={data.landingBySource.map((l) => [l.landing, srcMedium(l.source, l.medium), formatNumber(l.sessions), formatNumber(l.keyEvents)])}
        />
      </SectionCard>

      {/* ── Top pages (Report 3) ──────────────────────────────────────────── */}
      <SectionCard title="Top pages" subtitle="Most-viewed pages, entrances, and average engagement time.">
        <DataTable
          head={["Page", "Views", "Entrances", "Avg engagement"]}
          align={[false, true, true, true]}
          rows={data.topPages.map((p) => [
            p.title?.trim() || p.path,
            formatNumber(p.views),
            formatNumber(p.entrances),
            p.views > 0 ? fmtDuration(Math.round(p.engagementSeconds / p.views)) : "—",
          ])}
        />
      </SectionCard>

      {/* ── New vs returning (Report 5) + Events/ecommerce (Report 6) ─────── */}
      <div className="grid gap-6 md:grid-cols-2">
        <SectionCard title="New vs returning" subtitle={windowSub}>
          <DataTable
            head={["Visitor type", "Users", "Sessions", "Conversions"]}
            align={[false, true, true, true]}
            rows={data.newVsReturning.map((s) => [
              s.segment === "new" ? "New" : s.segment === "returning" ? "Returning" : s.segment,
              formatNumber(s.users), formatNumber(s.sessions), formatNumber(s.keyEvents),
            ])}
          />
        </SectionCard>

        <SectionCard title="Events & conversions" subtitle="Top GA4 events by count.">
          {data.ecommerce && (
            <div className="grid grid-cols-2 gap-px border-b border-line bg-line">
              <Kpi label="Purchase revenue" value={formatCurrency(data.ecommerce.purchaseRevenue / 100)} />
              <Kpi label="Transactions" value={formatNumber(data.ecommerce.transactions)} />
            </div>
          )}
          <DataTable
            head={["Event", "Count", "Key events"]}
            align={[false, true, true]}
            rows={data.events.map((e) => [e.event, formatNumber(e.count), formatNumber(e.keyEvents)])}
          />
        </SectionCard>
      </div>

      {/* ── Daily trend (Report 7) ────────────────────────────────────────── */}
      {data.trend.length > 1 && (
        <SectionCard title="Daily trend" subtitle="Sessions per day over the selected range.">
          <MiniTrend points={data.trend} />
        </SectionCard>
      )}
    </div>
  );
}

function GeoTable({ rows }: { rows: { name: string; sessions: number }[] }) {
  if (rows.length === 0) return <p className="text-sm text-ink-tertiary">—</p>;
  const total = rows.reduce((s, r) => s + r.sessions, 0);
  return (
    <ul className="space-y-1.5 text-sm">
      {rows.map((r) => (
        <li key={r.name} className="flex items-center justify-between gap-2">
          <span className="truncate text-ink-secondary">{r.name}</span>
          <span className="shrink-0 tabular-nums text-ink-tertiary">
            {formatNumber(r.sessions)}
            {total > 0 && <span className="ml-1 text-ink-disabled">({((r.sessions / total) * 100).toFixed(0)}%)</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
