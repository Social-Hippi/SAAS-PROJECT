import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { buildReportNarrative, type NarrativeInput } from "@/lib/report-narrative";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0 final must-fixes — spend DISPLAY integrity.
//
// The Phase 0 ROAS correction made `SpendByPlatform.total` nullable: null means
// "these ad accounts report in currencies we cannot safely add", which is a
// fundamentally different statement from "₹0 was spent". Several consumers
// coerced it with `?? 0`, so an unavailable total rendered as a confident ₹0
// next to a ROAS of "—" — exactly the class of misleading number Phase 0 exists
// to remove. Others still displayed Meta-only spend beside a Meta+Google ROAS.
//
// Two kinds of test here:
//   • BEHAVIOURAL — buildReportNarrative is pure, so null-spend handling is
//     asserted by running it.
//   • SOURCE ASSERTIONS — the remaining fixes are bindings and labels inside
//     React/server components that need a database and a renderer to exercise.
//     Reading the source pins the binding and the wording, which is what
//     actually regressed. This mirrors the existing snippet tests
//     (tests/snippet-conversion.test.ts, tests/phase3-snippet.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const PUBLIC_REPORT = read("app/share/[uuid]/PublicReport.tsx");
const REPORT_PDF = read("lib/report-pdf.ts");
const ROLLUP = read("components/dashboard/AgencyRevenueRollup.tsx");
const AGENCY_DASHBOARD = read("app/(agency)/agency/(app)/dashboard/page.tsx");
const TRACK_ROUTE = read("app/api/track/event/route.ts");
const ALERTS = read("lib/alerts.ts");

// ── 1. Public report: combined paid spend, and correct labels ───────────────

describe("public share report (client-facing)", () => {
  test("the Ad spend tile binds the COMBINED paid spend, not Meta-only ads.spend", () => {
    expect(PUBLIC_REPORT).toContain("kpis.spend == null ? \"—\" : formatCurrency(kpis.spend)");
    // The old Meta-only binding must be gone from the spend tile. `ads.spend` may
    // still legitimately appear nowhere else in this file.
    expect(PUBLIC_REPORT).not.toContain("formatCurrency(ads.spend)");
  });

  test("a null combined spend renders “—”, never ₹0", () => {
    // The guard is a null CHECK, not a `?? 0` coercion.
    expect(PUBLIC_REPORT).toContain("kpis.spend == null");
    expect(PUBLIC_REPORT).not.toContain("kpis.spend ?? 0");
    expect(PUBLIC_REPORT).toContain("Ad accounts report in different currencies");
  });

  test("the ROAS hint states the PAID definition", () => {
    expect(PUBLIC_REPORT).toContain("Paid revenue ÷ paid ad spend");
    // The stale hint described the old blended formula.
    expect(PUBLIC_REPORT).not.toContain('hint="Revenue ÷ ad spend"');
  });

  test("the cost/booking hint states the PAID definition", () => {
    expect(PUBLIC_REPORT).toContain("Paid ad spend ÷ paid bookings");
    expect(PUBLIC_REPORT).not.toContain('hint="Ad spend ÷ bookings"');
  });

  test("the Meta-only spend chart is labelled as Meta, not as the combined total", () => {
    // `ads.spendOverTime` comes from AdSnapshot and is Meta-only; leaving it
    // titled "Spend over time" reads as a breakdown of the combined tile.
    expect(PUBLIC_REPORT).toContain("Meta spend over time");
  });
});

// ── 2. Mixed currency: no ₹0 anywhere a combined total can be null ──────────

