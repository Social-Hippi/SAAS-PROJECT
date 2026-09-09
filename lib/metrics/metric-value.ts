// ─────────────────────────────────────────────────────────────────────────────
// THE honest metric type.
//
// HotelTrack's product claim is trustworthy attribution, and the fastest way to
// break that claim is a number. "ROAS 0×" and "we could not connect any revenue
// to this campaign" render identically once a missing value has been coerced
// with `?? 0`, and the owner has no way to tell which one they are looking at.
// One of those statements is a business result. The other is a measurement gap.
//
// So a metric is a UNION, not a number. There is deliberately no accessor that
// hands you a number with a default — `toNullable()` returns `T | null` and
// makes you branch. You cannot write `?? 0` against a MetricValue without first
// destroying the type, which is exactly the friction this module exists to add.
//
// WHY FOUR KINDS OF "NOT A NUMBER", and why collapsing them would be a
// regression: each one implies a different action for the hotel owner.
//
//   not_attributable  The thing happened, we just cannot prove which campaign
//                     caused it. Bookings may well be higher than we credit.
//                     ACTION: improve tagging; treat ROAS as a floor.
//   not_traceable     The signal was never collected at all — no tracking
//                     exists for it. ACTION: add the tracking.
//   unavailable       We normally have this, but the integration is
//                     disconnected or the sync failed. ACTION: reconnect.
//   not_applicable    The metric is meaningless here (ROAS on an organic
//                     channel). ACTION: none — it is not a gap.
//
// And a real, verified zero stays `ok(0)`. That is a finding, and it must not
// be dressed up as a gap any more than a gap may be dressed up as a zero.
//
// No "server-only": the UI renders these, so both sides import the same module.
// ─────────────────────────────────────────────────────────────────────────────

/** The reasons a metric may carry no number. */
export const METRIC_UNKNOWN_STATES = [
  "not_attributable",
  "not_traceable",
  "unavailable",
  "not_applicable",
] as const;

export type MetricUnknownState = (typeof METRIC_UNKNOWN_STATES)[number];
export type MetricState = "ok" | MetricUnknownState;

/**
 * A metric that either holds a value or explains, in the owner's language, why
 * it does not. `reason` is display copy — never an internal key, never a stack
 * trace, never "FBCLID unavailable".
 */
export type MetricValue<T = number> =
  | { readonly state: "ok"; readonly value: T }
  | { readonly state: MetricUnknownState; readonly reason: string };

// ── Constructors ─────────────────────────────────────────────────────────────

/** A real, measured value. Use this for a verified zero too — 0 is a finding. */
export function ok<T>(value: T): MetricValue<T> {
  return { state: "ok", value };
}

/**
 * The underlying activity exists but cannot be tied to a source or conversion.
 * The honest reading is "at least this much", never "this much".
 */
export function notAttributable<T = number>(reason: string): MetricValue<T> {
  return { state: "not_attributable", reason };
}

/** The signal required to compute this was never collected. */
export function notTraceable<T = number>(reason: string): MetricValue<T> {
  return { state: "not_traceable", reason };
}

/** We normally have this, but the integration is disconnected or a sync failed. */
export function unavailable<T = number>(reason: string): MetricValue<T> {
  return { state: "unavailable", reason };
}

/** The metric does not apply in this context (ROAS on an unpaid channel). */
export function notApplicable<T = number>(reason: string): MetricValue<T> {
  return { state: "not_applicable", reason };
}

// ── Inspection ───────────────────────────────────────────────────────────────

export function isOk<T>(m: MetricValue<T>): m is { state: "ok"; value: T } {
  return m.state === "ok";
}

/**
 * The value, or null. THE ONLY unwrapper, and it returns null on purpose: a
 * `unwrapOr(metric, 0)` helper would reintroduce the exact bug this file exists
 * to prevent, one convenient call site at a time.
 */
export function toNullable<T>(m: MetricValue<T>): T | null {
  return m.state === "ok" ? m.value : null;
}

/** Display copy for a non-value state. */
export const METRIC_LABEL: Record<MetricUnknownState, string> = {
  not_attributable: "Not attributable",
  not_traceable: "Not traceable",
  unavailable: "Data unavailable",
  not_applicable: "N/A",
};

/**
 * Tooltip copy. Business language only — the owner should never have to know
 * what a click id is to understand why a number is missing.
 */
export const METRIC_TOOLTIP: Record<MetricUnknownState, string> = {
  not_attributable:
    "This activity happened, but we could not confidently connect it to a campaign. The real figure may be higher than what we credit here.",
  not_traceable:
    "The tracking needed to measure this is not set up on your website yet, so we have no data to report — this is not a zero.",
  unavailable:
    "We normally receive this from a connected account, but that connection is currently unavailable. Reconnecting it will restore the figure.",
  not_applicable: "This measure does not apply to this channel.",
};

// ── Derivation ───────────────────────────────────────────────────────────────

/**
 * Divide one metric by another, propagating uncertainty instead of laundering
 * it. Every rate on the dashboard — ROAS, CPL, CPC, CTR, conversion rate —
 * goes through here, so none of them can independently decide to return 0.
 *
 * Rules, in order:
 *   • either side unknown        → that same unknown state wins (numerator
 *                                  first: "we don't know the revenue" is a more
 *                                  informative answer than "we don't know the
 *                                  spend" when both are missing)
 *   • denominator is 0           → `notApplicable`, because x ÷ 0 is not a
 *                                  number and pretending otherwise is the bug
 *   • numerator 0, denominator>0 → ok(0), a genuine, verified zero
 */
export function ratio(
  numerator: MetricValue<number>,
  denominator: MetricValue<number>,
  opts: { zeroDenominatorReason?: string } = {},
): MetricValue<number> {
  if (numerator.state !== "ok") return numerator;
  if (denominator.state !== "ok") return denominator;
  if (denominator.value === 0) {
    return notApplicable(
      opts.zeroDenominatorReason ??
        "There is nothing to divide by in this period, so this rate cannot be calculated.",
    );
  }
  return ok(numerator.value / denominator.value);
}

/**
 * Sum metrics, refusing to invent a total from partial data.
 *
 * An unknown among the addends makes the SUM unknown — quietly skipping it
 * would report a total that is silently too low and indistinguishable from a
 * real one. An empty list is a verified zero: nothing to add really is nothing.
 */
export function sum(values: readonly MetricValue<number>[]): MetricValue<number> {
  let total = 0;
  for (const v of values) {
    if (v.state !== "ok") return v;
    total += v.value;
  }
  return ok(total);
}

/**
 * Period-over-period change as a FRACTION (0.184 = +18.4%).
 *
 * Null-ish outcomes are states, not zeros: with no previous value there is no
 * change to report, and "0%" would assert that performance held steady.
 */
export function percentChange(
  current: MetricValue<number>,
  previous: MetricValue<number>,
): MetricValue<number> {
  if (current.state !== "ok") return current;
  if (previous.state !== "ok") return previous;
  if (previous.value === 0) {
    return notApplicable("There is no previous figure to compare against.");
  }
  return ok((current.value - previous.value) / previous.value);
}
