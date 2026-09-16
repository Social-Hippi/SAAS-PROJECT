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

// The public /share/<uuid> report and the agency's hotel page are now the SAME
// component, so these assertions pin the one surface both of them render.
// (They used to read app/share/[uuid]/PublicReport.tsx, a separate five-panel
// report that has been deleted — a test over a file no live route renders is
// worse than no test, because it passes while the real surface drifts.)
const SHARE_DASHBOARD = read("components/dashboard/FullHotelDashboard.tsx");
const REPORT_PDF = read("lib/report-pdf.ts");
const ROLLUP = read("components/dashboard/AgencyRevenueRollup.tsx");
const AGENCY_DASHBOARD = read("app/(agency)/agency/(app)/dashboard/page.tsx");
const TRACK_ROUTE = read("app/api/track/event/route.ts");
const ALERTS = read("lib/alerts.ts");

// ── 1. Public report: combined paid spend, and correct labels ───────────────

describe("public share report (client-facing)", () => {
  test("the headline Ad spend KPI binds the COMBINED paid spend", () => {
    // The KPI strip's "Ad spend" card divides into the same ROAS shown beside it,
    // so it must be kpis.spend (Meta + Google), never the Meta-only ads.spend.
    expect(SHARE_DASHBOARD).toMatch(
      /label: "Ad spend",[\s\S]{0,200}kpis\.spend != null \? formatCurrency\(kpis\.spend/,
    );
  });

  test("a null combined spend renders “—”, never ₹0", () => {
    // The guard is a null CHECK, not a `?? 0` coercion.
    expect(SHARE_DASHBOARD).toContain("kpis.spend != null");
    expect(SHARE_DASHBOARD).not.toContain("kpis.spend ?? 0");
    expect(SHARE_DASHBOARD).toContain("Ad accounts report in different currencies");
  });

  test("the ROAS hint states the PAID definition", () => {
    expect(SHARE_DASHBOARD).toContain("Paid-channel revenue ÷ paid ad spend");
    // The stale hint described the old blended formula.
    expect(SHARE_DASHBOARD).not.toContain('hint="Revenue ÷ ad spend"');
  });

  test("the cost/booking hint states the PAID definition", () => {
    expect(SHARE_DASHBOARD).toContain("Paid ad spend ÷ paid-attributed bookings");
    expect(SHARE_DASHBOARD).not.toContain('hint="Ad spend ÷ bookings"');
  });

  test("the Meta-only spend figures are labelled as Meta, not as the combined total", () => {
    // `ads.spend` / `ads.spendOverTime` come from AdSnapshot and are Meta-only.
    // They may appear — but only under a tile that says so, never as "Ad spend".
    expect(SHARE_DASHBOARD).toMatch(/Meta ad spend[\s\S]{0,200}formatCurrency\(ads\.spend\)/);
    expect(SHARE_DASHBOARD).toContain("Meta ROAS");
  });

  test("every spend figure on the report is behind the showAdSpend gate", () => {
    // The share link honours the hotel's showAdSpendToHotel flag. Each of these
    // is spend, or something spend divides into, so each must be conditional.
    for (const marker of [
      "showAdSpend ? [{",              // the Ad spend / True ROAS KPI cards
      "{showAdSpend && (",             // the Meta tiles, chart and campaign grid
      "{metaConnected && showAdSpend && (", // the Meta campaign breakdown table
      "budgetStatus && showAdSpend &&", // the monthly ad budget card
    ]) {
      expect(SHARE_DASHBOARD, marker).toContain(marker);
    }
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
    ["FullHotelDashboard.tsx", SHARE_DASHBOARD],
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

// ── 7. The contact report honours showAdSpendToHotel ──────────────────────
//
// ContactReport was added by the client-report-v2 work AFTER the share-page
// spend gate, and did not honour it. On a hotel with showAdSpendToHotel off,
// /share/<uuid> still printed each platform's Spend tile and both halves of the
// "Cost per contact" bridge — while the client-fetched half of the very same
// report (/api/hotel/[id]/owner-metrics, via lib/share-spend-gate.ts) correctly
// returned marketingSpend {total: null, meta: 0, google: 0}. The two halves of
// one page disagreed, and the visible half was the leaking one.
//
// Source assertions, per the file header: this is a binding inside a server
// component, and the binding is what regressed.

const CONTACT_REPORT = read("components/dashboard/contact/ContactReport.tsx");

describe("contact report spend gate", () => {
  test("ContactReport accepts the showAdSpend flag", () => {
    expect(CONTACT_REPORT).toMatch(/showAdSpend:\s*boolean/);
  });

  test("the dashboard passes the flag down rather than hardcoding it", () => {
    // Pins the prop to the variable. `showAdSpend={true}` would satisfy a
    // looser regex while reopening the leak for every share link.
    expect(SHARE_DASHBOARD).toMatch(/<ContactReport[\s\S]*?showAdSpend=\{showAdSpend\}[\s\S]*?\/>/);
  });

  test("the platform Spend tile is gated", () => {
    expect(CONTACT_REPORT).toMatch(
      /showAdSpend\s*&&\s*<Figure\s+label="Spend"/,
    );
  });

  test("the cost-per-contact bridge is gated whole", () => {
    // Both tiles are spend ÷ contacts, so neither survives the flag. The
    // section goes entirely: a "Cost per contact" heading above two dashes
    // still discloses that a spend figure exists.
    expect(CONTACT_REPORT).toMatch(/\{showAdSpend\s*&&\s*\(\s*<section/);
  });

  test("no spend-derived figure renders unconditionally", () => {
    // The blended figures must never appear outside a gated region.
    const ungated = CONTACT_REPORT.replace(/\{showAdSpend[\s\S]*?\n      \)\}/g, "");
    expect(ungated).not.toMatch(/blendedCostPerContact=\{/);
    expect(ungated).not.toMatch(/costPerQualifiedContact=\{/);
  });
});

// ── 8. Recommended actions never quote spend to a spend-hidden reader ─────
//
// The "What to do next" list is built from the same noOutcomeCampaigns rows as
// the panel below it. The panel was gated; the action was not, so the copy
// ("Review {campaign}. It spent {spend} in this period...") put a rupee figure
// in front of readers the panel deliberately hides it from.

describe("recommended actions spend gate", () => {
  test("topNoOutcomeCampaign is gated on showAdSpend", () => {
    expect(SHARE_DASHBOARD).toMatch(
      /topNoOutcomeCampaign:\s*\n?\s*showAdSpend\s*&&\s*noOutcomeCampaigns\[0\]/,
    );
  });
});
