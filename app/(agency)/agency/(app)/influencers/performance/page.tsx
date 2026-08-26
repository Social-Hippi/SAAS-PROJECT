import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentMember } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { loadInfluencerPerformance, type Availability } from "@/lib/influencer-performance";
import { REPORTING_CURRENCY } from "@/lib/ad-spend";
import { formatMoney, formatNumber, formatPercent } from "@/lib/format";
import { Panel, Stat, StatGrid, Table, td, tdName, ConfidenceBadge } from "@/components/dashboard/ui";
import { InfluencerTrend } from "@/components/dashboard/InfluencerTrend";

// Influencer Performance — agency-wide, filterable by hotel, influencer and
// date range. Server-rendered with searchParams filters, matching how the rest
// of the agency dashboards work.

const RANGES = [
  { key: "7d", label: "7d", days: 7 },
  { key: "30d", label: "30d", days: 30 },
  { key: "90d", label: "90d", days: 90 },
] as const;

function rangeFor(key: string | undefined) {
  const found = RANGES.find((r) => r.key === key) ?? RANGES[1];
  const until = new Date();
  const since = new Date(until.getTime() - found.days * 24 * 60 * 60 * 1000);
  return { key: found.key, since, until };
}

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`rounded-lg border px-3 py-1.5 text-sm ${
        active ? "border-brand bg-brand/10 font-medium text-brand" : "border-line text-ink-secondary hover:border-line-strong"
      }`}
    >
      {children}
    </Link>
  );
}

/** A KPI that may not be collectable — never renders a misleading zero. */
function AvailabilityStat({ label, availability }: { label: string; availability: Availability }) {
  if (availability.state === "available") return null;
  return <Stat label={label} value="Not tracked" sub={availability.reason} muted />;
}

