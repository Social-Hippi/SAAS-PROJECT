import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  classifySourceType,
  isPaidSourceType,
  NO_CLICK_IDS,
  type ClassifiableUtm,
} from "@/lib/source-classifier";

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFIER INPUT INTEGRITY.
//
// classifySourceType() decides which marketing channel a booking belongs to, and
// it checks the Google Ads click identifiers BEFORE any UTM heuristic — because
// Google Ads auto-tagging (the DEFAULT account setting) sends a `gclid` and NO
// utm parameters at all. Every auto-tagged Google booking therefore depends
// entirely on those four columns being present on the row handed to it.
//
// They used to be OPTIONAL on the input type, so a call site that forgot to
// SELECT them still compiled — `isGoogleAdsClick` then read `undefined`,
// returned false, and the booking silently classified as `direct`.
//
// That produced surfaces that contradicted THEMSELVES:
//
//   • /api/agency/hotels/[id]/owner-metrics — calculateROAS selected the click
//     ids and counted a booking as google_ads, while calculateBookingsBySource
//     (same Promise.all, same JSON response, rendered by the same
//     <PerformanceOverview>) omitted them and counted it as direct.
//
//   • lib/report-pdf.ts — the KPI block (via loadHotelReport, which selects
//     them) counted a booking as paid Google revenue, while the channel table
//     on the next page of the SAME client-facing PDF bucketed it as Direct.
//
//   • lib/owner-summary.ts — the query selected them, but channelRev() hand-
//     picked three fields and dropped them, so the per-channel bullets
//     disagreed with the paidRevenue figure computed from the same rows.
//
//   • lib/channel-view.ts + lib/owner-metrics.ts — Session rows carry the click
//     id columns but the SELECTs omitted them, so an auto-tagged Google SESSION
//     was counted as direct traffic and never as an ad session.
//
// The fix is structural: ClassifiableUtm and EventInput now require the four
// keys, so an omitted SELECT is a compile error rather than a wrong number.
//
// These tests pin BOTH halves of that:
//   • BEHAVIOURAL — the classification contract that makes the columns matter.
//   • SOURCE ASSERTIONS — that the previously-defective queries still select
//     them. The type system catches an omitted field on a typed row, but a
//     Prisma `select` is data, not a type, so the projection needs its own
//     guard. Mirrors tests/spend-display-integrity.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const OWNER_METRICS = read("lib/owner-metrics.ts");
const REPORT_PDF = read("lib/report-pdf.ts");
const OWNER_SUMMARY = read("lib/owner-summary.ts");
const CHANNEL_VIEW = read("lib/channel-view.ts");
const RBS_LOADER = read("lib/revenue-by-source-loader.ts");

/** The four columns every classifier input must carry. */
const CLICK_ID_COLUMNS = ["gclid", "gbraid", "wbraid", "fbclid"] as const;

/** Does this `select: { … }` block request all four click id columns? */
function selectsClickIds(block: string): boolean {
  return CLICK_ID_COLUMNS.every((k) => new RegExp(`\\b${k}\\s*:\\s*true`).test(block));
}

/**
 * Extract the `select: { … }` object that follows `anchor` in `source`.
 * Brace-matched so nested objects don't truncate it.
 */
