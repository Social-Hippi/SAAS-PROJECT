import { presentMetric } from "@/lib/metrics/present";
import { isOk } from "@/lib/metrics/metric-value";
import type { FunnelStage } from "@/lib/metrics/summary-dashboard";

// The customer journey, readable in about five seconds.
//
// Visitors → engaged → intent → contact → bookings → revenue, with the drop-off
// between each pair. The bar widths are proportional to the FIRST stage, so the
// narrowing is the message and the numbers are the detail.
//
// A stage we cannot measure keeps its place in the journey and says so. Removing
// it would imply the step does not exist for this hotel; showing 0 would imply
// nobody took it. Both are lies of a different shape.

function StageRow({ stage, top }: { stage: FunnelStage; top: number | null }) {
  const shown = presentMetric(stage.value, stage.key === "revenue" ? "currencyCompact" : "number");
  const rate = presentMetric(stage.conversionFromPrevious, "percent");

  const width =
    isOk(stage.value) && top != null && top > 0
      ? Math.max(2, Math.min(100, (stage.value.value / top) * 100))
      : null;

  return (
    <li className="py-3">
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
          <span
            className={`text-lg font-semibold tabular-nums ${shown.className}`}
            title={shown.title}
          >
            {shown.text}
          </span>
          {isOk(stage.conversionFromPrevious) && (
            <span
              className="rounded-full bg-elevated px-2 py-0.5 text-xs tabular-nums text-ink-tertiary"
              title={`${rate.text} of the step above reached this one`}
            >
              {rate.text}
            </span>
          )}
        </div>
      </div>

      {width == null ? (
        // No bar for an unmeasured stage: a zero-width bar reads as "none". The
        // caption explains WHY without repeating the label already shown on the
        // right — saying "Not traceable — Not traceable" twice reads as a bug.
        <p className="mt-1.5 text-xs text-ink-tertiary" title={shown.title}>
          {isOk(stage.value)
            ? "No visitors reached this step in this period."
            : "We can't measure this step yet — hover the label above for what's missing."}
        </p>
      ) : (
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-elevated">
          <div className="h-full rounded-full bg-brand" style={{ width: `${width}%` }} />
        </div>
      )}
    </li>
  );
}

export function CustomerJourneyFunnel({ stages }: { stages: FunnelStage[] }) {
  const first = stages[0];
  const top = first && isOk(first.value) ? first.value.value : null;

  return (
    <section className="overflow-hidden rounded-card border border-line bg-card shadow-card">
      <div className="border-b border-line px-4 py-3 sm:px-5">
        <h2 className="font-medium text-ink">Customer journey</h2>
        <p className="mt-0.5 text-sm text-ink-tertiary">
          How visitors move from arriving on your site to booking a stay.
        </p>
      </div>
      <ul className="divide-y divide-line px-4 sm:px-5">
        {stages.map((s) => (
          <StageRow key={s.key} stage={s} top={top} />
        ))}
      </ul>
    </section>
  );
}
