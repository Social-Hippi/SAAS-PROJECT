import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// META ADS BY PROPERTY — the report built on the campaign metrics.
//
// Verified against production before it was written: six campaigns, all six
// attributed by the {CBH} / {THC} tokens, Coffeeberry ₹9,847 / 204 messages and
// Three Hills ₹7,533 / 204 messages, nothing unassigned.
//
// What these pin is the part that cannot be checked by looking at it once: that
// an absent figure stays absent instead of becoming a zero, and that spend is
// gated at the SOURCE rather than hidden in the markup.
// ─────────────────────────────────────────────────────────────────────────────

const LOADER = readCode("lib/metrics/meta-property-breakdown.ts");
const UI = readCode("components/dashboard/MetaPropertyBreakdown.tsx");
const DASH = readCode("components/dashboard/FullHotelDashboard.tsx");

describe("1. spend is withheld at the source, not in the markup", () => {
  test("hidden spend leaves the payload without any money figure", () => {
    // Rendering a spend the payload never carried is impossible; a component
    // that forgot the gate can only show a dash.
    expect(LOADER).toMatch(/spend: showAdSpend \? a\.spend : null/);
    expect(LOADER).toMatch(/costPerContact: showAdSpend && contacts > 0/);
  });

  test("the loader takes showAdSpend as a required argument", () => {
    expect(LOADER).toMatch(/showAdSpend: boolean,/);
    expect(LOADER).not.toMatch(/showAdSpend\?: boolean/);
    expect(LOADER).not.toMatch(/showAdSpend = true/);
  });

  test("the money columns disappear entirely when it is hidden", () => {
    // Not rendered blank — removed, so the table has no empty column where a
    // reader would wonder what belongs there.
    expect(UI).toMatch(/\{spendVisible && <Head right>Cost \/ contact<\/Head>\}/);
    expect(UI).toMatch(/\{spendVisible && <Head right>Spent<\/Head>\}/);
  });

  test("the dashboard passes the hotel's real flag, not a literal", () => {
    expect(DASH).toContain("loadMetaPropertyBreakdown(hotelId, range, showAdSpend, selectedSegmentId)");
  });
});

describe("2. absent is not zero", () => {
  test("null renders as a dash through every formatter", () => {
    // reach is null for days synced before it was captured; rankings are null
    // while Meta withholds them. Either shown as 0 would be a claim.
    expect(UI).toContain('const dash = "\u2014"');
    for (const fn of ["num", "money", "pct"]) {
      expect(UI, fn).toContain(`const ${fn} = (v: number | null | undefined): string =>`);
    }
    const routes = UI.match(/v == null \? dash/g) ?? [];
    expect(routes.length, "each formatter must send null to the dash").toBeGreaterThanOrEqual(3);
  });

  test("a withheld ranking is explained, so a dash is not read as a bad grade", () => {
    expect(UI).toContain("Meta withholds delivery rankings");
    expect(UI).toContain("not a bad one");
    expect(LOADER).toContain("rankingsUnavailable");
  });

  test("a property with no campaigns says so rather than rendering an empty box", () => {
    expect(UI).toContain("No campaigns ran for this property in this period.");
    // And the loader seeds a group per segment, so there IS a box to say it in.
    expect(LOADER).toContain("for (const s of segments) {");
    expect(LOADER).toContain("groups.set(s.id, {");
  });
});

describe("3. messages and leads stay separate", () => {
  test("they are distinct columns, and 'contacts' is disclosed as an upper bound", () => {
    // Adding them into one "results" number would double-count anyone who both
    // messaged and submitted a form, and cost-per-result would be understated.
    expect(UI).toMatch(/<Head right>Messages<\/Head>/);
    expect(UI).toMatch(/<Head right>Leads<\/Head>/);
    expect(UI).toContain("upper bound, not a headcount");
  });

  test("contacts is the sum, used only for the cost figure", () => {
    expect(LOADER).toMatch(/const contacts = a\.messages \+ a\.leads/);
  });
});

describe("4. the chart compares like with like", () => {
  test("both properties share one vertical scale", () => {
    // Separate scales would make a property with a tenth of the volume look
    // level with the one carrying it. Asserted on the CODE, not on the comment
    // saying so — readCode strips comments.
    expect(UI).toContain("const max = Math.max(");
    expect(UI).toContain("daily.flatMap((d) => plotted.map(");
    const scales = UI.match(/const y = \(v: number\)/g) ?? [];
    expect(scales.length, "one shared y scale, not one per property").toBe(1);
  });

  test("a property with no messages is left off rather than drawn flat", () => {
    expect(UI).toMatch(/groups\.filter\(\(g\) => g\.totals\.messages > 0\)/);
  });
});

describe("5. it only claims a split where one exists", () => {
  test("the group-level spend caveat is dropped on the Meta view specifically", () => {
    // That note says spend cannot be attributed to a property. On this view it
    // now is, so leaving the note would contradict the boxes above it.
    expect(DASH).toMatch(/selectedSegmentId && source !== "meta_ads"/);
  });

  test("unassigned campaigns get a visible box, and only when there are some", () => {
    expect(LOADER).toMatch(/g\.segmentKey !== UNASSIGNED_SEGMENT \|\| g\.campaigns\.length > 0/);
  });
});

// ── 6 · The property chip actually filters this view ───────────────────────

describe("6. selecting a property filters the whole view", () => {
  // Reported from production: All properties, Three Hills and Coffeeberry Hills
  // all showed the same thing. The breakdown rendered every property's box
  // regardless of the selection, so the chip appeared to do nothing here while
  // filtering everywhere else on the dashboard.

  test("the loader filters groups by the selection", () => {
    expect(LOADER).toContain("selectedSegmentKey: string | null = null");
    expect(LOADER).toMatch(/groupsFinal\.filter\(\(g\) => g\.segmentKey === selectedSegmentKey\)/);
  });

  test("the chart drops series for properties that are no longer on screen", () => {
    // A line for a property whose box is not rendered is a line nothing explains.
    expect(LOADER).toContain("shownKeys");
    expect(LOADER).toMatch(/filter\(\(\[key\]\) => shownKeys\.has\(key\)\)/);
  });

  test("the rankings note describes what is on screen, not what was loaded", () => {
    // Otherwise selecting a property whose campaigns ARE ranked would still show
    // "Meta withholds rankings", because some other property's were not.
    expect(LOADER).toContain("shownCampaignRankings");
  });

  test("the campaign table shows the same campaigns as the boxes", () => {
    // A filtered box above an unfiltered table is the chip telling the reader
    // two different things.
    expect(DASH).toContain("metaCampaignFilter");
    expect(DASH).toContain("loadMetaPaidPerformance(hotelId, range, showAdSpend, metaCampaignFilter)");
  });

  test("that table filters at the source, so its Total line stays right", () => {
    const PAID = readCode("lib/metrics/paid-performance.ts");
    expect(PAID).toContain("onlyCampaignIds?: ReadonlySet<string>");
    expect(PAID).toMatch(/const kept = onlyCampaignIds/);
    // The aggregation must consume the filtered set, not the raw one.
    expect(PAID).toContain("for (const s of kept) {");
  });
});
