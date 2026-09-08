import { formatCurrency, formatNumber } from "@/lib/format";
import type { InfluencerPerfRow } from "@/lib/influencer-dashboard";

// Influencer Performance (Phase R2) — per-influencer redemptions + attributed
// revenue for this hotel + period, with the snippet-vs-manual capture split.
// Presentational only; rows are computed server-side (agency-scoped).

export function InfluencerPerformance({
  rows,
  viewerIsAgency = true,
}: {
  rows: InfluencerPerfRow[];
  /**
   * False on the public /share report. The empty state is a call to action on an
   * agency admin page ("create influencers & codes"), which a hotel reading its
   * own report can neither reach nor act on — so it gets the fact, not the task.
   */
  viewerIsAgency?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-ink-tertiary">
        {viewerIsAgency ? (
          <>
            No coupon redemptions in this period yet. Create influencers &amp; codes under{" "}
            <span className="text-ink-secondary">Influencers &amp; Coupons</span>, then redemptions
            appear here as bookings use those codes (or you log them manually).
          </>
        ) : (
          <>No influencer coupon redemptions in this period.</>
        )}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="ht-table w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-tertiary">
            <th className="px-4 py-2 font-medium">Influencer</th>
            <th className="px-4 py-2 text-right font-medium">Active codes</th>
            <th className="px-4 py-2 text-right font-medium">Redemptions</th>
            <th className="px-4 py-2 text-right font-medium">Revenue</th>
            <th className="px-4 py-2 text-right font-medium">Avg booking</th>
            <th className="px-4 py-2 text-right font-medium">Auto / Manual</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.influencerId} className="border-b border-line/60 last:border-0">
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink">{r.name}</span>
                  {r.instagramHandle && (
                    <span className="text-xs text-ink-tertiary">
                      @{r.instagramHandle.replace(/^@/, "")}
                    </span>
                  )}
                  {r.archived && (
                    <span className="rounded-full bg-line/50 px-1.5 py-0.5 text-[10px] uppercase text-ink-tertiary">
                      Archived
                    </span>
                  )}
                </div>
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">{formatNumber(r.activeCodes)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(r.redemptions)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums font-medium" title={formatCurrency(r.revenue)}>
                {formatCurrency(r.revenue, { compact: true })}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">
                {formatCurrency(Math.round(r.averageBookingValue))}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-xs text-ink-tertiary">
                {formatNumber(r.snippetCount)} / {formatNumber(r.manualCount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
