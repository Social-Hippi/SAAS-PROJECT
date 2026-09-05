import { ContentPerformanceTable } from "@/components/report/ContentPerformanceTable";
import { SpendChart } from "@/components/report/SpendChart";
import {
  formatCurrency,
  formatCurrencyCents,
  formatMultiple,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import type { HotelReport } from "@/lib/report-data";

const RANGES = [
  { key: "7", label: "7d" },
  { key: "30", label: "30d" },
  { key: "90", label: "90d" },
] as const;

function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-tertiary">{hint}</p>}
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-card">
      <div className="border-b border-line px-4 py-3">
        <h2 className="font-medium text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-ink-tertiary">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

export function PublicReport({
  token,
  hotelName,
  websiteUrl,
  agencyName,
  rangeKey,
  rangeLabel,
  report,
}: {
  token: string;
  hotelName: string;
  websiteUrl: string;
  agencyName: string;
  rangeKey: string;
  rangeLabel: string;
  report: HotelReport;
}) {
  const { kpis, contentPerf, ads, influencerRows, realRoi, otaSavings, showAdSpend } = report;
  const paidCampaigns = contentPerf.filter((c) => c.contentType === "paid_ad");

  return (
    <div className="min-h-full bg-page">
      <header className="border-b border-line">
        <div className="mx-auto w-full max-w-3xl px-4 py-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-ink-disabled">
            HotelTrack
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">{hotelName}</h1>
          <p className="mt-0.5 text-sm text-ink-tertiary">
            Report shared by {agencyName} · {websiteUrl}
          </p>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
        {/* Range selector (read-only navigation) */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex gap-2">
            {RANGES.map((r) => {
              const active = r.key === rangeKey;
              return (
                <a
                  key={r.key}
                  href={`/share/${token}?range=${r.key}`}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                    active
                      ? "border-brand bg-brand text-white"
                      : "border-line-strong bg-elevated text-ink-secondary hover:bg-line-strong"
                  }`}
                >
                  Last {r.label}
                </a>
              );
            })}
          </div>
          <span className="hidden text-sm text-ink-tertiary sm:inline">{rangeLabel}</span>
        </div>

        {/* KPIs. Cost/booking and Overall ROAS are spend-derived, so they only
            appear when spend is shared with the hotel (showAdSpend). */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiCard label="Visits" value={formatNumber(kpis.visits)} />
          <KpiCard label="Bookings" value={formatNumber(kpis.bookings)} />
          <KpiCard label="Tracked booking revenue" value={formatCurrency(kpis.revenue)} />
          {showAdSpend && (
            <>
              <KpiCard
                label="Cost / booking"
                value={kpis.costPerBooking == null ? "—" : formatCurrencyCents(kpis.costPerBooking)}
                hint="Paid ad spend ÷ paid bookings"
              />
              <KpiCard
                label="Overall ROAS"
                value={formatMultiple(kpis.roas)}
                hint="Paid revenue ÷ paid ad spend"
              />
            </>
          )}
        </div>

        {/* Commission Saved vs OTAs (Part 7) — owner-facing savings highlight. */}
        {otaSavings.amount > 0 && (
          <div className="rounded-xl border border-success/30 bg-success/10 px-4 py-3">
            <p className="text-sm text-ink-secondary">
              Your agency saved you{" "}
              <span className="font-semibold text-success">{formatCurrency(otaSavings.amount)}</span> this
              period by driving direct bookings instead of OTA bookings (at a {otaSavings.rate}% OTA
              commission rate).
            </p>
          </div>
        )}

        {/* Content performance */}
        <SectionCard
          title="Content performance"
          subtitle="Every content piece, attributed to the bookings it drove."
        >
          <ContentPerformanceTable rows={contentPerf} />
        </SectionCard>

        {/* Paid ads. Ad spend, Meta ROAS, True ROI and the spend-over-time chart
            are spend figures, shown only when spend is shared (showAdSpend).
            "Bookings from ads" and the campaign breakdown are outcomes and always
            show. */}
        <SectionCard title="Paid ads performance">
          <div
            className={`grid gap-px border-b border-line bg-line ${
              showAdSpend ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-1"
            }`}
          >
            {showAdSpend && (
              <div className="bg-card p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">Ad spend</p>
                {/* Phase 0: the COMBINED paid spend (Meta + Google) — the same
                    basis the "Overall ROAS" KPI above divides by. This tile used
                    to show `ads.spend`, which is Meta-only, so on a hotel running
                    Google Ads the spend shown and the spend the ROAS used were
                    different numbers. Null (currencies not safely combinable)
                    renders "—", never ₹0: an unavailable total must not read as
                    "no spend". */}
                <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
                  {kpis.spend == null ? "—" : formatCurrency(kpis.spend)}
                </p>
                {kpis.spend == null ? (
                  <p className="mt-0.5 text-xs text-ink-tertiary">
                    Ad accounts report in different currencies
                  </p>
                ) : (
                  kpis.spendByPlatform.google > 0 && (
                    <p className="mt-0.5 text-xs text-ink-tertiary">
                      {formatCurrency(kpis.spendByPlatform.meta, { compact: true })} Meta ·{" "}
                      {formatCurrency(kpis.spendByPlatform.google, { compact: true })} Google
                    </p>
                  )
                )}
              </div>
            )}
            <div className="bg-card p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                Bookings from ads
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
                {formatNumber(ads.bookingsFromAds)}
              </p>
            </div>
            {showAdSpend && (
              <>
                <div className="bg-card p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">Meta ROAS</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{formatMultiple(ads.metaRoas)}</p>
                </div>
                <div className="bg-card p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">True ROI</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums text-ink">
                    {realRoi == null ? "—" : formatPercent(realRoi)}
                  </p>
                </div>
              </>
            )}
          </div>
          {showAdSpend && (
            <div className="p-4">
              {/* `ads.spendOverTime` is Meta-only (it comes from AdSnapshot), so
                  it is labelled as such — otherwise it reads as a breakdown of
                  the combined "Ad spend" tile above. */}
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                Meta spend over time
              </p>
              <SpendChart data={ads.spendOverTime} />
            </div>
          )}
          {paidCampaigns.length > 0 && (
            <div className="border-t border-line">
              <p className="px-4 pt-4 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                Campaign breakdown
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-ink-tertiary">
                    <tr>
                      <th className="px-4 py-2 font-medium">Campaign</th>
                      <th className="px-4 py-2 text-right font-medium">Sessions</th>
                      <th className="px-4 py-2 text-right font-medium">Bookings</th>
                      <th className="px-4 py-2 text-right font-medium">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paidCampaigns.map((c) => (
                      <tr key={c.id} className="border-t border-line">
                        <td className="px-4 py-2 font-medium">{c.title}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {formatNumber(c.sessions)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {formatNumber(c.bookings)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {formatCurrency(c.revenue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </SectionCard>

        {/* Influencer impact */}
        {influencerRows.length > 0 && (
          <SectionCard
            title="Influencer impact"
            subtitle="Coupon redemptions and revenue per influencer collaboration."
          >
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-elevated text-xs uppercase tracking-wide text-ink-tertiary">
                  <tr>
                    <th className="px-4 py-3 font-medium">Influencer</th>
                    <th className="px-4 py-3 font-medium">Coupon</th>
                    <th className="px-4 py-3 text-right font-medium">Redemptions</th>
                    <th className="px-4 py-3 text-right font-medium">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {influencerRows.map((r) => (
                    <tr key={r.id} className="border-t border-line">
                      <td className="px-4 py-3">
                        <div className="font-medium">{r.influencerName}</div>
                        <div className="text-xs text-ink-tertiary">{r.title}</div>
                      </td>
                      <td className="px-4 py-3">
                        {r.couponCode ? (
                          <code className="rounded bg-code px-1.5 py-0.5 text-xs text-codeink">
                            {r.couponCode}
                          </code>
                        ) : (
                          <span className="text-ink-disabled">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatNumber(r.redemptions)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatCurrency(r.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        )}

        <p className="pt-2 text-center text-xs text-ink-disabled">
          Powered by HotelTrack · This is a private, read-only report.
        </p>
      </main>
    </div>
  );
}
