"use client";

import { CHART_TOOLTIP } from "@/lib/chart-theme";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { formatCurrency, formatCurrencyCents, formatNumber, formatMultiple } from "@/lib/format";
import { SHARE_TOKEN_HEADER } from "@/lib/share-token";
import type {
  ChannelView as ChannelViewData, PaidChannelView, InstagramChannelView, InstagramPostItem,
  FacebookChannelView, InfluencerChannelView, DirectChannelView, OtherChannelView,
  ChannelKey, ReachSplit,
} from "@/lib/channel-view-types";
import { ChannelSelector, CHANNEL_META } from "./ChannelSelector";

// Channel-specific dashboard view. Mounted by the hotel dashboard when
// ?channel=<x> is set (x !== "all"). Client-fetches the channel-view endpoint
// for the page's date range and renders KPIs + a trend chart + tables, with
// graceful empty states. The selector stays visible so the user can switch.

const RANGE_PRESETS = [
  { key: "7", label: "7d" },
  { key: "30", label: "30d" },
  { key: "90", label: "90d" },
] as const;

export function ChannelView({
  hotelId, channel, from, to, currentRange, apiBase = "/api/agency/hotels", ownerView = false, shareToken,
}: {
  hotelId: string;
  channel: Exclude<ChannelKey, "all">;
  from: string;
  to: string;
  currentRange: string;
  /** Base path for the channel-view endpoint. Agency default; hotel owners pass "/api/hotel". */
  apiBase?: string;
  /** Hotel-owner view: hide agency-only management CTAs (Connect Meta, Go to Influencers). */
  ownerView?: boolean;
  /** When set, requests are public share-link reads (sends the token header). */
  shareToken?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [data, setData] = useState<ChannelViewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(false);
    fetch(`${apiBase}/${hotelId}/channel-view?channel=${channel}&startDate=${from}&endDate=${to}`, {
      signal: ctrl.signal,
      headers: shareToken ? { [SHARE_TOKEN_HEADER]: shareToken } : undefined,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (abort.current === ctrl) setData(d as ChannelViewData); })
      .catch((e) => { if ((e as Error).name !== "AbortError" && abort.current === ctrl) setError(true); })
      .finally(() => { if (abort.current === ctrl) setLoading(false); });
    return () => ctrl.abort();
  }, [hotelId, channel, from, to, apiBase, shareToken, reloadKey]);

  const meta = CHANNEL_META[channel];

  function rangeHref(key: string): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("range", key);
    params.delete("from");
    params.delete("to");
    return `${pathname}?${params.toString()}`;
  }
  const allChannelsHref = (() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("channel");
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  })();

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-ink">
            <span aria-hidden>{meta.icon}</span>
            {meta.label} Performance
          </h1>
          <div className="flex items-center gap-2">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => router.push(rangeHref(p.key))}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                  currentRange === p.key ? "border-brand bg-brand text-white" : "border-line-strong text-ink-secondary hover:bg-elevated"
                }`}
              >
                {p.label}
              </button>
            ))}
            <Link
              href={allChannelsHref}
              className="rounded-lg border border-line-strong px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-elevated"
            >
              View All Channels
            </Link>
          </div>
        </div>
        <ChannelSelector current={channel} />
      </div>

      {loading && !data ? (
        <ChannelSkeleton />
      ) : error || !data ? (
        <Panel><p className="py-8 text-center text-sm text-ink-tertiary">Couldn&apos;t load {meta.label} data right now.</p></Panel>
      ) : (
        <Body data={data} hotelId={hotelId} ownerView={ownerView} onLinked={() => setReloadKey((k) => k + 1)} />
      )}

      <div className="pt-1">
        <Link href={allChannelsHref} className="text-sm font-medium text-brand hover:underline">
          ← View All Channels
        </Link>
      </div>
    </div>
  );
}

// ── Shared UI ────────────────────────────────────────────────────────────────

function Panel({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-card border border-line bg-card">
      {title && <div className="border-b border-line px-4 py-3"><h3 className="text-sm font-medium text-ink">{title}</h3></div>}
      {children}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-card border border-line bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-tertiary">{sub}</p>}
    </div>
  );
}

function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <Panel>
      <div className="px-4 py-12 text-center">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-ink-tertiary">{body}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </Panel>
  );
}

type Series = { key: string; label: string; color: string; axis?: "left" | "right"; currency?: boolean };

function TrendChart({ data, series }: { data: Array<Record<string, number | string>>; series: Series[] }) {
  const hasRight = series.some((s) => s.axis === "right");
  return (
    <div className="p-4">
      <div style={{ width: "100%", height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: hasRight ? 8 : 12, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={{ stroke: "#1f2937" }}
              tickFormatter={(d: string) => (typeof d === "string" ? d.slice(5) : d)} minTickGap={24} />
            <YAxis yAxisId="left" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} width={44} />
            {hasRight && <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} width={44} />}
            <Tooltip
              contentStyle={CHART_TOOLTIP}
              formatter={(value, name) => {
                const s = series.find((x) => x.label === name);
                return [s?.currency ? formatCurrency(Number(value) || 0) : formatNumber(Number(value) || 0), name] as [string, string];
              }}
            />
            {series.map((s) => (
              <Line key={s.key} yAxisId={s.axis ?? "left"} type="monotone" dataKey={s.key} name={s.label}
                stroke={s.color} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-ink-secondary">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />{s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="ht-table w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-ink-tertiary">
          <tr>
            {head.map((h, i) => (
              <th key={h} className={`px-4 py-2 font-medium ${i === 0 ? "" : "text-right"}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const td = "px-4 py-2.5 text-right tabular-nums text-ink-secondary";
