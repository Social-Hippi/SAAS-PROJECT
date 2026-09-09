import { describe, expect, test } from "vitest";

import {
  ok,
  isOk,
  toNullable,
  ratio,
  sum,
  percentChange,
  notAttributable,
  notTraceable,
  unavailable,
  notApplicable,
  METRIC_LABEL,
  METRIC_TOOLTIP,
  METRIC_UNKNOWN_STATES,
} from "@/lib/metrics/metric-value";
import { classifyClickTarget } from "@/lib/metrics/intent";
import { resolveRange, previousRangeOf, RANGE_PRESETS } from "@/lib/attribution";
import {
  classifyMetaObjective,
  classifyGoogleChannelType,
  campaignTypeTooltip,
  isConversionOriented,
  CAMPAIGN_TYPE_LABEL,
} from "@/lib/metrics/campaign-type";

// ─────────────────────────────────────────────────────────────────────────────
// "HotelTrack must NEVER lie to the hotel owner."
//
// Every test here defends ONE property: a number we could not measure must never
// render as a number we did. The failure mode is always the same shape — some
// call site coerces a missing value with `?? 0` — so these tests assert that the
// type makes that impossible and that every derived rate propagates uncertainty
// instead of laundering it into a confident zero.
// ─────────────────────────────────────────────────────────────────────────────

describe("1. a verified zero and a missing value are different things", () => {
  test("ok(0) is a value, not an absence", () => {
    const zero = ok(0);
    expect(isOk(zero)).toBe(true);
    expect(toNullable(zero)).toBe(0);
  });

  test("an unknown yields null, never 0", () => {
    for (const m of [
      notAttributable("x"),
      notTraceable("x"),
      unavailable("x"),
      notApplicable("x"),
    ]) {
      expect(isOk(m)).toBe(false);
      expect(toNullable(m)).toBeNull();
    }
  });

  test("every unknown state carries owner-facing copy, not an internal key", () => {
    for (const state of METRIC_UNKNOWN_STATES) {
      const label = METRIC_LABEL[state];
      const tip = METRIC_TOOLTIP[state];
      expect(label, state).toBeTruthy();
      // No snake_case leaking into the UI.
      expect(label, state).not.toMatch(/_/);
      expect(tip.length, state).toBeGreaterThan(30);
      // Business language: no jargon the owner would have to look up.
      for (const jargon of ["FBCLID", "GCLID", "utm_", "null", "undefined", "API"]) {
        expect(tip.toUpperCase(), `${state} / ${jargon}`).not.toContain(jargon.toUpperCase());
      }
    }
  });
});

describe("2. ratios propagate uncertainty instead of inventing zero", () => {
  test("an unknown numerator makes the ratio unknown", () => {
    const r = ratio(notAttributable("no revenue could be tied to this"), ok(1000));
    expect(r.state).toBe("not_attributable");
  });

  test("an unknown denominator makes the ratio unknown", () => {
    const r = ratio(ok(5000), unavailable("ad account disconnected"));
    expect(r.state).toBe("unavailable");
  });

  test("the numerator's uncertainty wins when both are unknown", () => {
    // "We don't know the revenue" is the more informative answer for ROAS.
    const r = ratio(notAttributable("a"), unavailable("b"));
    expect(r.state).toBe("not_attributable");
  });

  test("dividing by zero is not applicable — never Infinity, never 0", () => {
    const r = ratio(ok(1000), ok(0));
    expect(r.state).toBe("not_applicable");
    expect(toNullable(r)).toBeNull();
  });

  test("a real zero over a real denominator is a real zero", () => {
    // ROAS of 0 when spend happened and no revenue followed IS a finding.
    const r = ratio(ok(0), ok(5000));
    expect(r).toEqual({ state: "ok", value: 0 });
  });

  test("ROAS shape: revenue that cannot be attributed never reads as 0×", () => {
    const roas = ratio(notAttributable("bookings could not be tied to campaigns"), ok(72000));
    expect(roas.state).toBe("not_attributable");
    expect(toNullable(roas)).not.toBe(0);
  });
});

describe("3. sums refuse to report a silently-low total", () => {
  test("one unknown addend makes the whole sum unknown", () => {
    const total = sum([ok(10), notTraceable("calls are not tracked"), ok(5)]);
    expect(total.state).toBe("not_traceable");
  });

  test("an empty list is a verified zero", () => {
    expect(sum([])).toEqual({ state: "ok", value: 0 });
  });

  test("all-known addends add up", () => {
    expect(sum([ok(1), ok(2), ok(3)])).toEqual({ state: "ok", value: 6 });
  });
});

