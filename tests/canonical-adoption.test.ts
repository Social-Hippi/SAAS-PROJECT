import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import {
  NO_CLICK_IDS,
  classifySourceType,
  isPaidSourceType,
} from "@/lib/source-classifier";
import { rowSourceType, type ConversionRow } from "@/lib/revenue-by-source";
import { canonicalSourceType, isPaidRow } from "@/lib/metrics/canonical";

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL ADOPTION — the migration this suite exists to force.
//
// lib/metrics/canonical.ts was written to be THE classifier and THE revenue sum,
// replacing classifySourceType() and rowSourceType() at every revenue call site.
// It is currently inert: nothing under app/ or components/ imports it, and the
// two functions it replaces are still live across nine files that disagree with
// each other about the same booking.
//
// Part 1 pins the disagreement as it behaves TODAY, so the migration cannot be
// declared done while the two answers still differ.
// Part 2 is the adoption gate. It FAILS until every listed file stops deciding
// paid-ness or summing revenue through the legacy classifiers.
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

describe("1. the two live classifiers disagree about the same booking", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // THIS ASSERTION ENCODES THE DEFECT. It is deliberately written to pass while
  // the product is wrong, so that it starts FAILING the moment the disagreement
  // is fixed.
  //
  // MUST BE INVERTED once the migration lands: replace `not.toBe` with `toBe`,
  // so this suite then asserts the two agree — or delete this test outright if
  // classifySourceType/rowSourceType are removed with the migration, which is
  // what lib/metrics/canonical.ts's docblock intends.
  // ───────────────────────────────────────────────────────────────────────────
  test("classifySourceType says meta_ads, rowSourceType says influencer", () => {
    expect(classifySourceType(AMBIGUOUS)).toBe("meta_ads");
    expect(rowSourceType(AMBIGUOUS)).toBe("influencer");
    expect(classifySourceType(AMBIGUOUS)).not.toBe(rowSourceType(AMBIGUOUS));
  });

  // The disagreement is not cosmetic — it decides whether this booking's ₹42,000
  // lands in the ROAS numerator. Today the agency dashboard (which uses
  // classifySourceType) and the overview API (which uses rowSourceType) report
  // different paid revenue for the identical row.
  test("and therefore disagree about whether the revenue is paid", () => {
    expect(isPaidSourceType(classifySourceType(AMBIGUOUS))).toBe(true);
    expect(isPaidSourceType(rowSourceType(AMBIGUOUS))).toBe(false);
  });

  // The target behaviour, already implemented and already tested in
  // tests/canonical-metrics.test.ts — recorded here so "inverted" has one
  // unambiguous meaning: a coupon must not erase a paid click.
  test("canonicalSourceType already resolves it — paid wins over the coupon", () => {
    expect(canonicalSourceType(AMBIGUOUS)).toBe("meta_ads");
    expect(isPaidRow(AMBIGUOUS)).toBe(true);
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
