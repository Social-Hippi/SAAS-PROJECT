import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import {
  readSectionRange,
  resolveSectionRange,
  sectionRangeParams,
  type SectionRangeState,
} from "@/lib/section-range";

// ─────────────────────────────────────────────────────────────────────────────
// Date ranges for the Integrations page sections (Kraya leads by property,
// WhatsApp booking values): presets, "Last year", and a custom range.
// ─────────────────────────────────────────────────────────────────────────────

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-09-18T10:00:00Z"); // 18 Sep 2026, 15:30 IST

/** Whole property days covered, inclusive. */
const days = (s: SectionRangeState) => {
  const r = resolveSectionRange(s, TZ, NOW);
  return Math.round((r.until.getTime() - r.since.getTime()) / 86_400_000);
};

describe("1. every preset covers the days its label says", () => {
  test("7, 30 and 90 days", () => {
    expect(days({ key: "7" })).toBe(7);
    expect(days({ key: "30" })).toBe(30);
    expect(days({ key: "90" })).toBe(90);
  });

  test("REGRESSION: Last year is 365 days, not 30", () => {
    // resolveRange treats any number but 7 and 90 as 30. "365" was passed
    // straight through, so "Last year" showed thirty days under a description
    // saying "the last year".
    expect(days({ key: "365" })).toBe(365);
    const r = resolveSectionRange({ key: "365" }, TZ, NOW);
    expect(r.fromInput).toBe("2025-09-19");
    expect(r.toInput).toBe("2026-09-18");
  });
});

describe("2. a custom range goes through the same validation as every report", () => {
  test("the dates asked for are the dates used", () => {
    const r = resolveSectionRange({ key: "custom", from: "2026-09-11", to: "2026-09-15" }, TZ, NOW);
    expect(r.fromInput).toBe("2026-09-11");
    expect(r.toInput).toBe("2026-09-15");
    expect(r.adjustments).toEqual([]);
    // Same-month windows are written compactly: "11–15 Sep 2026".
    expect(r.dateLabel).toBe("11–15 Sep 2026");
  });

  test("dates the wrong way round are swapped, and the page is told", () => {
    const r = resolveSectionRange({ key: "custom", from: "2026-09-15", to: "2026-09-11" }, TZ, NOW);
    expect(r.fromInput).toBe("2026-09-11");
    expect(r.toInput).toBe("2026-09-15");
    expect(r.adjustments.join(" ")).toMatch(/wrong way round/);
  });

  test("an end date in the future is pulled back to today, and the page is told", () => {
    const r = resolveSectionRange({ key: "custom", from: "2026-09-10", to: "2026-12-31" }, TZ, NOW);
    expect(r.toInput).toBe("2026-09-18");
    expect(r.adjustments.join(" ")).toMatch(/future/);
  });
});

describe("3. reading and carrying a section's state", () => {
  test("anything unreadable falls back to the last 30 days", () => {
    expect(readSectionRange({}, "lbp")).toEqual({ key: "30" });
    expect(readSectionRange({ lbp: "999" }, "lbp")).toEqual({ key: "30" });
    // custom without both dates, or with a malformed one
    expect(readSectionRange({ lbp: "custom", lbpFrom: "2026-09-01" }, "lbp")).toEqual({ key: "30" });
    expect(
      readSectionRange({ lbp: "custom", lbpFrom: "yesterday", lbpTo: "2026-09-10" }, "lbp"),
    ).toEqual({ key: "30" });
  });

  test("each section reads only its own prefix", () => {
    const sp = { lbp: "7", wab: "custom", wabFrom: "2026-09-01", wabTo: "2026-09-10" };
    expect(readSectionRange(sp, "lbp")).toEqual({ key: "7" });
    expect(readSectionRange(sp, "wab")).toEqual({ key: "custom", from: "2026-09-01", to: "2026-09-10" });
  });

  test("params round-trip, so carrying a custom range never loses it", () => {
    const states: SectionRangeState[] = [
      { key: "90" },
      { key: "365" },
      { key: "custom", from: "2026-08-01", to: "2026-08-31" },
    ];
    for (const s of states) {
      expect(readSectionRange(sectionRangeParams("wab", s), "wab")).toEqual(s);
    }
  });
});

describe("4. wired into both Integrations sections", () => {
  const PAGE = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/page.tsx");
  const PICKER = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/SectionRangePicker.tsx");

  test("both sections resolve through section-range, never a bare preset", () => {
    expect(PAGE).toMatch(/const lbpRange = krayaView != null \? resolveSectionRange\(lbpState/);
    expect(PAGE).toMatch(/const wabRange = canValueBookings \? resolveSectionRange\(wabState/);
    expect(PAGE).not.toMatch(/resolveRange\(\{ range: (lbpKey|wabRangeKey) \}/);
  });

  test("each section carries the other's full state, custom dates included", () => {
    expect(PAGE).toMatch(/prefix="lbp"[\s\S]{0,160}preserve=\{sectionRangeParams\("wab", wabState\)\}/);
    expect(PAGE).toMatch(/prefix="wab"[\s\S]{0,160}preserve=\{sectionRangeParams\("lbp", lbpState\)\}/);
  });

  test("the custom range is a plain GET form with from and to dates", () => {
    expect(PICKER).toMatch(/<form\s+method="get"/);
    expect(PICKER).toMatch(/type="date"\s+name=\{`\$\{prefix\}From`\}/);
    expect(PICKER).toMatch(/type="date"\s+name=\{`\$\{prefix\}To`\}/);
    expect(PICKER).toMatch(/name=\{prefix\} value="custom"/);
  });

  test("the literal dates and any adjustments are always shown", () => {
    expect(PICKER).toMatch(/\{resolved\.dateLabel\}/);
    expect(PICKER).toMatch(/resolved\.adjustments\.map/);
  });
});
