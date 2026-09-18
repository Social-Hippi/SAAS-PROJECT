import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// Meta ROAS and Google ROAS on the hotel's report.
//
// EACH PLATFORM GETS ONLY ITS OWN REVENUE, and no rupee is in both:
//
//   Meta ROAS   = (WhatsApp ad booking revenue + website bookings from a Meta
//                  ad click) ÷ Meta spend
//   Google ROAS = website bookings from a Google ad click ÷ Google spend
//
// The rejected alternative — the same WhatsApp revenue over each platform's
// spend — credits Google with bookings Meta produced, and invites a reader to
// add "3x Meta" and "2x Google" into a 5x the ads never returned.
// ─────────────────────────────────────────────────────────────────────────────

const LOADER = readCode("lib/metrics/share-views.ts");
const REPORT = readCode("components/dashboard/ShareReport.tsx");

const metaRoasLine = () => {
  const at = LOADER.indexOf("const metaRoas = ratio(");
  return LOADER.slice(at, LOADER.indexOf(";", at));
};
const googleRoasLine = () => {
  const at = LOADER.indexOf("const googleRoas = ratio(");
  return LOADER.slice(at, LOADER.indexOf(";", at));
};

describe("1. each platform is divided by its own revenue and its own spend", () => {
  test("Meta: WhatsApp ad revenue plus Meta website revenue, over Meta spend", () => {
    expect(metaRoasLine()).toMatch(
      /ratio\(sum\(\[websiteRevenueOf\(metaWebRevenue\), whatsappAdRevenue\]\), metaSpend/,
    );
  });

  test("Google: Google website revenue only, over Google spend", () => {
    expect(googleRoasLine()).toMatch(/ratio\(websiteRevenueOf\(googleWebRevenue\), googleSpend/);
  });

  test("Google ROAS never includes WhatsApp revenue", () => {
    // WhatsApp ad bookings are Meta's; counting them here would put the same
    // rupees in both tiles.
    expect(googleRoasLine()).not.toMatch(/whatsapp/i);
    expect(googleRoasLine()).not.toMatch(/metaWebRevenue|metaSpend/);
    expect(metaRoasLine()).not.toMatch(/googleWebRevenue|googleSpend/);
  });
});

describe("2. no rupee is credited to both platforms", () => {
  test("a website booking is split by exactly one classified platform", () => {
    // `type` is a single canonical value per conversion, so a booking can match
    // at most one of these.
    expect(LOADER).toMatch(/if \(type === "google_ads"\) \{\s*googleWebRevenue \+= value;/);
    expect(LOADER).toMatch(/if \(type === "meta_ads"\) metaWebRevenue \+= value;/);
    expect(LOADER).toMatch(/const type = canonicalSourceType\(\{ \.\.\.c, value \}\);/);
  });

  test("together the platform numerators are the overall numerator, never more", () => {
    // overall = website ad revenue (meta_ads + google_ads) + WhatsApp ad revenue
    expect(LOADER).toMatch(/if \(type === "meta_ads" \|\| type === "google_ads"\) \{\s*adRevenue \+= value;/);
    expect(LOADER).toMatch(/const adRevenueAllChannels = sum\(\[totalRevenue, whatsappAdRevenue\]\)/);
    // …and WhatsApp revenue appears in exactly one platform tile.
    // Anchored on code: readCode strips comments.
    const start = LOADER.indexOf("const websiteRevenueOf");
    const end = LOADER.indexOf(";", LOADER.indexOf("const googleRoas = ratio("));
    expect(start).toBeGreaterThan(-1);
    expect(LOADER.slice(start, end).match(/whatsappAdRevenue/g)?.length).toBe(1);
  });
});

describe("3. a gap is never shown as a finding", () => {
  test("unknowns propagate through sum and ratio instead of becoming 0", () => {
    expect(metaRoasLine()).toMatch(/sum\(/);
    expect(metaRoasLine()).toMatch(/ratio\(/);
    expect(googleRoasLine()).toMatch(/ratio\(/);
  });

  test("zero spend is 'nothing to divide by', not an infinite or zero ROAS", () => {
    expect(metaRoasLine()).toMatch(/zeroDenominatorReason: noSpendReason\("Meta Ads"\)/);
    expect(googleRoasLine()).toMatch(/zeroDenominatorReason: noSpendReason\("Google Ads"\)/);
  });

  test("a Google zero explains that tracing, not Google, may be the cause", () => {
    expect(LOADER).toMatch(/googleWebBookings === 0\s*\?\s*NO_GOOGLE_AD_BOOKING_YET/);
  });

  test("Meta ROAS carries the half-entered WhatsApp warning", () => {
    expect(LOADER).toMatch(/metaRoas: showAdSpend \? \(whatsappRevenueNote \?\? metaNote\) : undefined/);
  });
});

describe("4. spend stays private when it is meant to", () => {
  test("both platform ROAS figures are withheld exactly when spend is", () => {
    expect(LOADER).toMatch(/metaRoas: showAdSpend \? metaRoas : withheld/);
    expect(LOADER).toMatch(/googleRoas: showAdSpend \? googleRoas : withheld/);
  });

  test("the report renders them only when spend is shown", () => {
    const at = REPORT.indexOf('<Group title="Return on ad spend by platform"');
    expect(at).toBeGreaterThan(-1);
    expect(REPORT.slice(at - 80, at)).toMatch(/\{showAdSpend && \(\s*$/);
  });

  test("both tiles are ratios, labelled as the agency named them", () => {
    expect(REPORT).toMatch(/label="Meta ROAS"\s+value=\{data\.ads\.metaRoas\}\s+format="multiple"/);
    expect(REPORT).toMatch(/label="Google ROAS"\s+value=\{data\.ads\.googleRoas\}\s+format="multiple"/);
  });
});
