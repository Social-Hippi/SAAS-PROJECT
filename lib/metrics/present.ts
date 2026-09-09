import {
  formatCurrency,
  formatMultiple,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import {
  METRIC_LABEL,
  METRIC_TOOLTIP,
  toNullable,
  type MetricValue,
} from "@/lib/metrics/metric-value";

// ─────────────────────────────────────────────────────────────────────────────
// Rendering a MetricValue.
//
// THE single place a metric becomes a string. Every KPI card, table cell and
// funnel stage goes through here, which is what stops one screen inventing its
// own "—" or, worse, its own `?? 0`.
//
// Two rules it enforces for free:
//   • an unknown renders as its LABEL ("Not attributable"), never as a number
//     and never as a bare dash that reads like a styling accident;
//   • an unknown is visually DEMOTED. A missing figure rendered in the same bold
//     hero type as a real one still reads as a result at a glance.
// ─────────────────────────────────────────────────────────────────────────────

export type MetricFormat =
  | "number"
  | "currency"
  | "currencyCompact"
  | "percent"
  | "multiple";

function formatKnown(value: number, format: MetricFormat): string {
  switch (format) {
    case "currency":
      return formatCurrency(value);
    case "currencyCompact":
      return formatCurrency(value, { compact: true });
    case "percent":
      return formatPercent(value);
    case "multiple":
      return formatMultiple(value);
    default:
      return formatNumber(value);
  }
}

export type PresentedMetric = {
  /** What to show. Either a formatted number or an owner-facing state label. */
  text: string;
  /** Hover copy: the exact value, or why there isn't one. */
  title: string;
  known: boolean;
  /** Tailwind classes that demote an unknown so it cannot read as a result. */
  className: string;
};

export function presentMetric(
  m: MetricValue<number>,
  format: MetricFormat = "number",
): PresentedMetric {
  if (m.state === "ok") {
    return {
      text: formatKnown(m.value, format),
      // Compact forms (₹7.6L) hide precision; the title restores it.
      title: format === "currencyCompact" ? formatCurrency(m.value) : formatKnown(m.value, format),
      known: true,
      className: "text-ink",
    };
  }
  return {
    text: METRIC_LABEL[m.state],
    title: METRIC_TOOLTIP[m.state] + (m.reason ? ` — ${m.reason}` : ""),
    known: false,
    // Smaller and quieter than a real figure: an unknown is context, not a result.
    className: "text-ink-tertiary",
  };
}

/**
 * Build a KpiStrip card from metrics rather than from strings, so an unknown
 * cannot reach the strip already formatted as "0".
 *
 * The delta is dropped whenever either period is unknown — `percentChange`
 * already refuses to compute one, and showing "→ 0.0%" beside "Not attributable"
 * would assert that nothing changed.
 */
export function metricKpiCard(spec: {
  label: string;
  current: MetricValue<number>;
  previous?: MetricValue<number>;
  change?: MetricValue<number>;
  format?: MetricFormat;
  goodWhenUp?: boolean;
  hint?: string;
  valueClassName?: string;
}): {
  label: string;
  value: string;
  title?: string;
  delta: number | null;
  goodWhenUp?: boolean;
  valueClassName?: string;
  hint?: string;
} {
  const shown = presentMetric(spec.current, spec.format ?? "number");
  const delta = spec.change ? toNullable(spec.change) : null;

  return {
    label: spec.label,
    value: shown.text,
    title: shown.title,
    delta,
    goodWhenUp: spec.goodWhenUp,
    // An unknown keeps the muted class even if the caller wanted a colour: the
    // colour would be claiming a judgement about a number we do not have.
    valueClassName: shown.known ? spec.valueClassName : `${shown.className} !text-base font-semibold`,
    hint: shown.known ? spec.hint : undefined,
  };
}
