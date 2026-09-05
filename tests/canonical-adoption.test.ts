import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import { NO_CLICK_IDS } from "@/lib/source-classifier";
import { aggregateRevenueBySource, type ConversionRow } from "@/lib/revenue-by-source";
import { canonicalSourceType, isPaidRow, paidRevenueOf } from "@/lib/metrics/canonical";

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL ADOPTION — the migration this suite exists to force.
//
// lib/metrics/canonical.ts was written to be THE classifier and THE revenue sum,
// replacing classifySourceType() and rowSourceType() at every revenue call site.
// It is currently inert: nothing under app/ or components/ imports it, and the
// two functions it replaces are still live across nine files that disagree with
// each other about the same booking.
//
// Part 1 pins the behaviour the migration bought: one classifier, one answer,
// with grouping and type answering their own separate questions.
// Part 2 is the adoption gate — no listed file may decide paid-ness or sum
// revenue through the legacy classifiers again.
// ─────────────────────────────────────────────────────────────────────────────

// ── Part 1 · The behavioural defect ──────────────────────────────────────────

/**
 * One booking carrying BOTH signals: a coupon code AND a paid Meta click
 * (utm_medium "cpc" matches PAID_MEDIUM in lib/source-classifier.ts).
 *
 * This is not a contrived row. It is what an influencer whose link is also
 * promoted as a paid ad produces, and it is the exact shape the two classifiers
 * answer differently.
 */
const AMBIGUOUS: ConversionRow = {
  ...NO_CLICK_IDS,
  utmSource: "facebook",
  utmMedium: "cpc",
  utmCampaign: "monsoon-launch",
  utmContent: null,
  couponCode: "PRIYA10",
  value: 42_000,
  occurredAt: new Date("2026-08-01T00:00:00.000Z"),
};

describe("1. one classifier, one answer", () => {
  // Was: an assertion that classifySourceType and rowSourceType DISAGREE on this
  // row — classifySourceType said meta_ads, rowSourceType said influencer, so the
  // same ₹42,000 was paid revenue on the agency dashboard and non-paid in the
  // overview API. Both functions are gone from every revenue path, so the test
  // now asserts the property their removal bought: one answer, whoever asks.
  test("a coupon on a paid click is paid media, not influencer", () => {
    expect(canonicalSourceType(AMBIGUOUS)).toBe("meta_ads");
    expect(isPaidRow(AMBIGUOUS)).toBe(true);
  });

  test("its revenue reaches the ROAS numerator exactly once", () => {
    expect(paidRevenueOf([AMBIGUOUS])).toBe(42_000);
  });

  // The coupon still decides GROUPING — the booking belongs to the influencer
  // who drove it — even though its TYPE is now paid. Those two answers are
  // different questions, and the migration deliberately kept them different.
  test("grouping still credits the influencer who drove it", () => {
    const agg = aggregateRevenueBySource([AMBIGUOUS], "source", {
      start: new Date("2026-07-01T00:00:00.000Z"),
      end: new Date("2026-08-31T23:59:59.999Z"),
    });
    expect(agg.groups.map((g) => g.key)).toEqual(["influencer"]);
    expect(agg.groups[0].sourceType).toBe("meta_ads");
    expect(agg.totals.revenue).toBe(42_000);
  });
});

// ── Part 2 · The adoption gate ───────────────────────────────────────────────

/**
 * Every file that decides paid-ness or sums revenue. Each must route that
 * decision through lib/metrics/canonical.ts instead of the legacy pair.
 *
 * Asserted over source text, via readCode (comments stripped), for the same
 * reason as tests/hotel-surfaces.test.ts: the defect is which function a call
 * site reaches for, which no unit test can observe without a database and a
 * session.
 */
const REVENUE_CALL_SITES = [
  "app/(agency)/agency/(app)/dashboard/page.tsx",
  "app/api/agency/overview/route.ts",
  "app/api/agency/export/route.ts",
  "lib/alerts.ts",
  "lib/attribution.ts",
  "lib/owner-metrics.ts",
  "lib/owner-summary.ts",
  "lib/revenue-by-source.ts",
  "lib/revenue-by-source-loader.ts",
] as const;

describe("2. no revenue call site still uses the legacy classifiers", () => {
  test.each(REVENUE_CALL_SITES)("%s", (file) => {
    const code = readCode(file);
    // Comments are stripped, so a file may still EXPLAIN the migration; it just
    // may not call either function.
    expect(code, `${file} still calls classifySourceType`).not.toContain("classifySourceType");
    expect(code, `${file} still calls rowSourceType`).not.toContain("rowSourceType");
  });
});