function selectBlockAfter(source: string, anchor: string): string {
  const at = source.indexOf(anchor);
  expect(at, `anchor not found in source: ${anchor}`).toBeGreaterThan(-1);
  const selAt = source.indexOf("select:", at);
  expect(selAt, `no select: after anchor ${anchor}`).toBeGreaterThan(-1);
  const open = source.indexOf("{", selAt);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced select block after ${anchor}`);
}

// ── 1. The contract that makes the columns matter ───────────────────────────

describe("1. auto-tagged Google traffic depends entirely on the click ids", () => {
  const autoTagged: ClassifiableUtm = {
    ...NO_CLICK_IDS,
    gclid: "Cj0KCQjw_auto_tagged_example",
    utmSource: null,
    utmMedium: null,
  };

  test("a gclid with NO utm parameters classifies as google_ads", () => {
    expect(classifySourceType(autoTagged)).toBe("google_ads");
    expect(isPaidSourceType(classifySourceType(autoTagged))).toBe(true);
  });

  test("the SAME booking without its click ids collapses to `direct`", () => {
    // This is precisely what an omitted SELECT produced. Asserting it here
    // documents WHY the fields are Required rather than optional.
    const withoutClickIds: ClassifiableUtm = { ...autoTagged, ...NO_CLICK_IDS };
    expect(classifySourceType(withoutClickIds)).toBe("direct");
    expect(isPaidSourceType(classifySourceType(withoutClickIds))).toBe(false);
  });

  test("gbraid and wbraid (the iOS variants) classify the same way", () => {
    for (const key of ["gbraid", "wbraid"] as const) {
      const row: ClassifiableUtm = { ...NO_CLICK_IDS, [key]: "abc123", utmSource: null, utmMedium: null };
      expect(classifySourceType(row), key).toBe("google_ads");
    }
  });

  test("fbclid alone does NOT make a booking paid — Meta adds it to organic links too", () => {
    const row: ClassifiableUtm = { ...NO_CLICK_IDS, fbclid: "IwAR_example", utmSource: null, utmMedium: null };
    expect(classifySourceType(row)).toBe("direct");
    expect(isPaidSourceType(classifySourceType(row))).toBe(false);
  });

  test("a click id outranks a conflicting UTM, deterministically", () => {
    // A gclid on a link someone re-tagged as organic is still a Google Ads click.
    const row: ClassifiableUtm = {
      ...NO_CLICK_IDS,
      gclid: "Cj0KCQ_example",
      utmSource: "instagram",
      utmMedium: "reel",
    };
    expect(classifySourceType(row)).toBe("google_ads");
    // …and repeated calls agree (no hidden state).
    expect(classifySourceType(row)).toBe(classifySourceType(row));
  });
});

// ── 2. NO_CLICK_IDS means "this record genuinely has none" ──────────────────

describe("2. NO_CLICK_IDS is a complete, explicit absence", () => {
  test("it sets every click id column to null", () => {
    expect(Object.keys(NO_CLICK_IDS).sort()).toEqual([...CLICK_ID_COLUMNS].sort());
    for (const k of CLICK_ID_COLUMNS) expect(NO_CLICK_IDS[k]).toBeNull();
  });

  test("a manual (off-snippet) redemption classifies from its UTMs alone", () => {
    // Manual redemptions have no TrackingEvent, so no click id can exist. That
    // is a real absence, not a forgotten SELECT — which is the whole point of
    // spelling it with NO_CLICK_IDS.
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: null, utmMedium: null })).toBe("direct");
  });
});

// ── 3. The previously-defective queries still project the columns ───────────

describe("3. every classifier query selects the click id columns", () => {
  test("owner-metrics: calculateBookingsBySource (the /owner-metrics self-contradiction)", () => {
    const block = selectBlockAfter(OWNER_METRICS, "export async function calculateBookingsBySource");
    expect(selectsClickIds(block)).toBe(true);
  });

  test("owner-metrics: calculateROAS still selects them (the other half of that payload)", () => {
    const block = selectBlockAfter(OWNER_METRICS, "export async function calculateROAS");
    expect(selectsClickIds(block)).toBe(true);
  });

  test("owner-metrics: calculateCostPerBooking and calculateTopCampaigns agree", () => {
    for (const fn of [
      "export async function calculateCostPerBooking",
      "export async function calculateTopCampaigns",
    ]) {
      expect(selectsClickIds(selectBlockAfter(OWNER_METRICS, fn)), fn).toBe(true);
    }
  });

  test("owner-metrics: ad SESSIONS are classified with their click ids", () => {
    const block = selectBlockAfter(OWNER_METRICS, "export async function calculateNewVsReturningFromAds");
    expect(selectsClickIds(block)).toBe(true);
  });

  test("report-pdf: the client-facing channel table (the PDF self-contradiction)", () => {
    const block = selectBlockAfter(REPORT_PDF, 'eventType: "conversion"');
    expect(selectsClickIds(block)).toBe(true);
  });

  test("report-pdf: the ConversionRow map carries them through to the aggregation", () => {
    // Selecting the columns is useless if the row mapped into ConversionRow drops
    // them again — which is exactly how the PDF regressed.
    for (const k of CLICK_ID_COLUMNS) {
      expect(REPORT_PDF, k).toMatch(new RegExp(`${k}:\\s*e\\.${k}`));
    }
  });

  test("channel-view: conversions AND sessions both select them", () => {
    for (const fn of ["function conversionsInRange", "function sessionsInRange"]) {
      expect(selectsClickIds(selectBlockAfter(CHANNEL_VIEW, fn)), fn).toBe(true);
    }
  });

  test("revenue-by-source-loader: tracked conversions select them", () => {
    const block = selectBlockAfter(RBS_LOADER, 'eventType: "conversion"');
    expect(selectsClickIds(block)).toBe(true);
  });
});

// ── 4. No call site may hand-pick a subset of the classifier's inputs ───────

describe("4. classifier callers pass whole rows, never a hand-picked subset", () => {
  test("owner-summary channelRev passes the row (it used to drop the click ids)", () => {
    // The regression was `classifySourceType({ utmSource: r.utmSource, ... })` —
    // a literal that satisfied the old optional type while discarding columns
    // the query had already fetched.
    expect(OWNER_SUMMARY).toContain("classifySourceType(r) === channel");
  });

  test("no production classifier call rebuilds a partial literal from a row", () => {
    // Matches `classifySourceType({ utmSource: <expr>.utmSource` — i.e. an
    // object literal assembled FROM a row rather than the row itself. A literal
    // built from scratch (tests, snippet fixtures) is fine; this pattern is not.
    const sources: [string, string][] = [
      ["lib/owner-metrics.ts", OWNER_METRICS],
      ["lib/owner-summary.ts", OWNER_SUMMARY],
      ["lib/channel-view.ts", CHANNEL_VIEW],
      ["lib/report-pdf.ts", REPORT_PDF],
    ];
    for (const [name, src] of sources) {
      expect(src, name).not.toMatch(/classifySourceType\(\{\s*utmSource:\s*\w+\./);
    }
  });
});
