import { describe, expect, test } from "vitest";

import {
  LANDING_DIMENSION,
  bucketsFor,
  filterForBucket,
  landingPrefixFilter,
  sharedPagesFilter,
} from "@/lib/ga4-property-sync";
import { UNASSIGNED_SEGMENT } from "@/lib/segments";
import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// GA4, SPLIT BY PROPERTY.
//
// Aster runs two properties on one website, so a site total answers a question
// nobody asked once a property is selected. GA4 arrives pre-aggregated, so the
// totals cannot be cut afterwards — the split has to be made at sync time, by
// asking GA4 again with a filter on the session's landing page.
//
// THE RULE BEING PINNED: a session belongs to the property it LANDED on. Every
// session has exactly one landing page, so the buckets partition the traffic —
// never double-counted, and summing to the site total. The alternative, "any
// session that touched a property's pages", counts a session that saw both in
// both, and then no honest total exists.
// ─────────────────────────────────────────────────────────────────────────────

const CBH = { id: "seg_cbh", name: "Coffeeberry Hills", pathPrefixes: ["/coffeeberry-hills"] };
const TH = { id: "seg_th", name: "Three Hills", pathPrefixes: ["/three-hills", "/3hills"] };

describe("1. the filter is built on the landing page, not the pages viewed", () => {
  test("it filters the landing-page dimension", () => {
    expect(LANDING_DIMENSION).toBe("landingPagePlusQueryString");
    expect(JSON.stringify(landingPrefixFilter(CBH.pathPrefixes))).toContain(LANDING_DIMENSION);
  });

  test("one prefix is a bare filter; several become an orGroup", () => {
    const one = landingPrefixFilter(["/coffeeberry-hills"]) as Record<string, unknown>;
    expect(one).toHaveProperty("filter");
    expect(one).not.toHaveProperty("orGroup");

    const many = landingPrefixFilter(TH.pathPrefixes) as { orGroup: { expressions: unknown[] } };
    expect(many.orGroup.expressions).toHaveLength(2);
  });

  test("matching is BEGINS_WITH and case-insensitive", () => {
    // A prefix rule has to survive /Coffeeberry-Hills/rooms?utm_source=… — both
    // the casing and the query string the dimension carries.
    const f = JSON.stringify(landingPrefixFilter(["/coffeeberry-hills"]));
    expect(f).toContain('"matchType":"BEGINS_WITH"');
    expect(f).toContain('"caseSensitive":false');
  });
});

describe("2. shared pages are the complement, so nothing falls out of the total", () => {
  test("the shared filter is NOT(any property prefix)", () => {
    const shared = sharedPagesFilter([...CBH.pathPrefixes, ...TH.pathPrefixes]) as {
      notExpression: { orGroup: { expressions: unknown[] } };
    };
    expect(shared).toHaveProperty("notExpression");
    expect(shared.notExpression.orGroup.expressions).toHaveLength(3);
  });

  test("defining it as a complement means an UNCLASSIFIED page still counts", () => {
    // A new landing page nobody has written a rule for lands in Shared rather
    // than vanishing. That is what keeps the buckets summing to the site total.
    // A hand-listed set of shared paths would silently drop it instead.
    const shared = JSON.stringify(sharedPagesFilter(["/coffeeberry-hills"]));
    expect(shared).toContain("notExpression");
    expect(shared).not.toContain("/blog");
  });

  test("with nothing claimed there is no complement to take", () => {
    expect(sharedPagesFilter([])).toBeNull();
  });
});

describe("3. the buckets", () => {
  test("one per property, plus shared", () => {
    const buckets = bucketsFor([CBH, TH]);
    expect(buckets.map((b) => b.key)).toEqual(["seg_cbh", "seg_th", UNASSIGNED_SEGMENT]);
  });

  test("a property with NO prefixes is skipped, not synced as zeros", () => {
    // Zero is a measurement. "No rule identifies this property's pages" is not,
    // and storing the first to mean the second reports an outage as a quiet
    // month.
    const buckets = bucketsFor([CBH, { id: "seg_x", name: "Unruled", pathPrefixes: [] }]);
    expect(buckets.map((b) => b.key)).toEqual(["seg_cbh", UNASSIGNED_SEGMENT]);
  });

  test("no properties with prefixes means no buckets at all", () => {
    expect(bucketsFor([])).toEqual([]);
    expect(bucketsFor([{ id: "x", name: "X", pathPrefixes: [] }])).toEqual([]);
  });

  test("the shared bucket's filter excludes EVERY property, not just its own", () => {
    const buckets = bucketsFor([CBH, TH]);
    const shared = buckets.find((b) => b.key === UNASSIGNED_SEGMENT)!;
    const f = JSON.stringify(filterForBucket(shared, buckets));
    for (const prefix of [...CBH.pathPrefixes, ...TH.pathPrefixes]) {
      expect(f, prefix).toContain(prefix);
    }
    expect(f).toContain("notExpression");
  });

  test("a property's filter names only its own prefixes", () => {
    const buckets = bucketsFor([CBH, TH]);
    const f = JSON.stringify(filterForBucket(buckets[0]!, buckets));
    expect(f).toContain("/coffeeberry-hills");
    expect(f).not.toContain("/three-hills");
    expect(f).not.toContain("notExpression");
  });
});

