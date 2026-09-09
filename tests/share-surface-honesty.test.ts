import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// GATE 5 — what the public report must NOT say, and must NOT expose.
//
// /share/<uuid> is unauthenticated and forwardable. Two classes of defect are
// pinned here:
//
//   1. PERSON-LEVEL DATA. Visitor identifiers were rendered in a <code> element
//      with the UNTRUNCATED value in a title attribute, on the share surface,
//      ungated. Anyone the link reached could read them.
//
//   2. ASSERTED MEASUREMENTS THAT WERE NEVER TAKEN. Every booking table is
//      empty because confirmations are not linked back to sessions, so
//      "Meta Ads: drove 0 bookings (₹0)" and a −100% variance on every campaign
//      were not results — they were the absence of a result, rendered as one.
// ─────────────────────────────────────────────────────────────────────────────

const DASHBOARD = readCode("components/dashboard/FullHotelDashboard.tsx");
const SHARE_PAGE = readCode("app/share/[uuid]/page.tsx");
const JOURNEYS = readCode("components/dashboard/ConversionJourneys.tsx");
const GRID = readCode("components/dashboard/mission/CampaignGrid.tsx");
const OWNER_SUMMARY = readCode("lib/owner-summary.ts");

describe("1. no person-level data reaches the share surface", () => {
  test("the per-visitor list is gated behind a non-share viewer", () => {
    // The aggregate branch must come FIRST in the journeys section, so the
    // per-visitor list is unreachable for a share reader rather than merely
    // styled away. Anchored on the aggregate's own identifier, because
    // `viewer === "share"` appears elsewhere in this file too.
    const aggregateAt = DASHBOARD.indexOf("journeyShapes.map");
    const perVisitorAt = DASHBOARD.indexOf("{recentSessions.map((s) => (");
    expect(aggregateAt).toBeGreaterThan(-1);
    expect(perVisitorAt).toBeGreaterThan(aggregateAt);

    // And the branch guarding it is a share check, not a truthiness accident.
    const guard = DASHBOARD.slice(aggregateAt - 400, aggregateAt);
    expect(guard).toContain('viewer === "share"');
  });

  test("the aggregate carries no identifier of any kind", () => {
    const start = DASHBOARD.indexOf("journeyShapes.map");
    const end = DASHBOARD.indexOf("{recentSessions.map((s) => (");
    const block = DASHBOARD.slice(start, end);
    expect(block).not.toContain("visitorId");
    expect(block).not.toContain("sessionId");
    expect(block).not.toMatch(/\bs\.id\b/);
  });

  test("the aggregate query selects no identifier columns", () => {
    const at = DASHBOARD.indexOf("const journeyShapes");
    const block = DASHBOARD.slice(at, at + 600);
    expect(block).toContain('by: ["landingPath", "exitPath"]');
    expect(block).not.toContain("visitorId");
  });

  test("a title attribute never carries an untruncated visitor id on share", () => {
    // The original leak was title={s.visitorId} — the truncation in the visible
    // text was cosmetic; the full value sat in the attribute.
    const shareBranch = DASHBOARD.slice(
      DASHBOARD.indexOf('viewer === "share" ?'),
      DASHBOARD.indexOf("{recentSessions.map((s) => ("),
    );
    expect(shareBranch).not.toMatch(/title=\{[^}]*visitorId/);
  });

  test("the per-booking journey drill-down is withheld on share", () => {
    // A conversion journey is one identifiable person's path through the site.
    expect(JOURNEYS).toContain('const canDrillDown = viewer !== "share"');
    expect(JOURNEYS).toMatch(/canDrillDown\s*\?\s*\(journeys\.find/);
    expect(JOURNEYS).toMatch(/\{canDrillDown && \(/);
    expect(DASHBOARD).toContain("<ConversionJourneys journeys={journeys} viewer={viewer} />");
  });

  test("the booking itself still shows — only the journey is withheld", () => {
    // 5.2: a genuine measured booking must be visible with its attribution
    // state. Hiding the row would remove the most important fact on the page.
    expect(JOURNEYS).toContain("formatCurrency(j.conversionValue)");
    expect(JOURNEYS).toContain("{j.attributedTo}");
  });
});

describe("2. nothing asserts a measurement that was never taken", () => {
  test('no "drove N bookings" string survives anywhere', () => {
    expect(OWNER_SUMMARY).not.toMatch(/drove \$\{/);
    expect(OWNER_SUMMARY).not.toContain("drove ${meta.bookings}");
    expect(OWNER_SUMMARY).not.toContain("drove ${google.bookings}");
  });

  test("zero bookings produces a statement about linkage, not about performance", () => {
    expect(OWNER_SUMMARY).toContain("booking confirmations are not connected yet");
    expect(OWNER_SUMMARY).toMatch(/const outcome = \(bookings: number/);
  });

  test("the campaign grid renders bookings as unmeasured, not as zero", () => {
    expect(GRID).toContain("bookingsLinked");
    expect(GRID).toContain("Not measured");
    // The literal formatters must be behind the linked check, never bare.
    expect(GRID).not.toMatch(/<p className="text-sm font-semibold tabular-nums text-ink">\{formatNumber\(c\.realBookings\)\}<\/p>\s*<\/div>/);
  });

  test("variance is unmeasured too — it was permanently −100%", () => {
    // realBookings is always 0, so (0 - metaReported)/metaReported is always
    // −100% on every campaign, in every period.
    expect(GRID).toMatch(/!bookingsLinked\s*\?\s*"Not measured"/);
  });

  test("the dashboard derives bookingsLinked from measured matches, not a flag", () => {
    expect(DASHBOARD).toContain("bookingsLinked={matchedBookings > 0}");
  });
});

describe("3. the deleted Performance Summary is gone, not hidden", () => {
  test("no component, no render, no import", () => {
    expect(DASHBOARD).not.toContain("OwnerSummaryCard");
    expect(readCode("components/dashboard/HotelDashboardBody.tsx")).not.toContain("OwnerSummaryCard");
  });

  test("its file no longer exists", () => {
    expect(() => readCode("components/dashboard/OwnerSummaryCard.tsx")).toThrow();
  });
});

describe("4. the share header identifies the property, not the sender", () => {
  test("the agency attribution line is removed", () => {
    expect(SHARE_PAGE).not.toContain("Report shared by");
  });

  test("the property name and its domain remain", () => {
    expect(SHARE_PAGE).toContain("{link.hotelName}");
    expect(SHARE_PAGE).toContain("{link.websiteUrl}");
  });
});