export default async function InfluencerPerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; hotel?: string; influencer?: string }>;
}) {
  const member = await getCurrentMember();
  if (!member) redirect("/agency/onboarding");
  const sp = await searchParams;
  const { key: rangeKey, since, until } = rangeFor(sp.range);

  const hotels = await agencyScoped(prisma.hotelClient).findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  const hotelIds = sp.hotel && hotels.some((h) => h.id === sp.hotel) ? [sp.hotel] : undefined;

  const perf = await loadInfluencerPerformance({
    agencyId: member.agencyId,
    hotelClientIds: hotelIds,
    influencerId: sp.influencer || undefined,
    since,
    until,
  });

  const k = perf.kpis;
  const qs = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { range: rangeKey, hotel: sp.hotel, influencer: sp.influencer, ...over };
    for (const [key, v] of Object.entries(merged)) if (v) p.set(key, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  const money = (v: number | null, currency: string | null) =>
    v == null ? "—" : formatMoney(v, currency, { compact: true });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Influencer Performance</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Sessions, booking-engine reach and attributed booking revenue for every influencer link.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <Chip key={r.key} href={qs({ range: r.key })} active={rangeKey === r.key}>{r.label}</Chip>
        ))}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <Chip href={qs({ hotel: undefined })} active={!sp.hotel}>All hotels</Chip>
        {hotels.map((h) => (
          <Chip key={h.id} href={qs({ hotel: h.id })} active={sp.hotel === h.id}>{h.name}</Chip>
        ))}
        {sp.influencer && (
          <>
            <span className="mx-1 h-5 w-px bg-line" aria-hidden />
            <Chip href={qs({ influencer: undefined })} active={false}>Clear influencer filter</Chip>
          </>
        )}
      </div>

      {/* Primary KPIs */}
      <StatGrid>
        <Stat label="Active influencers" value={formatNumber(k.activeInfluencers)} sub="With activity in this period" />
        <Stat label="Sessions" value={formatNumber(k.sessions)} sub="Visits from tracked influencer links" />
        {perf.availability.bookingEngine.state === "available" ? (
          <Stat label="Booking engine visits" value={formatNumber(k.bookingEngineVisits)} sub="Reached the booking engine" />
        ) : (
          <AvailabilityStat label="Booking engine visits" availability={perf.availability.bookingEngine} />
        )}
        {perf.availability.bookings.state === "available" ? (
          <Stat
            label="Attributed revenue"
            value={k.mixedCurrency ? "Mixed currencies" : money(k.attributedRevenue, k.currency)}
            sub={`${formatNumber(k.confirmedBookings)} confirmed booking${k.confirmedBookings === 1 ? "" : "s"}`}
          />
        ) : (
          <AvailabilityStat label="Attributed revenue" availability={perf.availability.bookings} />
        )}
      </StatGrid>

      {/* Secondary KPIs */}
      <StatGrid>
        <Stat label="Coupon redemptions" value={formatNumber(k.couponRedemptions)} sub="Separate from booking revenue" />
        <Stat
          label="Coupon revenue"
          value={formatMoney(k.couponRevenue, REPORTING_CURRENCY, { compact: true })}
          sub={`Separate from booking revenue · ${REPORTING_CURRENCY}`}
        />
        <Stat
          label="Booking conversion"
          value={k.bookingConversionRate == null ? "—" : formatPercent(k.bookingConversionRate)}
          sub={k.bookingConversionRate == null ? "No sessions in this period" : "Bookings ÷ sessions"}
        />
        <AvailabilityStat label="ROAS" availability={perf.availability.roas} />
      </StatGrid>

      {/* Attribution funnel */}
      <Panel title="Attribution funnel">
        <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-5">
          {[
            { label: "Link clicks", value: null as number | null, avail: perf.funnel.linkClicks },
            { label: "Sessions", value: perf.funnel.sessions.value, avail: { state: "available" } as Availability },
            { label: "Booking engine", value: perf.funnel.bookingEngine.value, avail: perf.funnel.bookingEngine.availability },
            { label: "Checkout", value: null, avail: perf.funnel.checkout },
            { label: "Confirmed bookings", value: perf.funnel.confirmedBookings.value, avail: perf.funnel.confirmedBookings.availability },
          ].map((s) => (
            <div key={s.label} className="bg-card px-4 py-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">{s.label}</p>
              {s.avail.state === "available" ? (
                <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{formatNumber(s.value ?? 0)}</p>
              ) : (
                <p className="mt-1 text-sm text-ink-tertiary" title={s.avail.reason}>Not tracked</p>
              )}
              {s.avail.state !== "available" && (
                <p className="mt-0.5 text-xs text-ink-tertiary">{s.avail.reason}</p>
              )}
            </div>
          ))}
        </div>
      </Panel>

      {perf.belowConfidenceFloor > 0 && (
        <p className="text-xs text-ink-tertiary">
          {formatNumber(perf.belowConfidenceFloor)} booking
          {perf.belowConfidenceFloor === 1 ? "" : "s"} matched a journey below the attribution
          confidence floor and {perf.belowConfidenceFloor === 1 ? "is" : "are"} not counted above.
        </p>
      )}

      {/* Trend */}
      <Panel title="Sessions, bookings & revenue">
        <InfluencerTrend data={perf.series} currency={k.currency} />
      </Panel>

      {/* Top influencers */}
      <Panel title="Influencers">
        {perf.rows.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm font-medium text-ink">No influencer activity in this period</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-ink-tertiary">
              Sessions appear here once someone visits through a tracked influencer link.
            </p>
          </div>
        ) : (
          <Table head={["Influencer", "Sessions", "Booking engine", "Bookings", "Revenue", "Conv. rate", "Redemptions", "Confidence"]}>
            {perf.rows.map((r) => (
              <tr key={r.influencerId} className="border-t border-line hover:bg-page/50">
                <td className={tdName}>
                  <Link href={`/agency/influencers/performance/${r.influencerId}${qs({})}`} className="font-medium hover:underline">
                    {r.name}
                  </Link>
                  {r.instagramHandle && <span className="ml-1 text-xs text-ink-tertiary">@{r.instagramHandle}</span>}
                  {r.archived && <span className="ml-1 text-xs text-ink-tertiary">(archived)</span>}
                  {r.platform && <div className="text-xs text-ink-tertiary">{r.platform}</div>}
                </td>
                <td className={td}>{formatNumber(r.sessions)}</td>
                <td className={td}>
                  {perf.availability.bookingEngine.state === "available" ? formatNumber(r.bookingEngineVisits) : "—"}
                </td>
                <td className={td}>{formatNumber(r.confirmedBookings)}</td>
                <td className={td}>{r.mixedCurrency ? "Mixed" : money(r.attributedRevenue, r.currency)}</td>
                <td className={td}>{r.sessions > 0 ? formatPercent(r.confirmedBookings / r.sessions) : "—"}</td>
                <td className={td}>{formatNumber(r.couponRedemptions)}</td>
                <td className="px-4 py-2.5 text-right"><ConfidenceBadge confidence={r.confidence} /></td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