describe("4. the read path and what it does NOT claim", () => {
  const DASH = readCode("lib/ga4-dashboard.ts");
  const UI = readCode("components/dashboard/Ga4WebsiteTraffic.tsx");

  test("a scoped load reads the per-property table, never filters the site one", () => {
    // Filtering the site table is impossible — it holds pre-aggregated daily
    // totals — and code that appeared to do it would be summing top-N leftovers.
    expect(DASH).toContain("prisma.ga4PropertySnapshot");
    expect(DASH).toMatch(/segmentKey/);
  });

  test("the dashboard marks itself scoped so absent sections can say why", () => {
    expect(DASH).toContain("propertyScoped");
  });

  test("sections with no per-property data say so instead of rendering empty", () => {
    // An empty table under a lit property chip reads as "this property had
    // none" — a claim, and a false one.
    expect(UI).toContain("function NotPerProperty");
    const uses = (UI.match(/<NotPerProperty/g) ?? []).length;
    expect(uses, "expected landing×source, new-vs-returning and events").toBeGreaterThanOrEqual(3);
    for (const guard of ["data.propertyScoped ? ("]) {
      expect(UI).toContain(guard);
    }
  });
});

describe("5. no rows is not no traffic", () => {
  const DASH = readCode("lib/ga4-dashboard.ts");
  const UI = readCode("components/dashboard/Ga4WebsiteTraffic.tsx");

  test("an empty scoped window is reported as unmeasured, not as zero", () => {
    expect(DASH).toContain("propertyDataMissing");
    expect(DASH).toMatch(/snaps\.length === 0[\s\S]{0,80}propertyDataMissing: true/);
  });

  test("the card refuses to render tiles it would have to fill with zeros", () => {
    expect(UI).toMatch(/data\.propertyScoped && data\.propertyDataMissing/);
    expect(UI).toContain("This is not a reading of zero");
  });

  test("the scoped read tolerates the table not existing yet", () => {
    // Migrations here are applied BY HAND, separately from the deploy, and the
    // last table added this way took every dashboard page down with a P2021 in
    // the window between the two. lib/missing-table.ts exists for exactly that.
    expect(DASH).toContain("whenMigrated");
    const at = DASH.indexOf("prisma.ga4PropertySnapshot");
    expect(at).toBeGreaterThan(-1);
    expect(DASH.slice(Math.max(0, at - 500), at)).toContain("whenMigrated");
  });
});

describe("6. a backfill can actually finish", () => {
  const SYNC = readCode("lib/ga4-sync.ts");
  const ROUTE = readCode("app/api/ga4/sync/route.ts");

  test("the sync accepts an explicit window, not just a day count", () => {
    // `days` alone always restarts at "N days ago", so a long run that times out
    // re-fetches the same early days forever and never reaches the end.
    expect(SYNC).toMatch(/window\?: \{ startDate: string; endDate: string \}/);
    expect(SYNC).toContain("window?.startDate ?? `${days}daysAgo`");
  });

  test("the route takes from/to and validates them together", () => {
    expect(ROUTE).toContain('url.searchParams.get("from")');
    expect(ROUTE).toContain("from and to must be given together.");
  });

  test("the per-property pass cannot cost the site figures", () => {
    // It runs LAST and best-effort: the site totals are already written, and an
    // enrichment failing must not take the day's traffic with it.
    const at = SYNC.indexOf("syncPropertyBuckets({");
    expect(at).toBeGreaterThan(-1);
    const before = SYNC.slice(Math.max(0, at - 600), at);
    expect(before).toContain("try {");
  });
});

// ── 7 · The other half of the Website view ─────────────────────────────────

describe("7. visitor counts are scoped by the SAME rule as GA4", () => {
  const SUMMARY = readCode("lib/metrics/summary-dashboard.ts");
  const DASH = readCode("components/dashboard/FullHotelDashboard.tsx");
  const UI = readCode("components/dashboard/Ga4WebsiteTraffic.tsx");

  // Reported from production: with the GA4 half split, Customer intent and
  // Customer journey still showed the same ~6,078 visitors for BOTH properties,
  // because loadSummaryDashboard took no property at all.

  test("sessions are filtered by the page they landed on", () => {
    // Session.landingPath is the first pagePath of the session — the same rule
    // the GA4 split uses, on purpose. Matching "any page the session touched"
    // would count a visitor who saw both properties in both.
    expect(SUMMARY).toContain("landingPath");
    expect(SUMMARY).toMatch(/startsWith: p/);
    expect(SUMMARY).toMatch(/loadVisitors\(hotelClientId, range, landingPrefixes\)/);
  });

  test("the comparison period is scoped too, or the change % is nonsense", () => {
    // Scoping the current period but not the previous one would compare one
    // property against the whole group and call the difference growth.
    expect(SUMMARY).toMatch(/loadVisitors\(hotelClientId, previous, landingPrefixes\)/);
  });

  test("the website view passes the selected property's prefixes", () => {
    expect(DASH).toMatch(/loadSummaryDashboard\(hotelId, range, selectedPrefixes\)/);
    expect(DASH).toContain("const selectedPrefixes");
  });

  test("what is still group-level is disclosed, not left to be assumed scoped", () => {
    // Intent hangs off click and stage events, keyed to a session rather than a
    // path. Saying so beats a number that silently means something else.
    expect(DASH).toContain("still counted for the whole group");
  });

  test("a property with no rows outranks the generic never-synced message", () => {
    // "run a sync on the Integrations page" is wrong for a property: the site
    // HAS synced. The order of these two early returns is the whole difference.
    const missing = UI.indexOf("data.propertyScoped && data.propertyDataMissing");
    const neverSynced = UI.indexOf("data.days === 0");
    expect(missing).toBeGreaterThan(-1);
    expect(neverSynced).toBeGreaterThan(-1);
    expect(missing, "the property check must come first").toBeLessThan(neverSynced);
  });
});
