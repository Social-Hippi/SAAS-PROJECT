import { formatPercent } from "@/lib/format";
import { presentMetric } from "@/lib/metrics/present";
import { isOk } from "@/lib/metrics/metric-value";
import type { AttributionHealth } from "@/lib/metrics/attribution-health";

// Attribution Health — the panel that decides whether an owner can trust the
// rest of the dashboard.
//
// It leads with coverage because that single number qualifies every other figure
// on the page: at 72% coverage, ROAS is a floor, not a measurement. Hiding that
// would make the other numbers look better and the product worth less.
//
// A hotel with no booking system connected gets an explanation, not an empty
// panel of zeros — "we cannot see your reservations" is a different and far more
// actionable statement than "you had no reservations".

function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone: "good" | "warn" | "bad" | "muted";
  title?: string;
}) {
  const cls = {
    good: "text-success",
    warn: "text-warning",
    bad: "text-danger",
    muted: "text-ink-tertiary",
  }[tone];
  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${cls}`} title={title}>
        {value}
      </p>
    </div>
  );
}

export function AttributionHealthPanel({ health }: { health: AttributionHealth }) {
  const coverage = presentMetric(health.coverage, "percent");
  const total = presentMetric(health.totalBookings);
  const attributed = presentMetric(health.attributedBookings);
  const partial = presentMetric(health.partiallyAttributedBookings);
  const unattributed = presentMetric(health.unattributedBookings);

  const pct = isOk(health.coverage) ? health.coverage.value : null;
  const coverageTone = pct == null ? "muted" : pct >= 0.8 ? "good" : pct >= 0.5 ? "warn" : "bad";

  return (
    <section className="overflow-hidden rounded-card border border-line bg-card shadow-card">
      <div className="border-b border-line px-4 py-3 sm:px-5">
        <h2 className="font-medium text-ink">Attribution health</h2>
        <p className="mt-0.5 text-sm text-ink-tertiary">
          How much of your booking activity we can confidently connect back to your marketing.
        </p>
      </div>

      {!health.bookingSource.connected ? (
        <div className="px-4 py-8 text-center sm:px-5">
          <p className="text-sm font-medium text-ink">Bookings aren&apos;t connected yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink-tertiary">
            Your agency hasn&apos;t linked this hotel&apos;s booking system, so we don&apos;t
            receive your reservations. Until then we can show what your marketing generated in
            visits and enquiries, but not which of those became bookings.
          </p>
          <p className="mt-3 text-xs text-ink-disabled">
            This is why bookings and revenue read &ldquo;Not traceable&rdquo; rather than zero.
          </p>
        </div>
      ) : (
        <>
          <div className="border-b border-line px-4 py-4 sm:px-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
                  Booking attribution
                </p>
                <p
                  className={`mt-1 text-4xl font-bold tabular-nums ${
                    coverageTone === "good"
                      ? "text-success"
                      : coverageTone === "warn"
                        ? "text-warning"
                        : coverageTone === "bad"
                          ? "text-danger"
                          : "text-ink-tertiary"
                  }`}
                  title={coverage.title}
                >
                  {coverage.text}
                </p>
              </div>
              {pct != null && pct < 1 && (
                <p className="max-w-sm text-sm text-ink-tertiary">
                  Because some bookings can&apos;t be traced to a campaign, your true return is
                  likely <span className="font-medium text-ink">higher</span> than the figures
                  shown elsewhere on this page.
                </p>
              )}
            </div>

            {/* Proportional bar — the split at a glance, before any reading. */}
            {isOk(health.totalBookings) && health.totalBookings.value > 0 && (
              <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-elevated">
                {isOk(health.attributedBookings) && (
                  <div
                    className="bg-success"
                    style={{
                      width: `${(health.attributedBookings.value / health.totalBookings.value) * 100}%`,
                    }}
                    title={`${health.attributedBookings.value} attributed`}
                  />
                )}
                {isOk(health.partiallyAttributedBookings) && (
                  <div
                    className="bg-warning"
                    style={{
                      width: `${(health.partiallyAttributedBookings.value / health.totalBookings.value) * 100}%`,
                    }}
                    title={`${health.partiallyAttributedBookings.value} partially attributed`}
                  />
                )}
                {isOk(health.unattributedBookings) && (
                  <div
                    className="bg-line-strong"
                    style={{
                      width: `${(health.unattributedBookings.value / health.totalBookings.value) * 100}%`,
                    }}
                    title={`${health.unattributedBookings.value} not attributable`}
                  />
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 px-4 py-4 sm:grid-cols-4 sm:px-5">
            <Stat label="Bookings" value={total.text} tone="muted" title={total.title} />
            <Stat label="Attributed" value={attributed.text} tone="good" title={attributed.title} />
            <Stat
              label="Partially attributed"
              value={partial.text}
              tone="warn"
              title={partial.title}
            />
            <Stat
              label="Not attributable"
              value={unattributed.text}
              tone="muted"
              title={unattributed.title}
            />
          </div>

          {health.reasons.length > 0 && (
            <div className="border-t border-line px-4 py-3 sm:px-5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
                Why some bookings couldn&apos;t be traced
              </p>
              <ul className="mt-2 space-y-1">
                {health.reasons.map((r) => (
                  <li key={r.label} className="flex items-start justify-between gap-3 text-sm">
                    <span className="text-ink-secondary">{r.label}</span>
                    <span className="shrink-0 tabular-nums text-ink-tertiary">{r.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {health.bookingsMissingAmount > 0 && (
            <p className="border-t border-line px-4 py-3 text-xs text-ink-tertiary sm:px-5">
              {health.bookingsMissingAmount} reservation
              {health.bookingsMissingAmount === 1 ? "" : "s"} arrived without a value, so they count
              towards bookings but not revenue.
            </p>
          )}

          {pct != null && (
            <p className="border-t border-line px-4 py-3 text-xs text-ink-disabled sm:px-5">
              Coverage is {formatPercent(pct)} of reservations in this period. Attributed and
              partially attributed bookings both count towards it; partially attributed means we
              know a visit was involved but not which one.
            </p>
          )}
        </>
      )}
    </section>
  );
}
