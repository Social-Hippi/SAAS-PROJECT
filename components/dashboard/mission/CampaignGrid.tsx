"use client";

import { useState } from "react";
import { formatCurrency, formatMultiple, formatNumber, formatPercent } from "@/lib/format";
import { Sparkline } from "./Sparkline";

// Campaign performance as a card grid (3-up on desktop) replacing the old table.
// Each card leads with True ROAS, carries a status badge + 7-day sparkline, and
// opens a detail modal. Client component for the modal interaction.

export type CampaignCard = {
  campaignKey: string;
  campaignName: string;
  spend: number;
  realBookings: number;
  realRevenue: number;
  realRoas: number | null;
  metaBookings: number;
  metaRevenue: number;
  impressions: number;
  clicks: number;
  /** clicks / impressions */
  ctr: number;
  /** Meta-vs-real booking variance %, null when Meta reported 0. */
  variancePct: number | null;
  /** Last-7-days spend (or chosen metric) for the sparkline. */
  spark: number[];
};

type Status = { label: string; cls: string };
function statusOf(c: CampaignCard): Status {
  if (c.realRoas != null && c.realRoas > 4) return { label: "Winning ★", cls: "bg-success/15 text-success ring-success/30" };
  if (c.realRoas != null && c.realRoas < 2 && c.spend > 0) return { label: "Losing", cls: "bg-danger/15 text-danger ring-danger/30" };
  return { label: "Test", cls: "bg-warning/15 text-warning ring-warning/30" };
}
function roasColor(roas: number | null): string {
  if (roas == null) return "text-ink-disabled";
  if (roas > 4) return "text-success";
  if (roas >= 2) return "text-warning";
  return "text-danger";
}

const NOT_LINKED =
  "Booking confirmations are not linked to sessions yet, so bookings from this campaign have not been measured. This is not a measurement of zero.";

/** A designed unavailable state: legible, neutral, and carrying its reason. */
function Unmeasured() {
  return (
    <span className="text-sm font-medium text-ink-disabled" title={NOT_LINKED}>
      Not measured
    </span>
  );
}

export function CampaignGrid({
  cards,
  bookingsLinked,
}: {
  cards: CampaignCard[];
  /**
   * Whether any booking confirmation has ever been joined to a campaign.
   *
   * When false, realBookings / realRevenue / realRoas / variancePct are NOT
   * zero — they are unmeasured. Rendering "0 real bookings" and "−100% vs Meta"
   * on every campaign asserted, permanently and on every period, a measurement
   * that was never taken.
   */
  bookingsLinked: boolean;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = cards.find((c) => c.campaignKey === openKey) ?? null;

  if (cards.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-line-strong bg-card/50 px-6 py-14 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand/10 text-2xl">📈</div>
        <p className="text-sm font-semibold text-ink">No campaign attribution yet</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-ink-tertiary">
          Add <code className="rounded bg-elevated px-1 py-0.5 text-xs text-codeink">utm_campaign</code> tags to your Meta
          ads to start matching real bookings to the campaigns that drove them.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => {
          const st = statusOf(c);
          return (
            <button
              key={c.campaignKey}
              type="button"
              onClick={() => setOpenKey(c.campaignKey)}
              className="group rounded-card border border-line bg-card p-5 text-left shadow-card transition hover:-translate-y-0.5 hover:border-line-strong hover:shadow-card-hover"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="line-clamp-2 text-sm font-semibold text-ink">{c.campaignName}</h3>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${st.cls}`}>
                  {st.label}
                </span>
              </div>

              <div className="mt-4 flex items-end justify-between">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">True ROAS</p>
                  <p className={`text-4xl font-semibold tracking-tight tabular-nums ${roasColor(c.realRoas)}`}>
                    {formatMultiple(c.realRoas)}
                  </p>
                </div>
                <Sparkline values={c.spark} />
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">Spend</p>
                  <p className="text-sm font-semibold tabular-nums text-ink">{formatCurrency(c.spend)}</p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">Real bookings</p>
                  {bookingsLinked ? (
                    <p className="text-sm font-semibold tabular-nums text-ink">{formatNumber(c.realBookings)}</p>
                  ) : (
                    <Unmeasured />
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setOpenKey(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-card border border-line bg-elevated p-6 shadow-float"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-ink">{open.campaignName}</h3>
                <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${statusOf(open).cls}`}>
                  {statusOf(open).label}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setOpenKey(null)}
                className="rounded p-1 text-ink-tertiary hover:bg-card"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="mt-5 rounded-card bg-card p-4 text-center">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">True ROAS</p>
              <p className={`text-5xl font-semibold tracking-tight tabular-nums ${roasColor(open.realRoas)}`}>
                {bookingsLinked ? formatMultiple(open.realRoas) : <Unmeasured />}
              </p>
            </div>

            <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
              <Detail label="Spend" value={formatCurrency(open.spend)} />
              <Detail
                label="Real revenue"
                value={bookingsLinked ? formatCurrency(open.realRevenue) : "Not measured"}
                valueClass={bookingsLinked ? undefined : "text-ink-disabled"}
              />
              <Detail
                label="Real bookings"
                value={bookingsLinked ? formatNumber(open.realBookings) : "Not measured"}
                valueClass={bookingsLinked ? undefined : "text-ink-disabled"}
              />
              <Detail label="Meta-claimed bookings" value={formatNumber(open.metaBookings)} />
              <Detail label="Impressions" value={formatNumber(open.impressions)} />
              <Detail label="Clicks" value={formatNumber(open.clicks)} />
              <Detail label="CTR" value={formatPercent(open.ctr)} />
              {/* NOT labelled "variance" — that word means nothing to a hotelier.
                  The column name stays variancePct; what a client reads is what
                  the number actually says. */}
              <Detail
                label="Not confirmed in your records"
                value={
                  !bookingsLinked
                    ? "Not measured"
                    : open.variancePct == null
                      ? "—"
                      : `${open.variancePct > 0 ? "+" : ""}${Math.round(open.variancePct)}%`
                }
                valueClass={
                  !bookingsLinked
                    ? "text-ink-disabled"
                    : open.variancePct != null && open.variancePct > 50
                      ? "text-danger"
                      : "text-ink"
                }
                hint="The share of the conversions this platform reports that the property's own records do not confirm. Higher means more of the platform's claim is unverified."
              />
            </dl>

            <div className="mt-5">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">Last 7 days spend</p>
              <Sparkline values={open.spark} width={300} height={48} className="h-12" />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Detail({
  label,
  value,
  valueClass = "text-ink",
  hint,
}: {
  label: string;
  value: string;
  valueClass?: string;
  /** Rendered under the value, so an unfamiliar metric explains itself in place. */
  hint?: string;
}) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">{label}</dt>
      <dd className={`mt-0.5 text-base font-semibold tabular-nums ${valueClass}`}>{value}</dd>
      {hint && <dd className="mt-0.5 text-[11px] leading-snug text-ink-tertiary">{hint}</dd>}
    </div>
  );
}
