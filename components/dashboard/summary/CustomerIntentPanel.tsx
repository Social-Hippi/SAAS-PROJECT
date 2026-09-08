import { presentMetric } from "@/lib/metrics/present";
import { isOk } from "@/lib/metrics/metric-value";
import type { IntentComparison } from "@/lib/metrics/summary-dashboard";
import type { LastIntentRow } from "@/lib/metrics/intent";

// Customer intent — traffic → intent → contact, with the previous period beside
// it so "is this getting better?" is answerable without arithmetic.
//
// The Last Intent table below it exists because a booking that cannot be traced
// to a campaign still leaves a trail. "Eleven people reached WhatsApp, and nine
// of them arrived from Meta Ads" is real, useful, and honest — provided it is
// never presented as a booking. Hence the explicit disclaimer in the header, and
// a Sessions column rather than a Bookings one.

function ChangeBadge({ change }: { change: IntentComparison["change"] }) {
  if (!isOk(change)) {
    const p = presentMetric(change, "percent");
    return (
      <span className="text-xs text-ink-disabled" title={p.title}>
        —
      </span>
    );
  }
  const v = change.value;
  const flat = Math.abs(v) < 0.005;
  const cls = flat
    ? "bg-elevated text-ink-tertiary"
    : v > 0
      ? "bg-success/15 text-success"
      : "bg-danger/15 text-danger";
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${cls}`}>
      {flat ? "→" : v > 0 ? "↑" : "↓"} {Math.abs(v * 100).toFixed(1)}%
    </span>
  );
}

export function CustomerIntentPanel({
  comparisons,
  lastIntent,
  rangeLabel,
}: {
  comparisons: IntentComparison[];
  lastIntent: LastIntentRow[];
  rangeLabel: string;
}) {
  return (
    <section className="overflow-hidden rounded-card border border-line bg-card shadow-card">
      <div className="border-b border-line px-4 py-3 sm:px-5">
        <h2 className="font-medium text-ink">Customer intent</h2>
        <p className="mt-0.5 text-sm text-ink-tertiary">
          What visitors actually did, compared with the period before.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="ht-table w-full text-left text-sm">
          <thead className="bg-elevated text-xs uppercase tracking-wide text-ink-tertiary">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Signal</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">{rangeLabel}</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Previous</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {comparisons.map((row) => {
              const cur = presentMetric(row.current);
              const prev = presentMetric(row.previous);
              return (
                <tr key={row.label} className="border-t border-line">
                  <td className="px-4 py-2.5 font-medium text-ink">{row.label}</td>
                  <td
                    className={`px-4 py-2.5 text-right tabular-nums ${cur.className}`}
                    title={cur.title}
                  >
                    {cur.text}
                  </td>
                  <td
                    className={`px-4 py-2.5 text-right tabular-nums ${prev.className}`}
                    title={prev.title}
                  >
                    {prev.text}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <ChangeBadge change={row.change} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="border-t border-line px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
            Last intent
          </p>
          <p className="text-xs text-ink-disabled">
            The last high-intent action a visit took — not a confirmed booking
          </p>
        </div>

        {lastIntent.length === 0 ? (
          <p className="mt-2 text-sm text-ink-tertiary">
            No booking, enquiry, call or WhatsApp actions were recorded on your website in this
            period. If your site has those buttons, they may not be tagged for tracking yet.
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="ht-table w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink-tertiary">
                <tr>
                  <th scope="col" className="px-0 py-2 font-medium">Last intent</th>
                  <th scope="col" className="px-4 py-2 font-medium">Came from</th>
                  <th scope="col" className="px-0 py-2 text-right font-medium">Visits</th>
                </tr>
              </thead>
              <tbody>
                {lastIntent.map((r) => (
                  <tr key={`${r.intent}|${r.source}`} className="border-t border-line">
                    <td className="px-0 py-2 font-medium text-ink">{r.intent}</td>
                    <td className="px-4 py-2 text-ink-secondary">{r.source}</td>
                    <td className="px-0 py-2 text-right tabular-nums text-ink">{r.sessions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
