import { presentMetric, type MetricFormat } from "@/lib/metrics/present";
import { isOk, type MetricValue } from "@/lib/metrics/metric-value";
import { CAMPAIGN_TYPE_LABEL, campaignTypeTooltip } from "@/lib/metrics/campaign-type";
import type { PaidPerformance, PaidCampaignRow } from "@/lib/metrics/paid-performance";

// Per-campaign performance for one paid platform.
//
// ADAPTIVE COLUMNS. Cost columns disappear entirely when the agency has chosen
// not to share spend — a column of "N/A" is worse than no column, because the
// reader spends attention discovering it is empty. Same rule for verified
// bookings and ROAS on a platform where we have no verified join: the panel says
// so once, beneath the table, instead of repeating it on every row.
//
// Every cell is a MetricValue, so a campaign with genuinely zero clicks shows 0
// while one whose bookings we cannot connect shows "Not attributable" — the
// distinction the whole product turns on, at the row level.

function Cell({
  metric,
  format = "number",
  align = "right",
}: {
  metric: MetricValue<number>;
  format?: MetricFormat;
  align?: "left" | "right";
}) {
  const p = presentMetric(metric, format);
  return (
    <td
      className={`px-3 py-2.5 tabular-nums ${align === "right" ? "text-right" : ""} ${
        p.known ? "text-ink" : "text-ink-disabled text-xs"
      }`}
      title={p.title}
    >
      {p.text}
    </td>
  );
}

function Th({ children, right, hint }: { children: React.ReactNode; right?: boolean; hint?: string }) {
  return (
    <th
      scope="col"
      title={hint}
      className={`whitespace-nowrap px-3 py-2 font-medium ${right ? "text-right" : "text-left"} ${
        hint ? "cursor-help" : ""
      }`}
    >
      {children}
    </th>
  );
}

function TypeBadge({ row }: { row: PaidCampaignRow }) {
  const known = row.type.type !== "unknown";
  return (
    <span
      title={campaignTypeTooltip(row.type)}
      className={`inline-flex cursor-help whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${
        known ? "bg-brand/10 text-brand" : "bg-elevated text-ink-disabled"
      }`}
    >
      {CAMPAIGN_TYPE_LABEL[row.type.type]}
    </span>
  );
}

export function PaidPerformanceTable({ data }: { data: PaidPerformance }) {
  const { rows, totals, platformLabel, connected, hasVerifiedBookings } = data;

  // Spend is either shared or it is not — one row tells us which.
  const showCosts = rows.length === 0 ? isOk(totals.spend) : isOk(rows[0].spend);

  // DATA WINS OVER CONNECTION STATE, and the empty state never claims more than
  // it knows.
  //
  // Two separate tables feed the paid views: AdSnapshot (account-level totals,
  // which the panel below this one reads) and AdCampaignSnapshot (the
  // per-campaign breakdown this table needs). A hotel can easily have the first
  // and not the second — and it may have both while carrying no live MetaToken
  // row at all.
  //
  // The first version of this gated on the token and announced "Meta Ads isn't
  // connected" directly above a panel reporting ₹1L of spend from the same
  // account. Two statements on one screen that could not both be true is the
  // fastest way to lose a reader's trust in everything else on the page.
  //
  // So: absence of THESE rows is reported as absence of a per-campaign
  // breakdown, which is all it actually proves.
  if (rows.length === 0) {
    return (
      <section className="overflow-hidden rounded-card border border-line bg-card shadow-card">
        <div className="border-b border-line px-4 py-3 sm:px-5">
          <h2 className="font-medium text-ink">{platformLabel} performance</h2>
        </div>
        <p className="px-4 py-10 text-center text-sm text-ink-tertiary sm:px-5">
          {connected
            ? `No ${platformLabel} campaigns ran in this period.`
            : `We don't have a per-campaign breakdown of your ${platformLabel} activity for this period.`}
        </p>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-card border border-line bg-card shadow-card">
      <div className="border-b border-line px-4 py-3 sm:px-5">
        <h2 className="font-medium text-ink">{platformLabel} performance</h2>
        <p className="mt-0.5 text-sm text-ink-tertiary">
          Every campaign that ran in this period, strongest spend first.
        </p>
      </div>

      <div className="overflow-x-auto">
          <table className="ht-table w-full text-left text-sm">
            <thead className="bg-elevated text-xs uppercase tracking-wide text-ink-tertiary">
              <tr>
                <Th hint="What this campaign was set up to achieve.">Type</Th>
                <Th>Campaign</Th>
                <Th right hint="How many times your ads were shown.">Impressions</Th>
                <Th right hint="How many people clicked through to your site.">Clicks</Th>
                <Th right hint="Click-through rate: clicks ÷ impressions.">CTR</Th>
                {showCosts && <Th right hint="Cost per click: spend ÷ clicks.">CPC</Th>}
                <Th right hint="Conversions the advertising platform reports it caused.">
                  Conversions
                </Th>
                {showCosts && (
                  <Th right hint="Cost per lead: spend ÷ platform-reported conversions.">CPL</Th>
                )}
                {showCosts && <Th right hint="What you spent on this campaign.">Spend</Th>}
                <Th right hint="Reservations we could connect to this campaign on your own website.">
                  Bookings
                </Th>
                {showCosts && (
                  <Th right hint="Return on ad spend: booking revenue we verified ÷ spend.">
                    ROAS
                  </Th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.campaignId} className="border-t border-line">
                  <td className="px-3 py-2.5">
                    <TypeBadge row={r} />
                  </td>
                  <td className="max-w-[18rem] truncate px-3 py-2.5 font-medium text-ink" title={r.campaignName}>
                    {r.campaignName}
                  </td>
                  <Cell metric={r.impressions} />
                  <Cell metric={r.clicks} />
                  <Cell metric={r.ctr} format="percent" />
                  {showCosts && <Cell metric={r.cpc} format="currency" />}
                  <Cell metric={r.conversions} />
                  {showCosts && <Cell metric={r.cpl} format="currency" />}
                  {showCosts && <Cell metric={r.spend} format="currencyCompact" />}
                  <Cell metric={r.bookings} />
                  {showCosts && <Cell metric={r.roas} format="multiple" />}
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-line-strong bg-elevated/60 text-sm font-semibold">
              <tr>
                <td className="px-3 py-2.5 text-ink-tertiary" colSpan={2}>
                  Total · {rows.length} campaign{rows.length === 1 ? "" : "s"}
                </td>
                <Cell metric={totals.impressions} />
                <Cell metric={totals.clicks} />
                <Cell metric={totals.ctr} format="percent" />
                {showCosts && <td />}
                <Cell metric={totals.conversions} />
                {showCosts && <td />}
                {showCosts && <Cell metric={totals.spend} format="currencyCompact" />}
                <Cell metric={totals.bookings} />
                {showCosts && <Cell metric={totals.roas} format="multiple" />}
              </tr>
            </tfoot>
          </table>
      </div>

      {/* Said once, beneath the table, rather than on every row. */}
      {!hasVerifiedBookings && (
        <p className="border-t border-line bg-elevated/40 px-4 py-3 text-xs text-ink-tertiary sm:px-5">
          <span className="font-medium text-ink-secondary">About bookings and ROAS:</span> we
          couldn&apos;t connect reservations on your website back to these campaigns for this
          period, so those columns read &ldquo;Not attributable&rdquo; rather than zero. The
          conversions column above is what {platformLabel} itself reports.
        </p>
      )}
    </section>
  );
}
