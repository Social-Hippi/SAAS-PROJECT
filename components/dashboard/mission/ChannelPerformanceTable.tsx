import type { ChannelRow } from "@/lib/attribution";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format";

// The flagship multi-touch view: per-source performance under the selected
// attribution model. Pure presentation — the page precomputes one ChannelRow[]
// per model and AttributionPanel hands the active set down here. Dark theme.

function prettySource(s: string): string {
  if (s === "Direct") return "Direct";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function roas(v: number | null): string {
  return v == null ? "—" : `${v.toFixed(1)}×`;
}

// Header cells carry a tooltip (title) explaining the metric per the spec.
function Th({
  children,
  hint,
  right,
}: {
  children: React.ReactNode;
  hint: string;
  right?: boolean;
}) {
  return (
    <th
      title={hint}
      className={`px-4 py-2 font-medium ${right ? "text-right" : "text-left"}`}
    >
      <span className="cursor-help border-b border-dotted border-line-strong">
        {children}
      </span>
    </th>
  );
}

export function ChannelPerformanceTable({
  rows,
  showRoas = true,
}: {
  rows: ChannelRow[];
  /**
   * False on a surface where ad spend is withheld. True ROAS is credited revenue
   * ÷ this channel's spend, and revenue is in the row beside it — so leaving the
   * column in would hand the reader the spend by division.
   */
  showRoas?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-ink-tertiary">
        No attributed traffic in this range yet. Tag your links with{" "}
        <code className="rounded bg-code px-1 py-0.5 text-xs text-codeink">utm_source</code>{" "}
        so journeys can be split by channel.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-card border border-line bg-card shadow-card">
      <table className="ht-table w-full text-left text-sm">
        <thead className="border-b border-line text-xs uppercase tracking-wide text-ink-tertiary">
          <tr>
            <Th hint="The traffic source (utm_source). Direct / untagged visits group as 'Direct'.">
              Source
            </Th>
            <Th right hint="Distinct visitors whose journey touched this channel. Independent of the model.">
              Visitors brought
            </Th>
            <Th right hint="Credited bookings ÷ visitors brought. Shifts with the attribution model.">
              Conv. rate
            </Th>
            <Th right hint="Bookings credited to this channel under the selected model (fractional in Strategic View).">
              Bookings
            </Th>
            <Th right hint="Booking value credited to this channel under the selected model.">
              Revenue
            </Th>
            {showRoas && (
              <Th right hint="Credited revenue ÷ this channel's ad spend. Shown only for paid channels with known spend.">
                True ROAS
              </Th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.source} className="border-t border-line">
              <td className="px-4 py-2 font-medium text-ink">{prettySource(r.source)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink-secondary">
                {formatNumber(r.visitorsBrought)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-ink-secondary">
                {r.visitorsBrought > 0 ? formatPercent(r.conversionRate) : "—"}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-ink">
                {r.bookings.toFixed(1)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-ink">
                {formatCurrency(r.revenue, { compact: true })}
              </td>
              {showRoas && (
                <td className="px-4 py-2 text-right tabular-nums">
                  <span className={r.trueRoas == null ? "text-ink-disabled" : "text-success"}>
                    {roas(r.trueRoas)}
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
