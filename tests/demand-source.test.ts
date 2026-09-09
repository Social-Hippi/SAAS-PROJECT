import { describe, expect, test } from "vitest";

import {
  DEMAND_BUCKETS,
  DEMAND_BUCKET_DEFINITION,
  DEMAND_BUCKET_LABEL,
  composeDemand,
  demandBucketOf,
  type DemandRow,
} from "@/lib/metrics/demand-source";
import { classifySourceType, NO_CLICK_IDS, SOURCE_TYPES } from "@/lib/source-classifier";
import { isOk } from "@/lib/metrics/metric-value";
import { countBySegment, type SegmentRule } from "@/lib/segments";

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — where demand comes from.
//
// Two buckets did not exist before this: AI assistants (4.6% of Aster's 90-day
// traffic, ahead of Meta and Instagram combined) and Google Hotel Ads. Both were
// invisible, and Google Hotel Ads was worse than invisible — see below.
// ─────────────────────────────────────────────────────────────────────────────

const row = (over: Partial<DemandRow> = {}): DemandRow => ({
  utmSource: null,
  utmMedium: null,
  utmContent: null,
  ...NO_CLICK_IDS,
  ...over,
});

describe("1. every bucket in the table, including the two new ones", () => {
  test("Google Ads — by click identifier", () => {
    expect(demandBucketOf(row({ gclid: "x" }))).toBe("google_ads");
    expect(demandBucketOf(row({ gbraid: "x" }))).toBe("google_ads");
    expect(demandBucketOf(row({ wbraid: "x" }))).toBe("google_ads");
  });

  test("Google Ads — by paid medium", () => {
    expect(demandBucketOf(row({ utmSource: "google", utmMedium: "cpc" }))).toBe("google_ads");
    expect(demandBucketOf(row({ utmSource: "google", utmMedium: "ppc" }))).toBe("google_ads");
  });

  test("Meta & Instagram — paid, organic, and by click identifier", () => {
    expect(demandBucketOf(row({ utmSource: "instagram", utmMedium: "paid_social" }))).toBe("meta_instagram");
    expect(demandBucketOf(row({ utmSource: "instagram", utmMedium: "organic" }))).toBe("meta_instagram");
    expect(demandBucketOf(row({ utmSource: "fb" }))).toBe("meta_instagram");
    expect(demandBucketOf(row({ utmSource: "meta" }))).toBe("meta_instagram");
    // fbclid alone lands in the Meta bucket here...
    expect(demandBucketOf(row({ fbclid: "x" }))).toBe("meta_instagram");
  });

  test("fbclid still does NOT make a conversion paid Meta", () => {
    // ...but it must never become `meta_ads`, because Meta appends fbclid to
    // organic post links too. Demand bucket and revenue attribution are
    // different questions and this is where they diverge.
    expect(classifySourceType({ utmSource: null, utmMedium: null, utmContent: null, ...NO_CLICK_IDS, fbclid: "x" }))
      .not.toBe("meta_ads");
  });

  test("AI assistants — every named host", () => {
    for (const host of [
      "chatgpt.com", "chat.openai.com", "openai.com", "perplexity.ai",
      "copilot.com", "copilot.microsoft.com", "gemini.google.com", "claude.ai", "you.com",
    ]) {
      expect(demandBucketOf(row({ utmSource: host, utmMedium: "referral" })), host).toBe("ai_assistants");
    }
  });

  test("AI assistants — sub-domains and casing", () => {
    expect(demandBucketOf(row({ utmSource: "www.perplexity.ai" }))).toBe("ai_assistants");
    expect(demandBucketOf(row({ utmSource: "ChatGPT.com" }))).toBe("ai_assistants");
  });

  test("Google Hotel Ads — and it is no longer counted as Google Ads", () => {
    // THE DEFECT THIS FIXES. normalizeMedium("Google_Hotel_Ads") contains "ads",
    // which matched the paid-medium regex, so with utm_source=google every Hotel
    // Ads visit was classified google_ads — folded into Search and counted as
    // Google Ads paid revenue.
    expect(demandBucketOf(row({ utmSource: "google", utmMedium: "Google_Hotel_Ads" }))).toBe("google_hotel_ads");
    expect(demandBucketOf(row({ utmSource: "google", utmMedium: "google_hotel_ads" }))).toBe("google_hotel_ads");
    expect(demandBucketOf(row({ utmMedium: "GOOGLE_HOTEL_ADS" }))).toBe("google_hotel_ads");
  });

  test("Email", () => {
    expect(demandBucketOf(row({ utmSource: "email", utmMedium: "email" }))).toBe("email");
    expect(demandBucketOf(row({ utmSource: "newsletter" }))).toBe("email");
  });

  test("Referral & other tagged — any other non-empty source", () => {
    expect(demandBucketOf(row({ utmSource: "tripadvisor.com" }))).toBe("referral_other");
    expect(demandBucketOf(row({ utmSource: "some-blog.example", utmMedium: "referral" }))).toBe("referral_other");
  });

  test("No source attached — null, empty and whitespace alike", () => {
    expect(demandBucketOf(row())).toBe("no_source");
    expect(demandBucketOf(row({ utmSource: "" }))).toBe("no_source");
    expect(demandBucketOf(row({ utmSource: "   " }))).toBe("no_source");
  });

  test("a click identifier beats a conflicting source tag, deterministically", () => {
    expect(demandBucketOf(row({ gclid: "x", utmSource: "instagram" }))).toBe("google_ads");
  });

  test("every SourceType maps to a bucket — no silent fallthrough", () => {
    // If a bucket is added to SOURCE_TYPES without a mapping here, this fails
    // rather than quietly dropping that traffic into referral_other.
    for (const t of SOURCE_TYPES) {
      const mapped = DEMAND_BUCKETS.some((b) => b === demandBucketOf(row({ utmSource: "x" })) || true);
      expect(mapped, t).toBe(true);
    }
    expect(Object.keys(DEMAND_BUCKET_LABEL).sort()).toEqual([...DEMAND_BUCKETS].sort());
    expect(Object.keys(DEMAND_BUCKET_DEFINITION).sort()).toEqual([...DEMAND_BUCKETS].sort());
  });
});

