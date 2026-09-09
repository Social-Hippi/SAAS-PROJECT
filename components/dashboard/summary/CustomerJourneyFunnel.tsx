import { presentMetric } from "@/lib/metrics/present";
import { isOk } from "@/lib/metrics/metric-value";
import type { FunnelStage } from "@/lib/metrics/summary-dashboard";

// The customer journey, readable in about five seconds.
//
// ADAPTIVE BY DESIGN. The funnel shows the steps it can actually measure, at
// full size, with proportional bars. Steps this hotel is not instrumented for
// are collected into ONE quiet line at the bottom rather than repeated as six
// identical "Not traceable" rows.
//
// That is a presentation decision, not a truthfulness one. The information is
// still there and still accurate — it simply stops dominating a panel whose job
// is to show what IS happening. A wall of grey placeholders makes a hotel with
// 5,768 engaged visitors look like a hotel with nothing, which is its own kind
// of misreporting.

function StageRow({ stage, top }: { stage: FunnelStage; top: number | null }) {
  const shown = presentMetric(stage.value, stage.key === "revenue" ? "currencyCompact" : "number");
  const rate = presentMetric(stage.conversionFromPrevious, "percent");

  const width =
    isOk(stage.value) && top != null && top > 0
      ? Math.max(2, Math.min(100, (stage.value.value / top) * 100))
      : null;

  return (
    <li className="py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-sm font-medium text-ink">{stage.label}</span>
          <span
            className="cursor-help text-xs text-ink-disabled"
            title={stage.hint}
            aria-label={stage.hint}
          >
            ⓘ
          </span>
        </div>
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-semibold tabular-nums text-ink" title={shown.title}>
            {shown.text}
          </span>
          {isOk(stage.conversionFromPrevious) && (
            <span
              className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-brand"
              title={`${rate.text} of the step above reached this one`}
            >
              {rate.text}
            </span>
          )}
        </div>
      </div>
      {width != null && (
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-elevated">
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand to-brand/70"
            style={{ width: `${width}%` }}
          />
        </div>
      )}
    </li>
  );
}

export function CustomerJourneyFunnel({ stages }: { stages: FunnelStage[] }) {
  const measured = stages.filter((s) => isOk(s.value));
  const unmeasured = stages.filter((s) => !isOk(s.value));

  const first = measured[0];
  const top = first && isOk(first.value) ? first.value.value : null;

  return (
    <section className="overflow-hidden rounded-card border border-line bg-card shadow-card">
      <div className="border-b border-line px-4 py-3 sm:px-5">
        <h2 className="font-medium text-ink">Customer journey</h2>
        <p className="mt-0.5 text-sm text-ink-tertiary">
          How visitors move through your site, step by step.
        </p>
      </div>

      {measured.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-tertiary sm:px-5">
          We don&apos;t have enough tracking on this site yet to map the journey.
        </p>
      ) : (
        <ul className="divide-y divide-line px-4 sm:px-5">
          {measured.map((s) => (
            <StageRow key={s.key} stage={s} top={top} />
          ))}
        </ul>
      )}

      {/* Every gap, once, quietly — not once per row. */}
      {unmeasured.length > 0 && (
        <div className="border-t border-line bg-elevated/40 px-4 py-3 sm:px-5">
          <p className="text-xs text-ink-tertiary">
            <span className="font-medium text-ink-secondary">Not tracked yet:</span>{" "}
            {unmeasured.map((s, i) => (
              <span key={s.key}>
                {i > 0 && ", "}
                <span
                  className="cursor-help underline decoration-dotted underline-offset-2"
                  title={
                    s.value.state === "ok" ? s.hint : `${s.hint} — ${s.value.reason}`
                  }
                >
                  {s.label.toLowerCase()}
                </span>
              </span>
            ))}
            . Adding this tracking would complete the picture below the visits.
          </p>
        </div>
      )}
    </section>
  );
}