describe("mixed-currency spend displays", () => {
  test("report PDF renders “—” for an uncombinable spend total", () => {
    expect(REPORT_PDF).toContain('spend == null ? "—" : money(spend)');
    expect(REPORT_PDF).not.toContain("d.cur.kpis.spend ?? 0");
    expect(REPORT_PDF).not.toContain("d.prev.kpis.spend ?? 0");
  });

  test("report PDF passes null spend THROUGH to the narrative (no coercion)", () => {
    expect(REPORT_PDF).toContain("adSpend: cur.kpis.spend,");
    expect(REPORT_PDF).not.toContain("adSpend: cur.kpis.spend ?? 0");
  });

  test("AgencyRevenueRollup types totalAdSpend as nullable and guards it", () => {
    expect(ROLLUP).toContain("totalAdSpend: number | null");
    // formatCurrency(null) silently yields "₹0" (Math.abs(null) === 0), so the
    // call must be behind a null check.
    expect(ROLLUP).toContain("overview.totalAdSpend == null");
    expect(ROLLUP).toContain("accounts report in different currencies");
  });

  test("agency dashboard does not coerce a null spend total to 0", () => {
    expect(AGENCY_DASHBOARD).toContain("const totalSpend: number | null = paidSpend.total;");
    expect(AGENCY_DASHBOARD).not.toContain("paidSpend.total ?? 0");
    expect(AGENCY_DASHBOARD).not.toContain("priorPaidSpend.total ?? 0");
    expect(AGENCY_DASHBOARD).toContain('totalSpend == null ? "—" : formatCurrency(totalSpend)');
  });

  test("agency dashboard spend KPI is no longer labelled Meta-only", () => {
    // The value became Meta + Google in Phase 0; the label had not followed.
    expect(AGENCY_DASHBOARD).not.toContain('label="Meta ad spend"');
    expect(AGENCY_DASHBOARD).toContain('label="Ad spend"');
  });
});

// ── 3. Narrative: null spend must never become a "₹0 spent" claim ───────────

const NARRATIVE_BASE: NarrativeInput = {
  hotelName: "Seaside Resort",
  rangeLabel: "the last 30 days",
  revenue: 100_000,
  bookings: 10,
  prevRevenue: 80_000,
  prevBookings: 8,
  hasPrevious: true,
  adSpend: 20_000,
  roas: 2.5,
  savings: 5_000,
  visitsChangePct: 0.1,
  topSource: { name: "Instagram", revenue: 60_000, bookings: 6 },
  topInfluencer: null,
  biggestFunnelDrop: null,
};

const allText = (n: ReturnType<typeof buildReportNarrative>) =>
  [n.prose, ...n.keyPoints].join(" ");

describe("report narrative with an unavailable spend figure", () => {
  test("a known spend still produces the ads sentence", () => {
    const n = buildReportNarrative(NARRATIVE_BASE);
    expect(allText(n)).toMatch(/Ads: .*spent/);
    expect(allText(n)).toContain("for every ₹1 spent");
  });

  test("a NULL spend suppresses every ads claim — and never says ₹0", () => {
    const n = buildReportNarrative({ ...NARRATIVE_BASE, adSpend: null });
    const text = allText(n);
    expect(text).not.toMatch(/Ads: /);
    expect(text).not.toContain("₹0 spent");
    // The rest of the narrative is unaffected — outcomes still reported.
    expect(text).toContain("Seaside Resort");
    expect(text).toMatch(/bookings/);
  });

  test("a NULL spend cannot trigger the high-spend/no-return 'poor' verdict", () => {
    // That guardrail asserts "you spent a lot and got little back". With an
    // unavailable spend figure we cannot make that claim.
    const n = buildReportNarrative({ ...NARRATIVE_BASE, adSpend: null, roas: null, bookings: 0 });
    expect(n.verdict).toBe("none"); // "no bookings", not "poor"
    expect(allText(n)).not.toContain("well short of what the ad spend should be returning");
  });

  test("a real high-spend/no-return period still trips the guardrail", () => {
    const n = buildReportNarrative({ ...NARRATIVE_BASE, adSpend: 50_000, roas: 0.1 });
    expect(n.verdict).toBe("poor");
    expect(n.prose).toContain("well short of what the ad spend should be returning");
  });

  test("zero spend is treated as 'no ads', distinct from an unavailable total", () => {
    const n = buildReportNarrative({ ...NARRATIVE_BASE, adSpend: 0, roas: null });
    expect(allText(n)).not.toMatch(/Ads: /);
  });
});