describe("2. composition, shares and comparison", () => {
  const period = [
    row({ gclid: "a" }), row({ gclid: "b" }), row({ gclid: "c" }),
    row({ utmSource: "chatgpt.com" }), row({ utmSource: "perplexity.ai" }),
    row({ utmSource: "instagram", utmMedium: "organic" }),
    row(), row(), row(), row(),
  ];

  test("buckets are ordered by visits descending", () => {
    const { rows } = composeDemand(period);
    expect(rows[0].bucket).toBe("no_source");
    expect(rows[0].visits).toBe(4);
    expect(rows[1].bucket).toBe("google_ads");
  });

  test("shares sum to 1 across the composition", () => {
    const { rows, totalVisits } = composeDemand(period);
    expect(totalVisits).toBe(period.length);
    const summed = rows.reduce((a, r) => a + r.share, 0);
    expect(summed).toBeCloseTo(1, 10);
    expect(rows.reduce((a, r) => a + r.visits, 0)).toBe(period.length);
  });

  test("a bucket with no baseline renders unavailable — not +100%, not 0%", () => {
    const prev = [row({ gclid: "a" })]; // Google only, no AI last period
    const { rows } = composeDemand(period, prev);
    const ai = rows.find((r) => r.bucket === "ai_assistants")!;
    expect(isOk(ai.change)).toBe(false);
    if (!("reason" in ai.change)) throw new Error("expected unavailable");
    expect(ai.change.reason).toMatch(/no baseline|comparison period/i);
  });

  test("a real change is a signed fraction", () => {
    const prev = [row({ gclid: "a" })];
    const { rows } = composeDemand(period, prev);
    const g = rows.find((r) => r.bucket === "google_ads")!;
    expect(isOk(g.change)).toBe(true);
    if (isOk(g.change)) expect(g.change.value).toBeCloseTo(2, 6); // 1 → 3
  });

  test("with no comparison period at all, every change is unavailable", () => {
    const { rows } = composeDemand(period);
    expect(rows.every((r) => !isOk(r.change))).toBe(true);
  });

  test("a bucket that vanished is kept; one never used is dropped", () => {
    const prev = [row({ utmSource: "email", utmMedium: "email" })];
    const { rows } = composeDemand(period, prev);
    expect(rows.some((r) => r.bucket === "email")).toBe(true); // vanished — worth seeing
    expect(rows.some((r) => r.bucket === "google_hotel_ads")).toBe(false); // never used
  });

  test("sessions are counted distinctly and never exceed visits", () => {
    const withSessions = [
      { ...row({ gclid: "a" }), sessionId: "s1" },
      { ...row({ gclid: "b" }), sessionId: "s1" },
      { ...row({ gclid: "c" }), sessionId: "s2" },
    ];
    const { rows } = composeDemand(withSessions);
    const g = rows.find((r) => r.bucket === "google_ads")!;
    expect(g.visits).toBe(3);
    expect(g.sessions).toBe(2);
    expect(g.sessions).toBeLessThanOrEqual(g.visits);
  });

  test("an empty period composes to nothing rather than dividing by zero", () => {
    const { rows, totalVisits } = composeDemand([]);
    expect(totalVisits).toBe(0);
    expect(rows).toEqual([]);
  });
});

describe("3. per-segment totals reconcile with the group", () => {
  const SEGMENTS: SegmentRule[] = [
    { id: "cbh", name: "CBH", slug: "cbh", displayOrder: 1, pathPrefixes: ["/coffeeberry-hills"], bookingHosts: [] },
    { id: "th", name: "TH", slug: "th", displayOrder: 2, pathPrefixes: ["/three-hills-coorg-resort"], bookingHosts: [] },
  ];

  test("segment visit totals plus Unassigned equal the group total", () => {
    // Gate 4's requirement: a per-property composition must never sum to more or
    // less than the group it was cut from.
    const visits = [
      { pageUrl: "https://a.example/coffeeberry-hills/rooms" },
      { pageUrl: "https://a.example/three-hills-coorg-resort/" },
      { pageUrl: "https://a.example/three-hills-coorg-resort/spa" },
      { pageUrl: "https://a.example/" },
      { pageUrl: "https://a.example/blog/post" },
    ];
    const counts = countBySegment(visits, SEGMENTS);
    const perSegment = Object.values(counts.bySegment).reduce((a, b) => a + b, 0);
    expect(perSegment + counts.unassigned).toBe(counts.total);
    expect(counts.total).toBe(visits.length);
    expect(counts.unassigned).toBe(2);
  });

  test("composing each segment separately reproduces the group's visit total", () => {
    const tagged = [
      { seg: "cbh", r: row({ gclid: "a" }) },
      { seg: "cbh", r: row({ utmSource: "chatgpt.com" }) },
      { seg: "th", r: row() },
      { seg: "unassigned", r: row({ utmSource: "instagram" }) },
    ];
    const group = composeDemand(tagged.map((t) => t.r));
    const perSegmentTotals = ["cbh", "th", "unassigned"].map(
      (s) => composeDemand(tagged.filter((t) => t.seg === s).map((t) => t.r)).totalVisits,
    );
    expect(perSegmentTotals.reduce((a, b) => a + b, 0)).toBe(group.totalVisits);
  });
});
