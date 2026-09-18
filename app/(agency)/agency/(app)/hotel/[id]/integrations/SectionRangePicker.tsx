import Link from "next/link";

import type { ResolvedRange } from "@/lib/attribution";
import { SECTION_PRESETS, type SectionRangeState } from "@/lib/section-range";

/**
 * Preset chips plus a Custom range, for one section of the Integrations page.
 *
 * A plain GET form, so the custom range works with no client JavaScript and
 * lands in the URL like the presets do — shareable, and it survives a reload.
 *
 * The literal dates are ALWAYS shown, and so is anything resolveRange had to
 * change about a custom request (swapped, pulled back from the future, capped).
 * A window that was quietly altered is a wrong number with no signal — which is
 * exactly how "Last year" once showed thirty days.
 */
export function SectionRangePicker({
  basePath,
  prefix,
  state,
  resolved,
  preserve,
  anchor,
}: {
  basePath: string;
  /** Query-param prefix for this section, e.g. "lbp". */
  prefix: string;
  state: SectionRangeState;
  resolved: ResolvedRange;
  /** Other sections' params, carried so this one never resets them. */
  preserve: Record<string, string>;
  anchor: string;
}) {
  const carried = new URLSearchParams(preserve).toString();
  const href = (key: string) =>
    `${basePath}?${prefix}=${key}${carried ? `&${carried}` : ""}#${anchor}`;
  const isCustom = state.key === "custom";

  const chip = (active: boolean) =>
    `rounded-lg border px-3 py-1.5 ${
      active
        ? "border-brand bg-brand text-white"
        : "border-line-strong bg-card text-ink-secondary hover:bg-line-strong"
    }`;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-2 text-sm">
        {SECTION_PRESETS.map(([key, label]) => (
          <Link key={key} href={href(key)} className={chip(state.key === key)}>
            {label}
          </Link>
        ))}

        {/* <details> opens without JavaScript, and starts open when a custom
            range is in force so the dates in use are visible and editable. */}
        <details open={isCustom} className="group">
          <summary className={`${chip(isCustom)} cursor-pointer list-none`}>Custom</summary>
          <form
            method="get"
            action={`${basePath}#${anchor}`}
            className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-card p-3"
          >
            <input type="hidden" name={prefix} value="custom" />
            {Object.entries(preserve).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <label className="flex flex-col gap-1 text-xs text-ink-tertiary">
              From
              <input
                type="date"
                name={`${prefix}From`}
                defaultValue={resolved.fromInput}
                required
                className="rounded-lg border border-line-strong bg-card px-2 py-1.5 text-sm text-ink"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-tertiary">
              To
              <input
                type="date"
                name={`${prefix}To`}
                defaultValue={resolved.toInput}
                required
                className="rounded-lg border border-line-strong bg-card px-2 py-1.5 text-sm text-ink"
              />
            </label>
            <button
              type="submit"
              className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover"
            >
              Apply
            </button>
          </form>
        </details>
      </div>

      <p className="text-xs text-ink-tertiary">
        Showing <span className="font-medium text-ink-secondary">{resolved.dateLabel}</span>
      </p>
      {resolved.adjustments.length > 0 && (
        <ul className="rounded-lg border-l-4 border-warning bg-warning/10 p-3 text-xs text-ink-secondary">
          {resolved.adjustments.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
