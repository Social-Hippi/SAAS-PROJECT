import { RANGE_PRESETS, type ResolvedRange } from "@/lib/attribution";
import { zonedDayString } from "@/lib/timezone";

// The reporting-period control, rendered FROM the already-resolved period.
//
// It takes `range` rather than reading the URL itself, so the control and the
// figures below it can never disagree: there is one resolution per request, on
// the server, and this renders it. A selector that re-derived its own dates is
// the same defect class as a panel that does.
//
// NO JAVASCRIPT. Presets are plain links and the custom range is a native GET
// form, so the control works in an email client's browser, on a throttled phone,
// and with scripting disabled — the conditions a hotel owner actually opens a
// forwarded report in. `<input type="date">` is the platform's own picker; a
// date-picker dependency would be a larger bundle for a worse result.
//
// EVERY BOUND IS RE-VALIDATED SERVER-SIDE. `max` below is a courtesy to the
// browser, not a control: the URL is public and hand-editable, so resolveRange
// parses strictly and clamps regardless of what arrives.

export function PeriodSelector({
  basePath,
  range,
  preserve = {},
}: {
  basePath: string;
  range: ResolvedRange;
  /** Other query params that must survive a period change (source, channel, …). */
  preserve?: Record<string, string | undefined>;
}) {
  const kept = Object.entries(preserve).filter(([, v]) => Boolean(v)) as [string, string][];

  const hrefFor = (key: string) => {
    const params = new URLSearchParams();
    if (key !== "30") params.set("range", key);
    for (const [k, v] of kept) params.set(k, v);
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  const chip = (active: boolean) =>
    `rounded-lg border px-3 py-1.5 text-sm font-medium ${
      active
        ? "border-brand bg-brand text-white"
        : "border-line-strong bg-elevated text-ink-secondary hover:bg-line-strong"
    }`;

  const isCustom = range.key === "custom";
  const today = zonedDayString(new Date(), range.timezone);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {RANGE_PRESETS.map((r) => (
          <a key={r.key} href={hrefFor(r.key)} className={chip(r.key === range.key)}>
            {r.label}
          </a>
        ))}

        <details open={isCustom} className="relative">
          <summary className={`${chip(isCustom)} cursor-pointer list-none select-none`}>
            Custom
          </summary>
          <form
            method="get"
            action={basePath}
            className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-card p-3 shadow-card sm:absolute sm:right-0 sm:z-10 sm:mt-2 sm:w-max sm:max-w-[min(22rem,calc(100vw-2rem))]"
          >
            {kept.map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <label className="flex flex-col gap-1 text-xs text-ink-tertiary">
              From
              <input
                type="date"
                name="from"
                max={today}
                defaultValue={range.fromInput}
                className="rounded-md border border-line-strong bg-elevated px-2 py-1 text-sm text-ink"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-tertiary">
              To
              <input
                type="date"
                name="to"
                max={today}
                defaultValue={range.toInput}
                className="rounded-md border border-line-strong bg-elevated px-2 py-1 text-sm text-ink"
              />
            </label>
            <button
              type="submit"
              className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white"
            >
              Apply
            </button>
          </form>
        </details>
      </div>

      {/* The active window, always as literal dates. A report is read weeks
          after it is sent; "Last 30 days" alone does not say which thirty. */}
      <p className="text-sm text-ink-tertiary">
        Showing <span className="font-medium text-ink-secondary">{range.dateLabel}</span>
        <span className="text-ink-disabled"> · times shown in {range.timezone.replace("_", " ")}</span>
      </p>

      {/* A clamped range is a different report from the one that was asked for.
          Saying so is the difference between a correction and a silent swap. */}
      {range.adjustments.length > 0 && (
        <ul className="space-y-0.5 text-xs text-warning">
          {range.adjustments.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
