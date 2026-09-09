import { formatNumber, formatPercent } from "@/lib/format";
import { isOk } from "@/lib/metrics/metric-value";
import type { DemandComposition as Row } from "@/lib/metrics/demand-source";

// Where demand came from, as horizontal bars ordered by visits.
//
// Bars, not a pie: a pie makes seven shares comparable only by area, which is
// the one visual comparison people are reliably bad at, and it cannot show a
// period-over-period change at all. Sessions ride as a secondary number rather
// than a second bar — two bars per row would invite reading the gap between them
// as meaningful when it is just visits-per-session.
//
// A bucket with no baseline in the comparison window shows no change at all,
// with the reason. It is not +100% (which asserts growth from a measured zero)
// and not 0% (which asserts nothing changed). We did not measure it.

export function DemandComposition({
  rows,
  totalVisits,
  periodLabel,
  comparisonLabel,
  scopeLabel,
}: {
  rows: Row[];
  totalVisits: number;
  periodLabel: string;
  comparisonLabel: string | null;
  /** Which property this covers — the bars are meaningless without it. */
  scopeLabel: string;
}) {
  if (rows.length === 0) {
    return (
      <section className="rounded-card border border-line bg-card p-4 shadow-card sm:p-5">
        <h2 className="font-medium text-ink">Where demand came from</h2>
        <p className="mt-2 text-sm text-ink-tertiary">
          No visits were recorded in this period, so there is nothing to break down.
        </p>
      </section>
    );
  }

  const max = Math.max(...rows.map((r) => r.visits), 1);

  return (
    <section className="rounded-card border border-line bg-card p-4 shadow-card sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-medium text-ink">Where demand came from</h2>
        {/* The caption carries the period, so a forwarded screenshot still says
            what it covers and which property it describes. */}
        <p className="text-xs text-ink-tertiary">
          {scopeLabel} · {periodLabel}
          {comparisonLabel ? ` · vs ${comparisonLabel}` : ""}
        </p>
      </div>

      <ul className="mt-4 space-y-3">
        {rows.map((r) => (
          <li key={r.bucket}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
              <span className="font-medium text-ink-secondary">{r.label}</span>
              <span className="tabular-nums text-ink-tertiary">
                <span className="font-semibold text-ink">{formatNumber(r.visits)}</span> visits ·{" "}
                {formatPercent(r.share)}
                <span className="text-ink-disabled"> · {formatNumber(r.sessions)} sessions</span>
              </span>
            </div>

            <div className="mt-1 flex items-center gap-3">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-elevated">
                <div
                  className="h-full rounded-full bg-brand"
                  style={{ width: `${Math.max(1, (r.visits / max) * 100)}%` }}
                />
              </div>
              <span className="w-28 shrink-0 text-right text-xs tabular-nums">
                {isOk(r.change) ? (
                  <span className={r.change.value >= 0 ? "text-success" : "text-danger"}>
                    {r.change.value >= 0 ? "+" : ""}
                    {formatPercent(r.change.value)}
                  </span>
                ) : (
                  <span
                    className="text-ink-disabled"
                    title={"reason" in r.change ? r.change.reason : undefined}
                  >
                    no baseline
                  </span>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-xs text-ink-tertiary">
        {formatNumber(totalVisits)} visits in total. &ldquo;No source attached&rdquo; mixes direct
        visits, organic search and untagged links; those cannot be separated from one another with
        the data available.
      </p>
    </section>
  );
}