const tdName = "max-w-[16rem] truncate px-4 py-2.5 font-medium text-ink";

// ── Per-channel bodies ───────────────────────────────────────────────────────

function Body({ data, hotelId, ownerView, onLinked }: { data: ChannelViewData; hotelId: string; ownerView: boolean; onLinked: () => void }) {
  switch (data.channelType) {
    case "paid_ads": return <PaidBody data={data} hotelId={hotelId} ownerView={ownerView} />;
    case "organic_social":
      return data.channelName === "Instagram Organic"
        ? <InstagramBody data={data as InstagramChannelView} hotelId={hotelId} ownerView={ownerView} onLinked={onLinked} />
        : <FacebookBody data={data as FacebookChannelView} />;
    case "influencer": return <InfluencerBody data={data} ownerView={ownerView} />;
    case "direct": return <DirectBody data={data} />;
    case "other": return <OtherBody data={data} />;
  }
}

function PaidBody({ data, hotelId, ownerView }: { data: PaidChannelView; hotelId: string; ownerView: boolean }) {
  if (!data.hasData || !data.kpis) {
    if (data.channelName === "Google Ads") {
      // Connected but no campaign activity this period (vs never connected).
      if (data.integrationStatus !== "not_connected") {
        return <EmptyState title="No Google Ads activity this period"
          body="This hotel's Google Ads account is connected, but has no campaign spend or conversions in the selected period. Data appears here once campaigns run." />;
      }
      return <EmptyState title="Google Ads not connected"
        body={ownerView
          ? "Your agency hasn't connected this hotel's Google Ads account yet. Once they do, you'll see spend, clicks, CPC, conversions, and ROAS here alongside Meta."
          : "Connect this hotel's Google Ads account to see spend, clicks, CPC, conversions, and ROAS here alongside Meta."}
        action={ownerView ? undefined : <Link href={`/agency/hotel/${hotelId}/integrations`} className="inline-block rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover">Connect Google Ads</Link>} />;
    }
    // Hotel owners can't connect integrations (agency-managed), so show the
    // explanation without the agency-only "Connect" CTA.
    return <EmptyState title="Meta Ads not connected"
      body={ownerView
        ? "Your agency hasn't connected this hotel's Meta (Facebook) Ads account yet. Once they do, you'll see spend, CPC, CPM, CTR, ROAS, and top campaigns here."
        : "Connect this hotel's Meta (Facebook) Ads account to see spend, CPC, CPM, CTR, ROAS, and top campaigns here."}
      action={ownerView ? undefined : <Link href={`/agency/hotel/${hotelId}/integrations`} className="inline-block rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover">Connect Meta Ads</Link>} />;
  }
  const k = data.kpis;
  const accounts = data.accounts ?? [];
  const archived = data.archivedAccountIds ?? [];
  // Google Ads revenue/conversions are Ads-reported (from the account's own
  // conversion tracking); Meta's revenue is from tracked bookings. Same layout,
  // accurate sub-labels per channel.
  const isGoogle = data.channelName === "Google Ads";
  return (
    <div className="space-y-4">
      <StatGrid>
        {/* Spend in Indian-compact form; per-unit money (CPC/CPM/cost-per-X) in
            full ₹0.00 precision so small values aren't rounded to ₹0. CTR/CPC/CPM
            are recomputed from totals server-side (never averaged across rows). */}
        <Stat label="Total spend" value={formatCurrency(k.totalSpend, { compact: true })} sub={accounts.length > 1 ? `${accounts.length} accounts` : undefined} />
        <Stat label="Revenue" value={formatCurrency(k.revenue, { compact: true })} sub={`${formatNumber(k.bookings)} tracked bookings`} />
        <Stat label="ROAS" value={formatMultiple(k.roas)} sub="Tracked revenue ÷ spend" />
        {/* Phase 0: Google's OWN conversion tracking, shown alongside — never
            merged into — HotelTrack's tracked figures above. Before this, the
            Google tab put these numbers in the Revenue/ROAS stats, where the
            Meta tab shows tracked bookings: same label, different meaning. */}
        {isGoogle && (
          <Stat
            label="Revenue (Google-reported)"
            value={k.platformReportedRevenue == null ? "—" : formatCurrency(k.platformReportedRevenue, { compact: true })}
            sub={`${formatNumber(k.platformReportedConversions ?? 0)} Google conversions`}
          />
        )}
        {isGoogle && (
          <Stat
            label="ROAS (Google-reported)"
            value={formatMultiple(k.platformReportedRoas ?? null)}
            sub="Google's own conversion tracking"
          />
        )}
        <Stat label="Conversions" value={formatNumber(k.conversions)} sub={isGoogle ? "Google-reported" : "Meta-reported"} />
        <Stat label="Cost / conversion" value={k.costPerConversion == null ? "—" : formatCurrencyCents(k.costPerConversion)} />
        <Stat label="Impressions" value={formatNumber(k.impressions)} />
        <Stat label="Reach" value={formatNumber(k.reach)} sub={`${k.frequency.toFixed(1)}× frequency`} />
        <Stat label="Clicks" value={formatNumber(k.linkClicks)} />
        <Stat label="CTR" value={`${k.ctr.toFixed(2)}%`} sub="Clicks ÷ impressions" />
        <Stat label="CPC" value={formatCurrencyCents(k.cpc)} sub="Spend ÷ clicks" />
        <Stat label="CPM" value={formatCurrencyCents(k.cpm)} sub="Per 1,000 impressions" />
      </StatGrid>

      {(accounts.length > 1 || archived.length > 0) && (
        <Panel title="By ad account">
          <ul className="divide-y divide-line">
            {accounts.map((a) => (
              <li key={a.accountId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="truncate font-medium text-ink" title={a.accountId}>{a.accountId}</span>
                <span className="tabular-nums text-ink-secondary">
                  {formatCurrency(a.spend, { compact: true })} · {formatNumber(a.impressions)} impr · {formatNumber(a.clicks)} clicks
                </span>
              </li>
            ))}
            {archived.map((id) => (
              <li key={id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="truncate text-ink-tertiary" title={id}>{id}</span>
                <span className="text-ink-tertiary">archived · not included</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* Google's per-day and per-campaign revenue is still GOOGLE-REPORTED (its
          own conversion tracking); only the KPI stats above are HotelTrack-
          tracked. The titles say which, so the two are never read as one number.
          Campaign-level tracked revenue needs GCLID (Phase 1). */}
      <Panel title={isGoogle ? "Spend vs revenue (Google-reported)" : "Spend vs revenue"}>
        <TrendChart data={data.trend ?? []} series={[
          { key: "spend", label: "Spend", color: "#3b82f6", axis: "left", currency: true },
          { key: "revenue", label: "Revenue", color: "#22c55e", axis: "right", currency: true },
        ]} />
      </Panel>

      <Panel title={isGoogle ? "Top campaigns (Google-reported revenue)" : "Top campaigns"}>
        {(data.topCampaigns ?? []).length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-tertiary">No campaign data in this period.</p>
        ) : (
          <Table head={["Campaign", "Spend", "Revenue", "Bookings", "ROAS", "CTR"]}>
            {data.topCampaigns!.map((c) => (
              <tr key={c.campaignName} className="border-t border-line">
                <td className={tdName} title={c.campaignName}>{c.campaignName}</td>
                <td className={td}>{formatCurrency(c.spend, { compact: true })}</td>
                <td className={td}>{formatCurrency(c.revenue, { compact: true })}</td>
                <td className={td}>{formatNumber(c.bookings)}</td>
                <td className={td}>{formatMultiple(c.roas)}</td>
                <td className={td}>{c.ctr.toFixed(2)}%</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
      {/* Creative-level data isn't synced, so the Top Creatives table is skipped. */}
    </div>
  );
}

function InstagramBody({ data, hotelId, ownerView, onLinked }: { data: InstagramChannelView; hotelId: string; ownerView: boolean; onLinked: () => void }) {
  if (!data.hasData) {
    return <EmptyState title="No Instagram data yet"
      body="Connect this hotel's Instagram account (Integrations) and we'll sync your posts, reach, engagement, profile visits, and website clicks here." />;
  }
  const k = data.kpis;
  return (
    <div className="space-y-4">
      <StatGrid>
        <Stat label="Profile visits" value={formatNumber(k.profileVisits)} />
        <Stat label="Post reach" value={formatNumber(k.postReach)} sub={`${formatNumber(k.postImpressions)} impressions`} />
        <Stat label="Engagement rate" value={`${k.engagementRate.toFixed(1)}%`} sub="Interactions ÷ reach" />
        <Stat label="Website clicks" value={formatNumber(k.websiteClicks)} />
        <Stat label="Sessions from IG" value={formatNumber(k.sessionsFromInstagram)} />
        <Stat label="Bookings" value={formatNumber(k.bookings)} />
        <Stat label="Revenue" value={formatCurrency(k.revenue, { compact: true })} />
        <Stat label="Saves" value={formatNumber(k.saves)} sub={`${formatNumber(k.likes)} likes · ${formatNumber(k.comments)} comments`} />
      </StatGrid>

      {/* Reach Split — owned vs influencer content, ABOVE the content table. */}
      <ReachSplitSection split={data.reachSplit} hotelId={hotelId} ownerView={ownerView} onLinked={onLinked} />

      <InstagramContent posts={data.posts} />

      <Panel title="Sessions & bookings from Instagram">
        <TrendChart data={data.trend} series={[
          { key: "sessions", label: "Sessions", color: "#ec4899", axis: "left" },
          { key: "bookings", label: "Bookings", color: "#22c55e", axis: "left" },
        ]} />
      </Panel>
    </div>
  );
}

// ── Reach Split: Owned vs Influencer content (Instagram Organic only) ─────────
// `reach` is nullable upstream — render "Not available" for unknown values
// rather than a misleading 0. Owned reach = the hotel's own PostSnapshot posts;
// influencer reach = posts that tagged/mentioned the hotel (InfluencerInstagramPost).

const OWNED_COLOR = "#3b82f6";       // brand primary
const INFLUENCER_COLOR = "#f59e0b";  // accent (amber)

function fmtReach(n: number | null): string {
  return n == null ? "Not available" : formatNumber(n);
}

function BigReachCard({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) {
  return (
    <div className="rounded-card border border-line bg-card p-5 shadow-card" style={{ borderLeft: `4px solid ${accent}` }}>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums text-ink">{value}</p>
      <p className="mt-1 text-sm text-ink-tertiary">{sub}</p>
    </div>
  );
}

function ReachSplitSection({ split, hotelId, ownerView, onLinked }: { split: ReachSplit; hotelId: string; ownerView: boolean; onLinked: () => void }) {
  const owned = split.ownedContent;
  const inf = split.influencerContent;
  const total = split.totalReach;
  const ownedPct = total > 0 ? Math.round((owned.reach / total) * 100) : 0;
  const infPct = total > 0 ? 100 - ownedPct : 0;

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-secondary">Reach Split: Owned vs Influencer Content</h3>
        <p className="mt-0.5 text-xs text-ink-tertiary">
          How much reach comes from the hotel&apos;s own posts vs. influencers who tagged or mentioned the hotel.
        </p>
      </div>

      {/* A. Two big KPI cards + percentage breakdown bar */}
      <div className="grid gap-3 sm:grid-cols-2">
        <BigReachCard label="Owned Content Reach" value={formatNumber(owned.reach)} accent={OWNED_COLOR}
          sub={`${formatNumber(owned.postCount)} post${owned.postCount === 1 ? "" : "s"}`} />
        <BigReachCard label="Influencer Content Reach" value={formatNumber(inf.reach)} accent={INFLUENCER_COLOR}
          sub={`${formatNumber(inf.postCount)} post${inf.postCount === 1 ? "" : "s"} · ${formatNumber(inf.influencerCount)} influencer${inf.influencerCount === 1 ? "" : "s"}`} />
      </div>

      {total > 0 ? (
        <div className="rounded-card border border-line bg-card p-4">
          <div className="flex items-center justify-between text-xs font-medium">
            <span style={{ color: OWNED_COLOR }}>Owned {ownedPct}%</span>
            <span style={{ color: INFLUENCER_COLOR }}>Influencer {infPct}%</span>
          </div>
          <div className="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-elevated" role="img"
            aria-label={`Owned ${ownedPct} percent, influencer ${infPct} percent of total reach`}>
            <div style={{ width: `${ownedPct}%`, backgroundColor: OWNED_COLOR }} />
            <div style={{ width: `${infPct}%`, backgroundColor: INFLUENCER_COLOR }} />
          </div>
          <p className="mt-2 text-xs text-ink-tertiary">Total reach {formatNumber(total)} across owned + influencer content this period.</p>
        </div>
      ) : (
        <div className="rounded-card border border-line bg-card px-4 py-6 text-center text-sm text-ink-tertiary">
          No reach recorded in this period yet.
        </div>
      )}

      {/* B. Stacked area chart — daily owned vs influencer reach */}
      <Panel title="Reach over time — owned vs influencer">
        <ReachSplitAreaChart data={split.trendDaily} />
      </Panel>

      {/* C. Influencer performance table (reach-focused) */}
      <Panel title="Influencer Performance">
        {inf.breakdown.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-ink-tertiary">
            No influencer content detected yet. Connect influencer Instagram handles in Influencers settings.
          </p>
        ) : (
          <Table head={["Influencer", "Posts", "Total Reach", "Total Engagement", "Top Post"]}>
            {inf.breakdown.map((row) => (
              <tr key={row.influencerId} className="border-t border-line">
                <td className={tdName}>
                  {row.influencerName}
                  {row.instagramHandle && <span className="ml-1 text-xs text-ink-tertiary">@{row.instagramHandle.replace(/^@/, "")}</span>}
                </td>
                <td className={td}>{formatNumber(row.postCount)}</td>
                <td className={td}>{formatNumber(row.totalReach)}</td>
                <td className={td}>{formatNumber(row.totalEngagement)}</td>
                <td className={td}>
                  {row.topPostPermalink
                    ? <a href={row.topPostPermalink} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">View</a>
                    : "—"}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      {/* D. Unattributed mentions (collapsible) */}
      <UnattributedMentionsPanel split={split} hotelId={hotelId} ownerView={ownerView} onLinked={onLinked} />

      <p className="text-xs text-ink-tertiary">
        Tip: ask collaborating influencers to tag your hotel&apos;s Instagram account in their posts so we can track their reach.
        Detection begins after an influencer&apos;s handle is added — older posts may not appear, and some posts (private accounts,
        stories) don&apos;t report reach, shown as &ldquo;Not available&rdquo;.
      </p>
    </section>
  );
}

function ReachSplitAreaChart({ data }: { data: ReachSplit["trendDaily"] }) {
  return (
    <div className="p-4">
      <div style={{ width: "100%", height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <defs>
              <linearGradient id="ownedReachFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={OWNED_COLOR} stopOpacity={0.5} />
                <stop offset="100%" stopColor={OWNED_COLOR} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="influencerReachFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={INFLUENCER_COLOR} stopOpacity={0.5} />
                <stop offset="100%" stopColor={INFLUENCER_COLOR} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={{ stroke: "#1f2937" }}
              tickFormatter={(d: string) => (typeof d === "string" ? d.slice(5) : d)} minTickGap={24} />
            <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} width={44} />
            <Tooltip
              contentStyle={CHART_TOOLTIP}
              formatter={(value, name) => [formatNumber(Number(value) || 0), name] as [string, string]}
            />
            <Area type="monotone" dataKey="ownedReach" name="Owned reach" stackId="reach"
              stroke={OWNED_COLOR} strokeWidth={2} fill="url(#ownedReachFill)" />
            <Area type="monotone" dataKey="influencerReach" name="Influencer reach" stackId="reach"
              stroke={INFLUENCER_COLOR} strokeWidth={2} fill="url(#influencerReachFill)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-ink-secondary">
        <li className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: OWNED_COLOR }} />Owned reach</li>
        <li className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: INFLUENCER_COLOR }} />Influencer reach</li>
      </ul>
    </div>
  );
}

type InfluencerOption = { id: string; name: string; instagramHandle: string | null };

function UnattributedMentionsPanel({ split, hotelId, ownerView, onLinked }: { split: ReachSplit; hotelId: string; ownerView: boolean; onLinked: () => void }) {
  const items = split.unattributed.items;
  const [linking, setLinking] = useState<{ id: string; label: string } | null>(null);
  if (split.unattributed.count === 0) return null;
  return (
    <details className="group overflow-hidden rounded-card border border-line bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3">
        <span className="text-sm font-medium text-ink">
          Unattributed Mentions
          <span className="ml-2 rounded-full bg-elevated px-2 py-0.5 text-xs text-ink-tertiary">{split.unattributed.count}</span>
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className="h-4 w-4 shrink-0 text-ink-tertiary transition-transform group-open:rotate-180">
          <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="border-t border-line">
        <p className="px-4 py-2 text-xs text-ink-tertiary">
          Posts that tagged this hotel but whose author isn&apos;t a known influencer yet.
          {ownerView
            ? " Your agency can link these to an influencer."
            : " Link one to an influencer to start crediting their reach."}
        </p>
        <Table head={ownerView ? ["Poster", "Posted", "Reach"] : ["Poster", "Posted", "Reach", ""]}>
          {items.map((m) => {
            const label = m.posterUsername ? `@${m.posterUsername.replace(/^@/, "")}` : "(unknown)";
            return (
              <tr key={m.id} className="border-t border-line">
                <td className={tdName}>
                  {m.permalink
                    ? <a href={m.permalink} target="_blank" rel="noopener noreferrer" className="hover:text-brand hover:underline">{label}</a>
                    : label}
                </td>
                <td className={td} title={new Date(m.postedAt).toLocaleString()}>{relativeTime(m.postedAt)}</td>
                <td className={td}>{fmtReach(m.reach)}</td>
                {!ownerView && (
                  <td className={td}>
                    <button type="button" onClick={() => setLinking({ id: m.id, label })}
                      className="rounded-lg border border-line-strong px-2.5 py-1 text-xs font-medium text-ink-secondary hover:bg-elevated">
                      Link to Influencer
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </Table>
      </div>
      {linking && (
        <LinkMentionModal
          hotelId={hotelId}
          mentionId={linking.id}
          posterLabel={linking.label}
          onClose={() => setLinking(null)}
          onLinked={() => { setLinking(null); onLinked(); }}
        />
      )}
    </details>
  );
}

// Agency-only modal: pick an influencer to attribute an unattributed mention to.
function LinkMentionModal({ hotelId, mentionId, posterLabel, onClose, onLinked }: {
  hotelId: string; mentionId: string; posterLabel: string; onClose: () => void; onLinked: () => void;
}) {
  const [options, setOptions] = useState<InfluencerOption[] | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/agency/hotels/${hotelId}/influencer-options`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((d) => { if (live) setOptions((d.influencers ?? []) as InfluencerOption[]); })
      .catch(() => { if (live) setError("Couldn't load influencers."); });
    return () => { live = false; };
  }, [hotelId]);

  async function submit() {
    if (!choice) { setError("Choose an influencer."); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agency/hotels/${hotelId}/unattributed-mentions/${mentionId}/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ influencerId: choice }),
      });
      if (!res.ok) throw new Error();
      onLinked();
    } catch {
      setError("Couldn't link this mention. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-card border border-line bg-elevated p-5 shadow-float" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-ink">Link {posterLabel} to an influencer</h3>
        <p className="mt-1 text-sm text-ink-tertiary">Future posts from this account will be credited to that influencer automatically.</p>
        <select className="mt-4 w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink"
          value={choice} onChange={(e) => setChoice(e.target.value)} disabled={!options}>
          <option value="">{options ? "Select an influencer…" : "Loading…"}</option>
          {(options ?? []).map((o) => (
            <option key={o.id} value={o.id}>{o.name}{o.instagramHandle ? ` (@${o.instagramHandle.replace(/^@/, "")})` : ""}</option>
          ))}
        </select>
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-line-strong px-4 py-2 text-sm text-ink-secondary">Cancel</button>
          <button type="button" disabled={busy || !choice} onClick={submit} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? "Linking…" : "Link"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── "My Instagram Content" section (Instagram Organic only) ──────────────────

const POST_TYPE_BADGE: Record<InstagramPostItem["postType"], { label: string; className: string }> = {
  reel: { label: "Reel", className: "bg-purple-500/15 text-purple-300 ring-purple-500/30" },
  image: { label: "Image", className: "bg-blue-500/15 text-blue-300 ring-blue-500/30" },
  carousel: { label: "Carousel", className: "bg-cyan-500/15 text-cyan-300 ring-cyan-500/30" },
  story: { label: "Story", className: "bg-pink-500/15 text-pink-300 ring-pink-500/30" },
};

function PostTypeBadge({ type }: { type: InstagramPostItem["postType"] }) {
  const b = POST_TYPE_BADGE[type];
  return (
    <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${b.className}`}>
      {b.label}
    </span>
  );
}

// Coarse relative time ("2 days ago"); the cell's title attr carries the exact date.
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  return `${Math.floor(d / 365)} year${Math.floor(d / 365) === 1 ? "" : "s"} ago`;
}

const TOP_SORTS = [
  { key: "reach", label: "Reach" },
  { key: "engagement", label: "Engagement" },
  { key: "saves", label: "Saves" },
] as const;
type TopSort = (typeof TOP_SORTS)[number]["key"];

function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? "border-brand bg-brand text-white" : "border-line-strong text-ink-secondary hover:bg-elevated"
      }`}
    >
      {children}
    </button>
  );
}

function InstagramContent({ posts }: { posts: InstagramChannelView["posts"] }) {
  const [view, setView] = useState<"recent" | "top">("recent");
  const [sort, setSort] = useState<TopSort>("reach");
  const [limit, setLimit] = useState(20);

  const rows = !posts
    ? []
    : view === "recent"
      ? posts.recent
      : sort === "reach"
        ? posts.topPerforming.byReach
        : sort === "engagement"
          ? posts.topPerforming.byEngagement
          : posts.topPerforming.bySaves;
  const visible = rows.slice(0, limit);

  function pickView(next: "recent" | "top") {
    setView(next);
    setLimit(20);
  }
  function pickSort(next: TopSort) {
    setSort(next);
    setLimit(20);
  }

  return (
    <section className="overflow-hidden rounded-card border border-line bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h3 className="text-sm font-medium text-ink">My Instagram Content</h3>
        <div className="flex items-center gap-2">
          <ToggleBtn active={view === "recent"} onClick={() => pickView("recent")}>Recent</ToggleBtn>
          <ToggleBtn active={view === "top"} onClick={() => pickView("top")}>Top Performing</ToggleBtn>
        </div>
      </div>

      {view === "top" && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="text-xs uppercase tracking-wide text-ink-tertiary">Sort by</span>
          {TOP_SORTS.map((s) => (
            <ToggleBtn key={s.key} active={sort === s.key} onClick={() => pickSort(s.key)}>{s.label}</ToggleBtn>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="px-4 py-12 text-center text-sm text-ink-tertiary">
          No Instagram posts in this period. Posts will appear here once your Instagram account is connected and we&apos;ve synced your content.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="ht-table w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink-tertiary">
                <tr>
                  <th className="px-4 py-2 font-medium">Post Type</th>
                  <th className="px-4 py-2 font-medium">Caption Preview</th>
                  <th className="px-4 py-2 text-right font-medium">Reach</th>
                  <th className="px-4 py-2 text-right font-medium">Engagement</th>
                  <th className="px-4 py-2 text-right font-medium">Likes</th>
                  <th className="px-4 py-2 text-right font-medium">Comments</th>
                  <th className="px-4 py-2 text-right font-medium">Saves</th>
                  <th className="px-4 py-2 text-right font-medium">Posted Date</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => (
                  <tr key={p.id} className="border-t border-line">
                    <td className="px-4 py-2.5"><PostTypeBadge type={p.postType} /></td>
                    <td className="max-w-[18rem] truncate px-4 py-2.5 font-medium text-ink">
                      {p.permalink ? (
                        <a href={p.permalink} target="_blank" rel="noopener noreferrer" title={p.caption || undefined} className="hover:text-brand hover:underline">
                          {p.captionPreview || "(no caption)"}
                        </a>
                      ) : (
                        <span title={p.caption || undefined}>{p.captionPreview || "(no caption)"}</span>
                      )}
                    </td>
                    <td className={td}>{formatNumber(p.reach)}</td>
                    <td className={td}>{p.engagementRate.toFixed(1)}%</td>
                    <td className={td}>{formatNumber(p.likes)}</td>
                    <td className={td}>{formatNumber(p.comments)}</td>
                    <td className={td}>{formatNumber(p.saves)}</td>
                    <td className={td} title={new Date(p.postedAt).toLocaleString()}>{relativeTime(p.postedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {limit < rows.length && (
            <div className="border-t border-line px-4 py-3 text-center">
              <button
                type="button"
                onClick={() => setLimit((n) => Math.min(n + 20, rows.length))}
                className="rounded-lg border border-line-strong px-4 py-1.5 text-sm font-medium text-ink-secondary hover:bg-elevated"
              >
                Load more ({rows.length - limit} more)
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FacebookBody({ data }: { data: FacebookChannelView }) {
  const k = data.kpis;
  if (!data.hasData) {
    return <EmptyState title="No Facebook organic data this period"
      body="We don't sync Facebook Page metrics yet. Sessions and bookings attributed to Facebook organic (via UTM tags) will appear here once they're tracked." />;
  }
  return (
    <div className="space-y-4">
      <StatGrid>
        <Stat label="Sessions from FB" value={formatNumber(k.sessionsFromFacebook)} />
        <Stat label="Bookings" value={formatNumber(k.bookings)} />
        <Stat label="Revenue" value={formatCurrency(k.revenue, { compact: true })} />
        <Stat label="Page reach" value={k.postReach > 0 ? formatNumber(k.postReach) : "—"} sub="Not synced yet" />
      </StatGrid>
      <Panel title="Sessions & bookings from Facebook">
        <TrendChart data={data.trend} series={[
          { key: "sessions", label: "Sessions", color: "#6366f1", axis: "left" },
          { key: "bookings", label: "Bookings", color: "#22c55e", axis: "left" },
        ]} />
      </Panel>
    </div>
  );
}

function InfluencerBody({ data, ownerView }: { data: InfluencerChannelView; ownerView: boolean }) {
  if (!data.hasData) {
    return <EmptyState title="No influencer activity yet"
      body={ownerView
        ? "No influencer coupon redemptions tracked yet. Your agency manages influencer collaborations — redemptions and revenue will appear here once they're recorded."
        : "Create your first influencer and coupon code to start tracking redemptions and revenue."}
      action={ownerView ? undefined : <Link href="/agency/influencers" className="inline-block rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover">Go to Influencers</Link>} />;
  }
  const k = data.kpis;
  const b = data.redemptionSourceBreakdown;
  return (
    <div className="space-y-4">
      <StatGrid>
        <Stat label="Active influencers" value={formatNumber(k.activeInfluencers)} />
        <Stat label="Active coupon codes" value={formatNumber(k.activeCouponCodes)} />
        <Stat label="Redemptions" value={formatNumber(k.totalRedemptions)} sub={`${formatNumber(b.snippetAuto)} auto · ${formatNumber(b.manualEntry)} manual`} />
        {/* Track A: coupon revenue and tracked-link revenue are shown apart. A
            booking that used a coupon is counted only once, as a redemption. */}
        <Stat label="Coupon revenue" value={formatCurrency(k.totalRevenue, { compact: true })} sub={`${formatCurrency(k.averageRevenuePerInfluencer, { compact: true })} avg / influencer`} />
        <Stat label="Tracked-link revenue" value={formatCurrency(k.linkAttributedRevenue, { compact: true })} sub={`${formatNumber(k.linkAttributedBookings)} booking${k.linkAttributedBookings === 1 ? "" : "s"}, no coupon used`} />
      </StatGrid>
      <Panel title="Redemptions & revenue">
        <TrendChart data={data.trend} series={[
          { key: "redemptions", label: "Redemptions", color: "#f59e0b", axis: "left" },
          { key: "revenue", label: "Revenue", color: "#22c55e", axis: "right", currency: true },
        ]} />
      </Panel>
      <Panel title="Top influencers">
        {data.topInfluencers.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-tertiary">No redemptions or tracked-link bookings in this period.</p>
        ) : (
          <Table head={["Influencer", "Codes", "Redemptions", "Coupon revenue", "Link bookings", "Link revenue", "Total attributed"]}>
            {data.topInfluencers.map((i) => (
              <tr key={`${i.influencerName}-${i.instagramHandle}`} className="border-t border-line">
                <td className={tdName}>
                  {i.influencerName}
                  {i.instagramHandle && <span className="ml-1 text-xs text-ink-tertiary">@{i.instagramHandle}</span>}
                </td>
                <td className={td}>{formatNumber(i.activeCodesCount)}</td>
                <td className={td}>{formatNumber(i.redemptionsCount)}</td>
                <td className={td}>{formatCurrency(i.revenue, { compact: true })}</td>
                <td className={td}>{formatNumber(i.linkBookings)}</td>
                <td className={td}>{formatCurrency(i.linkRevenue, { compact: true })}</td>
                <td className={td}>{formatCurrency(i.attributedRevenue, { compact: true })}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}

function DirectBody({ data }: { data: DirectChannelView }) {
  const k = data.kpis;
  if (!data.hasData) {
    return <EmptyState title="No direct traffic this period"
      body="Direct visits (no marketing source) and their bookings will appear here once the tracking snippet records sessions." />;
  }
  return (
    <div className="space-y-4">
      <StatGrid>
        <Stat label="Sessions" value={formatNumber(k.sessions)} />
        <Stat label="Bookings" value={formatNumber(k.bookings)} />
        <Stat label="Revenue" value={formatCurrency(k.revenue, { compact: true })} />
        <Stat label="Conversion rate" value={k.conversionRate == null ? "—" : `${k.conversionRate.toFixed(1)}%`} sub={`${formatCurrency(k.avgBookingValue, { compact: true })} avg booking`} />
      </StatGrid>
      <Panel title="Direct sessions, bookings & revenue">
        <TrendChart data={data.trend} series={[
          { key: "sessions", label: "Sessions", color: "#9ca3af", axis: "left" },
          { key: "bookings", label: "Bookings", color: "#22c55e", axis: "left" },
          { key: "revenue", label: "Revenue", color: "#3b82f6", axis: "right", currency: true },
        ]} />
      </Panel>
      <Panel title="Top landing pages">
        {data.topLandingPages.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-tertiary">No landing-page data in this period.</p>
        ) : (
          <Table head={["Page", "Sessions", "Bookings"]}>
            {data.topLandingPages.map((p) => (
              <tr key={p.pagePath} className="border-t border-line">
                <td className={tdName} title={p.pagePath}>{p.pagePath}</td>
                <td className={td}>{formatNumber(p.sessions)}</td>
                <td className={td}>{formatNumber(p.bookings)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}

function OtherBody({ data }: { data: OtherChannelView }) {
  const k = data.kpis;
  if (!data.hasData) {
    return <EmptyState title="No other-channel traffic this period"
      body="Visits whose UTM source doesn't match a known channel will be grouped here so you can investigate and tag them correctly." />;
  }
  return (
    <div className="space-y-4">
      <StatGrid>
        <Stat label="Sessions" value={formatNumber(k.sessions)} />
        <Stat label="Bookings" value={formatNumber(k.bookings)} />
        <Stat label="Revenue" value={formatCurrency(k.revenue, { compact: true })} />
      </StatGrid>
      <Panel title="Sessions, bookings & revenue">
        <TrendChart data={data.trend} series={[
          { key: "sessions", label: "Sessions", color: "#8b5cf6", axis: "left" },
          { key: "bookings", label: "Bookings", color: "#22c55e", axis: "left" },
          { key: "revenue", label: "Revenue", color: "#3b82f6", axis: "right", currency: true },
        ]} />
      </Panel>
      <Panel title="Unknown sources">
        <Table head={["Source", "Medium", "Sessions", "Bookings", "Revenue"]}>
          {data.unknownSources.map((s) => (
            <tr key={`${s.utmSource}-${s.utmMedium}`} className="border-t border-line">
              <td className={tdName}>{s.utmSource}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">{s.utmMedium}</td>
              <td className={td}>{formatNumber(s.sessions)}</td>
              <td className={td}>{formatNumber(s.bookings)}</td>
              <td className={td}>{formatCurrency(s.revenue, { compact: true })}</td>
            </tr>
          ))}
        </Table>
        <p className="px-4 py-2 text-xs text-ink-tertiary">Tag these links with recognised UTM sources/mediums to move them into the right channel.</p>
      </Panel>
    </div>
  );
}

function ChannelSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-card border border-line bg-card" />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-card border border-line bg-card" />
      <div className="h-48 animate-pulse rounded-card border border-line bg-card" />
    </div>
  );
}