describe("4. period comparison", () => {
  test("no previous figure is not a 0% change", () => {
    const change = percentChange(ok(120), ok(0));
    expect(change.state).toBe("not_applicable");
  });

  test("an unknown on either side is not a change of zero", () => {
    expect(percentChange(ok(120), notTraceable("x")).state).toBe("not_traceable");
    expect(percentChange(unavailable("x"), ok(10)).state).toBe("unavailable");
  });

  test("a real change is a fraction", () => {
    const change = percentChange(ok(118), ok(100));
    expect(isOk(change) && change.value).toBeCloseTo(0.18, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Intent classification. A false positive INVENTS customer intent, so the bar
// for matching is deliberately higher than for missing one.
// ─────────────────────────────────────────────────────────────────────────────

describe("5. click-target classification is conservative", () => {
  test("recognises the obvious intent targets", () => {
    const cases: [string, string][] = [
      ["book-now-button", "booking_intent"],
      ["check-availability", "booking_intent"],
      ["booking-engine-link", "booking_intent"],
      ["call-now", "call"],
      ["header-phone", "call"],
      ["click-to-call", "call"],
      ["whatsapp-float", "whatsapp"],
      ["wa-me-link", "whatsapp"],
      ["enquiry-form-submit", "enquiry_intent"],
      ["contact-us", "enquiry_intent"],
    ];
    for (const [target, expected] of cases) {
      expect(classifyClickTarget(target), target).toBe(expected);
    }
  });

  test("a WhatsApp enquiry is a WhatsApp conversation, not a form", () => {
    // Order matters: the channel is the more useful fact for the owner.
    expect(classifyClickTarget("whatsapp-enquiry")).toBe("whatsapp");
  });

  test("a call-to-book is a phone call, not a booking", () => {
    expect(classifyClickTarget("call-to-book")).toBe("call");
  });

  test("unrelated targets are NOT guessed into an intent bucket", () => {
    // Under-counting is recoverable; inventing intent is not.
    for (const target of [
      "hero-image",
      "gallery-next",
      "newsletter-signup",
      "menu-toggle",
      "language-switcher",
      "cookie-accept",
    ]) {
      expect(classifyClickTarget(target), target).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Date ranges. Every comparison on the dashboard rests on these two windows
// being right, and off-by-one month maths is invisible until it is embarrassing.
// ─────────────────────────────────────────────────────────────────────────────

describe("6. date ranges", () => {
  // 12:00Z is 17:30 on 17 March in Asia/Kolkata, the default property timezone.
  // Every boundary below is therefore an IST day expressed as a UTC instant:
  // local midnight is 18:30Z on the PREVIOUS date.
  const now = new Date("2026-03-17T12:00:00.000Z");
  const at = (now: Date) => ({ now });

  test("the existing preset ids still resolve exactly as before", () => {
    // Live share links, exports and bookmarks carry these.
    for (const key of ["7", "30", "90"]) {
      const r = resolveRange({ range: key }, at(now));
      expect(r.key, key).toBe(key);
      expect(r.label, key).toBe(`Last ${key} days`);
      // Whole property days: the window ends at the end of today IST.
      expect(r.until.toISOString(), key).toBe("2026-03-17T18:29:59.999Z");
    }
  });

  test("rolling windows cover whole property days, inclusive of today", () => {
    const r = resolveRange({ range: "7" }, at(now));
    // 7 days = today plus the six before it.
    expect(r.since.toISOString()).toBe("2026-03-10T18:30:00.000Z");
    expect(r.dateLabel).toBe("11–17 Mar 2026");
  });

  test("an unknown range falls back to 30 days, not to an empty window", () => {
    expect(resolveRange({ range: "nonsense" }, at(now)).key).toBe("30");
  });

  test("today is the property's day, not the UTC day", () => {
    // The defect this fixes: under UTC, "Today" for an IST property began at
    // 05:30 local and ended at 05:29 the next morning.
    const r = resolveRange({ range: "today" }, at(now));
    expect(r.since.toISOString()).toBe("2026-03-16T18:30:00.000Z");
    expect(r.until.toISOString()).toBe("2026-03-17T18:29:59.999Z");
  });

  test("yesterday is a whole property day, not a rolling 24 hours", () => {
    const r = resolveRange({ range: "yesterday" }, at(now));
    expect(r.since.toISOString()).toBe("2026-03-15T18:30:00.000Z");
    expect(r.until.toISOString()).toBe("2026-03-16T18:29:59.999Z");
  });

  test("this month runs from the 1st, in the property timezone", () => {
    const r = resolveRange({ range: "this_month" }, at(now));
    expect(r.since.toISOString()).toBe("2026-02-28T18:30:00.000Z");
  });

  test("previous month is the whole calendar month, in the property timezone", () => {
    const r = resolveRange({ range: "prev_month" }, at(now));
    expect(r.since.toISOString()).toBe("2026-01-31T18:30:00.000Z");
    expect(r.until.toISOString()).toBe("2026-02-28T18:29:59.999Z");
  });

  test("every preset in the selector actually resolves to itself", () => {
    for (const p of RANGE_PRESETS) {
      expect(resolveRange({ range: p.key }, at(now)).key, p.key).toBe(p.key);
    }
  });

  test("a custom range wins over a preset", () => {
    const r = resolveRange({ range: "7", from: "2026-01-01", to: "2026-01-31" }, at(now));
    expect(r.key).toBe("custom");
    expect(r.fromInput).toBe("2026-01-01");
    expect(r.toInput).toBe("2026-01-31");
  });

  test("a rolling window compares against an equal-length window immediately before", () => {
    const r = resolveRange({ range: "30" }, at(now));
    const prev = previousRangeOf(r);
    // Abutting, not overlapping: the comparison ends 1ms before the range starts.
    expect(prev.until.getTime()).toBe(r.since.getTime() - 1);
    expect(prev.until.getTime() - prev.since.getTime()).toBe(r.until.getTime() - r.since.getTime());
  });

  test("a calendar month compares against the previous CALENDAR month", () => {
    // A same-length window would double-count two days of February against a
    // 31-day March, which is the classic silent reporting bug.
    const r = resolveRange({ range: "this_month" }, at(now));
    const prev = previousRangeOf(r);
    expect(prev.since.toISOString()).toBe("2026-01-31T18:30:00.000Z");
    expect(prev.until.toISOString()).toBe("2026-02-28T18:29:59.999Z");
  });

  test("month comparison holds across a year boundary", () => {
    const jan = new Date("2026-01-09T09:00:00.000Z");
    const prev = previousRangeOf(resolveRange({ range: "this_month" }, at(jan)));
    expect(prev.since.toISOString()).toBe("2025-11-30T18:30:00.000Z");
    expect(prev.until.toISOString()).toBe("2025-12-31T18:29:59.999Z");
  });

  test("every comparison is labelled with literal dates, never 'previous period'", () => {
    for (const key of ["7", "30", "this_month", "prev_month", "today"]) {
      const prev = previousRangeOf(resolveRange({ range: key }, at(now)));
      expect(prev.label, key).toMatch(/\d/);
      expect(prev.label.toLowerCase(), key).not.toContain("previous period");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Campaign taxonomy. Two platforms with genuinely different concepts behind one
// column, so the mapping has to be explicit and the approximation has to be
// admitted rather than hidden.
// ─────────────────────────────────────────────────────────────────────────────

describe("7. campaign type normalisation", () => {
  test("Meta objectives map to the dashboard taxonomy, current and legacy", () => {
    const cases: [string, string][] = [
      ["OUTCOME_LEADS", "lead_generation"],
      ["LEAD_GENERATION", "lead_generation"],
      ["OUTCOME_SALES", "sales_conversion"],
      ["CONVERSIONS", "sales_conversion"],
      ["OUTCOME_TRAFFIC", "traffic"],
      ["LINK_CLICKS", "traffic"],
      ["OUTCOME_AWARENESS", "awareness"],
      ["REACH", "awareness"],
      ["OUTCOME_ENGAGEMENT", "engagement"],
      ["VIDEO_VIEWS", "engagement"],
    ];
    for (const [objective, expected] of cases) {
      expect(classifyMetaObjective(objective).type, objective).toBe(expected);
    }
  });

  test("SALES and LEAD GENERATION are both conversion-oriented, and stay distinct", () => {
    // The brief asked for sales to be analysed ALONGSIDE lead gen, not merged
    // into it: an owner running both wants to see which is which.
    const sales = classifyMetaObjective("OUTCOME_SALES").type;
    const leads = classifyMetaObjective("OUTCOME_LEADS").type;
    expect(sales).not.toBe(leads);
    expect(isConversionOriented(sales)).toBe(true);
    expect(isConversionOriented(leads)).toBe(true);
    expect(isConversionOriented(classifyMetaObjective("REACH").type)).toBe(false);
  });

  test("an unrecognised or missing objective is 'unknown', never 'other'", () => {
    // "We have not classified this" and "this is genuinely miscellaneous" are
    // different claims; only the second is a finding.
    expect(classifyMetaObjective("SOME_NEW_META_OBJECTIVE").type).toBe("unknown");
    expect(classifyMetaObjective(null).type).toBe("unknown");
    expect(classifyMetaObjective("  ").type).toBe("unknown");
    expect(CAMPAIGN_TYPE_LABEL.unknown).toBe("Not available");
  });

  test("Google is classified by channel type, and says so", () => {
    const search = classifyGoogleChannelType("SEARCH");
    expect(search.type).toBe("sales_conversion");
    expect(search.basis).toBe("channel_type");
    expect(classifyGoogleChannelType("PERFORMANCE_MAX").type).toBe("sales_conversion");
    expect(classifyGoogleChannelType("DISPLAY").type).toBe("awareness");
  });

  test("the tooltip never presents a Google channel as a declared objective", () => {
    const tip = campaignTypeTooltip(classifyGoogleChannelType("SEARCH"));
    expect(tip).toMatch(/Google/);
    expect(tip).toMatch(/campaign type/i);
    // Meta's tooltip may say "objective"; Google's must not claim one exists.
    expect(tip).not.toMatch(/objective set/i);

    const metaTip = campaignTypeTooltip(classifyMetaObjective("OUTCOME_SALES"));
    expect(metaTip).toMatch(/objective/i);
  });

  test("a missing objective explains itself in business language", () => {
    const tip = campaignTypeTooltip(classifyMetaObjective(null));
    expect(tip).toMatch(/wasn't recorded/i);
    for (const jargon of ["null", "undefined", "column", "API"]) {
      expect(tip.toLowerCase()).not.toContain(jargon.toLowerCase());
    }
  });
});
