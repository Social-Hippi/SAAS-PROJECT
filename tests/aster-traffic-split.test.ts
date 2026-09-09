import { describe, expect, test } from "vitest";

import { classifyVisit, countBySegment, UNASSIGNED_SEGMENT, type SegmentRule } from "@/lib/segments";
import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// ASTER'S TRAFFIC SPLIT.
//
// The rules below are the ones resolved from the production path inventory over
// 90 days, and this suite pins the split they produce.
//
// WHAT THIS IS AND IS NOT. The corpus is a FIXTURE that reproduces the stated
// production distribution of 13,337 visits — it is not a live query, and this
// test cannot prove the production numbers. What it does prove is that these
// rules, applied to traffic of that shape, produce that split; so a change to
// the prefixes that would silently re-bucket thousands of visits fails here.
//
// ~37% stays Unassigned and that is the CORRECT answer. Shared pages belong to
// the group. Assigning the blog to a property by destination keyword would be
// tempting — Coffeeberry Hills is in Chikmagalur, Three Hills in Coorg — but
// Aster also sells travel services, so that would be an inference presented as a
// measurement.
// ─────────────────────────────────────────────────────────────────────────────

const SEGMENTS: SegmentRule[] = [
  {
    id: "cbh",
    name: "Coffeeberry Hills",
    slug: "coffeeberry-hills",
    displayOrder: 1,
    pathPrefixes: ["/coffeeberry-hills"],
    bookingHosts: ["bookings.coffeeberryhills.in"],
  },
  {
    id: "th",
    name: "Three Hills",
    slug: "three-hills",
    displayOrder: 2,
    pathPrefixes: ["/three-hills", "/3hills"],
    bookingHosts: [], // still unknown — stays empty on purpose
  },
];

/** The stated production inventory, as counts of representative real paths. */
const CORPUS: { path: string; count: number }[] = [
  // Coffeeberry Hills property pages — 6,132
  { path: "https://asterholidays.com/coffeeberry-hills/", count: 3200 },
  { path: "https://asterholidays.com/coffeeberry-hills/gallery", count: 1400 },
  { path: "https://asterholidays.com/coffeeberry-hills/ads-landing", count: 900 },
  { path: "https://asterholidays.com/coffeeberry-hills#rooms", count: 632 },
  // Three Hills property pages — 2,270, across both recorded spellings
  { path: "https://asterholidays.com/three-hills-coorg-resort/", count: 1500 },
  { path: "https://asterholidays.com/three-hills/gallery", count: 500 },
  { path: "https://asterholidays.com/3hills-offers", count: 270 },
  // Home — 1,497
  { path: "https://asterholidays.com/", count: 1497 },
  // Brand and utility — 721
  { path: "https://asterholidays.com/about", count: 300 },
  { path: "https://asterholidays.com/contact", count: 250 },
  { path: "https://asterholidays.com/privacy-policy", count: 171 },
  // Destination content — 2,717
  { path: "https://asterholidays.com/blog/best-time-to-visit-chikmagalur", count: 1200 },
  { path: "https://asterholidays.com/blog/coorg-monsoon-guide", count: 1000 },
  { path: "https://asterholidays.com/blog/coffee-estate-stays", count: 517 },
];

const VISITS = CORPUS.flatMap(({ path, count }) =>
  Array.from({ length: count }, () => ({ pageUrl: path })),
);

const TOTAL = 13_337;
const pctOf = (n: number) => (n / TOTAL) * 100;

describe("1. the split matches the production inventory", () => {
  const counts = countBySegment(VISITS, SEGMENTS);

  test("the corpus is the stated size", () => {
    expect(VISITS.length).toBe(TOTAL);
    expect(counts.total).toBe(TOTAL);
  });

  test("Coffeeberry Hills property pages — 6,132 (46%)", () => {
    expect(counts.bySegment.cbh).toBe(6132);
    expect(pctOf(counts.bySegment.cbh)).toBeCloseTo(46, 0);
  });

  test("Three Hills property pages — 2,270 (17%), across both spellings", () => {
    expect(counts.bySegment.th).toBe(2270);
    expect(pctOf(counts.bySegment.th)).toBeCloseTo(17, 0);
  });

  test("Unassigned — 4,935 (37%): home, brand and utility, and the blog", () => {
    // 1,497 home + 721 brand/utility + 2,717 destination content.
    expect(counts.unassigned).toBe(4935);
    expect(pctOf(counts.unassigned)).toBeCloseTo(37, 0);
  });

  test("the sum invariant still holds at production scale", () => {
    const summed = Object.values(counts.bySegment).reduce((a, b) => a + b, 0) + counts.unassigned;
    expect(summed).toBe(TOTAL);
  });
});

describe("2. prefix matching catches the real page shapes", () => {
  test("gallery pages, the ads landing page and #rooms anchors all match", () => {
    for (const p of [
      "https://asterholidays.com/coffeeberry-hills/gallery",
      "https://asterholidays.com/coffeeberry-hills/ads-landing",
      "https://asterholidays.com/coffeeberry-hills#rooms",
      "https://asterholidays.com/coffeeberry-hills?utm_source=google",
    ]) {
      expect(classifyVisit(p, SEGMENTS), p).toBe("cbh");
    }
  });

  test("both Three Hills spellings match", () => {
    expect(classifyVisit("https://asterholidays.com/three-hills-coorg-resort/", SEGMENTS)).toBe("th");
    expect(classifyVisit("https://asterholidays.com/3hills-offers", SEGMENTS)).toBe("th");
  });
});

describe("3. destination content is NEVER assigned by keyword", () => {
  test("a Chikmagalur post does not become Coffeeberry Hills", () => {
    // Coffeeberry Hills is in Chikmagalur, so the inference is tempting — and
    // wrong. Aster sells travel services too; that reader may be booking
    // nothing, or something else entirely.
    expect(classifyVisit("https://asterholidays.com/blog/best-time-to-visit-chikmagalur", SEGMENTS))
      .toBe(UNASSIGNED_SEGMENT);
  });

  test("a Coorg post does not become Three Hills", () => {
    expect(classifyVisit("https://asterholidays.com/blog/coorg-monsoon-guide", SEGMENTS))
      .toBe(UNASSIGNED_SEGMENT);
  });

  test("no destination keyword appears in the shipped rules", () => {
    const seed = readCode("scripts/seed-property-segments.ts");
    for (const keyword of ["chikmagalur", "coorg", "blog", "destination"]) {
      expect(seed.toLowerCase(), keyword).not.toContain(`"/${keyword}`);
    }
  });
});

describe("4. the shipped seed carries exactly these rules", () => {
  const seed = readCode("scripts/seed-property-segments.ts");

  test("Coffeeberry Hills", () => {
    expect(seed).toContain('pathPrefixes: ["/coffeeberry-hills"]');
    expect(seed).toContain('bookingHosts: ["bookings.coffeeberryhills.in"]');
  });

  test("Three Hills — both spellings, and no guessed booking host", () => {
    expect(seed).toContain('pathPrefixes: ["/three-hills", "/3hills"]');
    expect(seed).toMatch(/bookingHosts: \[\] as string\[\]/);
  });
});