// ── 4. No misleading influencer-redemption protection remains ──────────────

describe("influencer redemption dedupe", () => {
  test("the dead trackingEventId self-check is gone", () => {
    // `ev` is created immediately above the old check, so a lookup by its own id
    // could never match — dead code that read like a safeguard.
    expect(TRACK_ROUTE).not.toContain("trackingEventId: ev.id },");
    expect(TRACK_ROUTE).not.toContain("alreadyRedeemed");
    expect(TRACK_ROUTE).not.toContain("[REDEMPTION-DUPLICATE]");
  });

  test("the remaining guarantee is documented as application-level, not DB-level", () => {
    expect(TRACK_ROUTE).toContain("APPLICATION-level invariant, not a database one");
    // Comment wraps across lines, so match across the line break.
    expect(TRACK_ROUTE).toMatch(/no unique\s*\/\/\s*constraint on InfluencerRedemption/);
  });

  test("the real conversion-idempotency guard is still in place", () => {
    expect(TRACK_ROUTE).toContain("[TRACK-CONVERSION-DUPLICATE]");
    expect(TRACK_ROUTE).toContain('eventType: "conversion",\n          sessionId: teData.sessionId,');
  });

  test("the conversion value cap is still enforced before persistence", () => {
    expect(TRACK_ROUTE).toContain("n > MAX_CONVERSION_VALUE");
    expect(TRACK_ROUTE).toContain("[TRACK-VALUE-REJECTED]");
  });
});

// ── 5. Same hotel population on both sides of every ratio ──────────────────

describe("soft-deleted hotel consistency", () => {
  test("agency dashboard filters events to the same hotels the spend uses", () => {
    expect(AGENCY_DASHBOARD).toContain("const dashboardHotelIdSet = new Set(dashboardHotelIds)");
    // Current-period events.
    expect(AGENCY_DASHBOARD).toContain("if (!dashboardHotelIdSet.has(e.hotelClientId)) continue;");
    // Prior-period aggregates.
    expect(AGENCY_DASHBOARD).toContain("if (!dashboardHotelIdSet.has(g.hotelClientId)) continue;");
    // Prior-period paid revenue.
    expect(AGENCY_DASHBOARD).toContain("dashboardHotelIdSet.has(c.hotelClientId)");
  });

  test("agency dashboard prior aggregate groups by hotel so it CAN be filtered", () => {
    expect(AGENCY_DASHBOARD).toContain('by: ["eventType", "hotelClientId"]');
    // With a per-hotel grouping the totals must accumulate, not overwrite.
    expect(AGENCY_DASHBOARD).toContain("prior.visits += g._count._all");
    expect(AGENCY_DASHBOARD).toContain("prior.bookings += g._count._all");
  });

  test("weekly summary email scopes spend AND paid revenue to active hotels", () => {
    expect(ALERTS).toContain("const activeHotelIds = new Set(hotels.map((h) => h.id))");
    expect(ALERTS).toContain("if (!activeHotelIds.has(g.hotelClientId)) continue;");
    expect(ALERTS).toContain("activeHotelIds.has(c.hotelClientId)");
  });
});

// ── 6. No contaminated ROAS reintroduced ──────────────────────────────────

describe("no contaminated ROAS formulas", () => {
  const LIVE_SOURCES: [string, string][] = [
    ["PublicReport.tsx", PUBLIC_REPORT],
    ["report-pdf.ts", REPORT_PDF],
    ["agency dashboard", AGENCY_DASHBOARD],
    ["alerts.ts", ALERTS],
  ];

  test.each(LIVE_SOURCES)("%s divides no all-revenue figure by ad spend", (_name, src) => {
    // The exact shapes of the original defect.
    expect(src).not.toMatch(/totalRevenue\s*\/\s*(metaSpend|adSpend|totalSpend)/);
    expect(src).not.toMatch(/totals\.revenue\s*\/\s*(metaSpend|adSpend|totalSpend)/);
    expect(src).not.toMatch(/allRevenue\s*\/\s*\w*[Ss]pend/);
  });
});
