"use client";

import { useMemo, useState } from "react";
import { formatCurrency, formatMultiple, formatNumber } from "@/lib/format";

// Sortable campaign↔booking table for the "Campaign performance" dashboard
// section. Pure display: the server page aggregates CampaignPerformance rows
// over the selected range and passes one row per campaign.

export type CampaignRow = {
  campaignKey: string;
  campaignName: string;
  /** True for the "Direct / Unattributed" bucket (pinned last, no variance). */
  unattributed: boolean;
  spend: number;
  realBookings: number;
  realRevenue: number;
  /** realRevenue / spend; null when spend is 0. */
  realRoas: number | null;
  metaConversions: number;
};

type SortKey = "campaignName" | "spend" | "realBookings" | "realRevenue" | "realRoas";

function roasColor(roas: number | null): string {
  if (roas == null) return "text-ink-disabled";
  if (roas > 4) return "text-success";
  if (roas >= 2) return "text-warning";
  return "text-danger";
}

const NOT_LINKED =
  "Booking confirmations are not linked to sessions yet, so bookings from this campaign have not been measured. This is not a measurement of zero.";

/** "Meta says" cell: Meta's claim + how far it is from our measured bookings. */
function metaVerdict(
  row: CampaignRow,
  bookingsLinked: boolean,
): { text: string; badge: "ok" | "warn" | null } {
  const meta = row.metaConversions;
  const real = row.realBookings;
  const claim = `"${formatNumber(meta)} booking${meta === 1 ? "" : "s"}"`;

  // With no booking link there is nothing to check Meta's claim AGAINST. Saying
  // "none tracked on-site" would read as a contradiction of Meta when it is
  // really the absence of our own measurement.
  if (!bookingsLinked) {
    return { text: `${claim} — not yet checkable against confirmed bookings`, badge: null };
  }

  if (real === 0) {
    if (meta === 0) return { text: claim, badge: "ok" };
    return { text: `${claim} — none tracked on-site`, badge: "warn" };
  }
  const diffPct = ((meta - real) / real) * 100;
  if (Math.abs(meta - real) <= 0.25 * real) {
    return { text: `${claim} (close match)`, badge: "ok" };
  }
  if (diffPct > 50) {
    return { text: `${claim} (${Math.round(diffPct)}% inflated)`, badge: "warn" };
  }
  if (diffPct > 0) return { text: `${claim} (${Math.round(diffPct)}% higher)`, badge: null };
  return { text: `${claim} (${Math.round(-diffPct)}% lower)`, badge: null };
}

export function CampaignPerformanceTable({
  rows,
  bookingsLinked,
}: {
  rows: CampaignRow[];
  /**
   * Whether booking confirmations are linked back to campaigns at all.
   *
   * When false, realBookings / realRevenue / realRoas are NOT zero — they are
   * unmeasured, because no confirmation has ever been joined to a session. A
   * literal 0 and a −100% variance in these columns asserted a result nobody
   * took, on every campaign, permanently.
   */
  bookingsLinked: boolean;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("realRoas");
  const [dir, setDir] = useState<1 | -1>(-1); // default: highest True ROAS first

  const sorted = useMemo(() => {
    const campaigns = rows.filter((r) => !r.unattributed);
    const rest = rows.filter((r) => r.unattributed); // pinned last, never a campaign
    campaigns.sort((a, b) => {
      if (sortKey === "campaignName") {
        return a.campaignName.localeCompare(b.campaignName) * dir;
      }
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
      return (Number(av) - Number(bv)) * dir;
    });
    return [...campaigns, ...rest];
  }, [rows, sortKey, dir]);

  function onSort(key: SortKey) {
    if (key === sortKey) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setDir(key === "campaignName" ? 1 : -1);
    }
  }

  const arrow = (key: SortKey) =>
    sortKey === key ? (dir === -1 ? " ↓" : " ↑") : "";

  const TH = ({
    label,
    k,
    right,
  }: {
    label: string;
    k?: SortKey;
    right?: boolean;
  }) => (
    <th
      className={`px-4 py-3 font-medium ${right ? "text-right" : ""} ${k ? "cursor-pointer select-none hover:text-ink" : ""}`}
      onClick={k ? () => onSort(k) : undefined}
    >
      {label}
      {k ? arrow(k) : ""}
    </th>
  );

  return (
    <div className="overflow-x-auto">
      <table className="ht-table w-full text-left text-sm">
        <thead className="bg-elevated text-xs uppercase tracking-wide text-ink-tertiary">
          <tr>
            <TH label="Campaign" k="campaignName" />
            <TH label="Spend" k="spend" right />
            <TH label="Bookings (real)" k="realBookings" right />
            <TH label="Revenue (real)" k="realRevenue" right />
            <TH label="True ROAS" k="realRoas" right />
            <TH label="Meta says" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const verdict = r.unattributed ? null : metaVerdict(r, bookingsLinked);
            return (
              <tr
                key={r.campaignKey}
                className={`border-t border-line ${r.unattributed ? "bg-elevated/40 text-ink-tertiary" : ""}`}
              >
                <td className="px-4 py-3 font-medium">
                  {r.campaignName}
                  {r.unattributed && (
                    <span className="ml-2 text-xs font-normal text-ink-disabled">
                      not blamed on any campaign
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {r.unattributed ? "—" : formatCurrency(r.spend)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {bookingsLinked ? (
                    formatNumber(r.realBookings)
                  ) : (
                    <span className="text-ink-disabled" title={NOT_LINKED}>—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {bookingsLinked ? (
                    formatCurrency(r.realRevenue)
                  ) : (
                    <span className="text-ink-disabled" title={NOT_LINKED}>—</span>
                  )}
                </td>
                <td
                  className={`px-4 py-3 text-right font-semibold tabular-nums ${
                    r.unattributed || !bookingsLinked ? "" : roasColor(r.realRoas)
                  }`}
                >
                  {!bookingsLinked ? (
                    <span className="text-ink-disabled" title={NOT_LINKED}>—</span>
                  ) : r.unattributed ? (
                    "—"
                  ) : (
                    formatMultiple(r.realRoas)
                  )}
                </td>
                <td className="px-4 py-3">
                  {verdict == null ? (
                    <span className="text-ink-disabled">—</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      {verdict.badge === "ok" && (
                        <span className="text-success">✓</span>
                      )}
                      {verdict.badge === "warn" && (
                        <span className="text-warning">⚠</span>
                      )}
                      <span className="text-ink-secondary">
                        {verdict.text}
                      </span>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
