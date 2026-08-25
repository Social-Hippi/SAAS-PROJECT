import { describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0 — Measurement Integrity.
//
// PURE unit tests over the corrected ROAS arithmetic. No database, no session:
// these run anywhere, which matters because the ROAS bug they pin down was
// shipped to agencies AND to hotel clients (dashboard, PDF, public share link).
//
// The defect: `roas` was ALL tracked booking revenue — direct, organic,
// influencer, email, WhatsApp — divided by META-ONLY ad spend, and labelled
// "True ROAS" / "ROAS". On a hotel with strong direct traffic and modest Meta
// spend it produced a spectacular, meaningless number.
//
// The contract now:
//   roas        = paidRevenue / paidSpend       ← paid on BOTH sides
//   blendedRoas = allRevenue  / paidSpend       ← the old figure, honestly named
//   paidSpend   = meta + google, or NULL when currencies can't be combined
// ─────────────────────────────────────────────────────────────────────────────

import { computeKpis, type EventInput, type PaidSpendInput } from "@/lib/attribution";
import { safeRoas } from "@/lib/ad-spend";
import { classifySourceType, isPaidSourceType, PAID_SOURCE_TYPES } from "@/lib/source-classifier";

// ── Builders ────────────────────────────────────────────────────────────────

type ConvOpts = { source?: string | null; medium?: string | null; content?: string | null };

function conversion(value: number, opts: ConvOpts = {}): EventInput {
  return {
    eventType: "conversion",
    utmSource: opts.source ?? null,
    utmMedium: opts.medium ?? null,
    utmContent: opts.content ?? null,
    utmCampaign: null,
    sessionId: "sess_x",
    conversionValue: value,
  };
}
const visit = (opts: ConvOpts = {}): EventInput => ({ ...conversion(0, opts), eventType: "visit", conversionValue: null });

const spend = (meta: number, google: number): PaidSpendInput => ({ meta, google, total: meta + google });
/** Currencies can't be combined → no combined denominator is available. */
const mixedSpend = (meta: number, google: number): PaidSpendInput => ({ meta, google, total: null });

// Canonical fixtures — the same shapes the real conversions take.
const META = { source: "facebook", medium: "cpc" };
const META_IG = { source: "instagram", medium: "paid" };
const GOOGLE = { source: "google", medium: "cpc" };
const DIRECT = {};
const ORGANIC_IG = { source: "instagram", medium: "social" };
const INFLUENCER = { source: "instagram", medium: "influencer" };
const EMAIL = { source: "email", medium: "newsletter" };
const WHATSAPP = { source: "whatsapp", medium: "referral" };

// ── The classification boundary the whole thing rests on ────────────────────

describe("paid vs non-paid classification", () => {
  test("only meta_ads and google_ads are paid", () => {
    expect([...PAID_SOURCE_TYPES].sort()).toEqual(["google_ads", "meta_ads"]);
  });

  test.each([
    ["meta / facebook cpc", META, true],
    ["meta / instagram paid", META_IG, true],
    ["google cpc", GOOGLE, true],
    ["direct", DIRECT, false],
    ["instagram organic", ORGANIC_IG, false],
    ["influencer", INFLUENCER, false],
    ["email", EMAIL, false],
    ["whatsapp", WHATSAPP, false],
  ])("%s → paid=%s", (_label, utm, expected) => {
    expect(isPaidSourceType(classifySourceType(conversion(1, utm)))).toBe(expected);
  });
});

// ── 1–5: the ROAS contract ──────────────────────────────────────────────────

describe("paid ROAS", () => {
  test("1. Meta-only: paid ROAS divides Meta revenue by Meta spend", () => {
    const k = computeKpis([conversion(30_000, META)], spend(10_000, 0));
    expect(k.paidRevenue).toBe(30_000);
    expect(k.roas).toBeCloseTo(3, 6);
    expect(k.spend).toBe(10_000);
  });

  test("2. Google-only: paid ROAS divides Google revenue by Google spend", () => {
    const k = computeKpis([conversion(20_000, GOOGLE)], spend(0, 5_000));
    expect(k.paidRevenue).toBe(20_000);
    expect(k.roas).toBeCloseTo(4, 6);
    expect(k.spendByPlatform).toEqual({ meta: 0, google: 5_000, total: 5_000 });
  });

  test("3. Combined: both platforms' revenue over both platforms' spend", () => {
    const k = computeKpis(
      [conversion(30_000, META), conversion(20_000, GOOGLE)],
      spend(10_000, 5_000),
    );
    expect(k.paidRevenue).toBe(50_000);
    expect(k.spend).toBe(15_000);
    expect(k.roas).toBeCloseTo(50_000 / 15_000, 6);
  });

  test("4. Non-paid revenue is EXCLUDED from the paid ROAS numerator", () => {
    const events = [
      conversion(30_000, META), // paid
      conversion(5_000, DIRECT),
      conversion(7_000, ORGANIC_IG),
      conversion(9_000, INFLUENCER),
      conversion(3_000, EMAIL),
      conversion(1_000, WHATSAPP),
    ];
    const k = computeKpis(events, spend(10_000, 0));

    expect(k.revenue).toBe(55_000); // every booking
    expect(k.paidRevenue).toBe(30_000); // only the Meta one
    expect(k.bookings).toBe(6);
    expect(k.paidBookings).toBe(1);
    expect(k.roas).toBeCloseTo(3, 6); // 30,000 / 10,000 — NOT 5.5×
  });

  test("5. blendedRoas differs from roas whenever non-paid revenue exists", () => {
    const k = computeKpis(
      [conversion(30_000, META), conversion(25_000, DIRECT)],
      spend(10_000, 0),
    );
    expect(k.roas).toBeCloseTo(3.0, 6); // paid
    expect(k.blendedRoas).toBeCloseTo(5.5, 6); // the OLD, contaminated figure
    expect(k.blendedRoas).not.toBeCloseTo(k.roas!, 6);
  });

  test("5b. with no non-paid revenue the two agree (the only safe case)", () => {
    const k = computeKpis([conversion(30_000, META)], spend(10_000, 0));
    expect(k.roas).toBeCloseTo(k.blendedRoas!, 6);
  });

  test("visits are counted but never contribute revenue", () => {
    const k = computeKpis(
      [visit(META), visit(DIRECT), conversion(1_000, META)],
      spend(500, 0),
    );
    expect(k.visits).toBe(2);
    expect(k.bookings).toBe(1);
    expect(k.revenue).toBe(1_000);
  });

  test("a conversion with a null value counts as a booking worth 0", () => {
    const k = computeKpis(
      [{ ...conversion(0, META), conversionValue: null }],
      spend(1_000, 0),
    );
    expect(k.bookings).toBe(1);
    expect(k.paidBookings).toBe(1);
    expect(k.revenue).toBe(0);
    expect(k.roas).toBe(0); // a real 0×, not null: there IS spend to divide by
  });
});

// ── 6–7: degenerate inputs must yield null, never NaN/Infinity/0 ─────────────

describe("zero spend / zero revenue", () => {
  test("6. zero spend → every spend-derived figure is null (never Infinity)", () => {
    const k = computeKpis([conversion(30_000, META)], spend(0, 0));
    expect(k.roas).toBeNull();
    expect(k.blendedRoas).toBeNull();
    expect(k.costPerBooking).toBeNull();
    expect(k.revenue).toBe(30_000); // outcomes survive
    expect(k.paidRevenue).toBe(30_000);
  });

  test("7. zero revenue with real spend → 0×, which is a true answer", () => {
    const k = computeKpis([], spend(10_000, 0));
    expect(k.roas).toBe(0);
    expect(k.blendedRoas).toBe(0);
    expect(k.bookings).toBe(0);
    expect(k.costPerBooking).toBeNull(); // no paid booking to divide by
  });

  test("7b. no data at all → nulls, no NaN", () => {
    const k = computeKpis([], spend(0, 0));
    expect(k.roas).toBeNull();
    expect(k.blendedRoas).toBeNull();
    expect(k.costPerBooking).toBeNull();
    expect(Number.isNaN(k.revenue)).toBe(false);
  });

  test("safeRoas never returns NaN or Infinity", () => {
    expect(safeRoas(100, 0)).toBeNull();
    expect(safeRoas(100, -5)).toBeNull();
    expect(safeRoas(100, null)).toBeNull();
    expect(safeRoas(Number.NaN, 10)).toBeNull();
    expect(safeRoas(100, 25)).toBe(4);
  });
});

// ── 8: mixed currency ───────────────────────────────────────────────────────

describe("mixed currency", () => {
  test("8. an uncombinable currency pair produces NO combined ROAS", () => {
    const k = computeKpis(
      [conversion(30_000, META), conversion(20_000, GOOGLE)],
      mixedSpend(10_000, 5_000),
    );
    // The platform figures survive; only the COMBINED ones are withheld.
    expect(k.spendByPlatform.meta).toBe(10_000);
    expect(k.spendByPlatform.google).toBe(5_000);
    expect(k.spend).toBeNull();
    expect(k.roas).toBeNull();
    expect(k.blendedRoas).toBeNull();
    expect(k.costPerBooking).toBeNull();
    // Revenue is currency-independent here and must NOT be suppressed.
    expect(k.paidRevenue).toBe(50_000);
    expect(k.revenue).toBe(50_000);
  });

  test("8b. mixed currency never silently falls back to meta+google", () => {
    const k = computeKpis([conversion(1_000, META)], mixedSpend(600, 400));
    expect(k.spend).not.toBe(1_000);
    expect(k.spend).toBeNull();
  });
});

// ── Cost per booking ────────────────────────────────────────────────────────

describe("cost per booking", () => {
  test("divides paid spend by PAID bookings, not by every booking", () => {
    const k = computeKpis(
      [conversion(10_000, META), conversion(10_000, META), conversion(10_000, DIRECT)],
      spend(10_000, 0),
    );
    expect(k.bookings).toBe(3);
    expect(k.paidBookings).toBe(2);
    expect(k.costPerBooking).toBeCloseTo(5_000, 6); // 10,000 / 2 — not / 3
  });

  test("no paid bookings → null, even with spend", () => {
    const k = computeKpis([conversion(10_000, DIRECT)], spend(10_000, 0));
    expect(k.paidBookings).toBe(0);
    expect(k.costPerBooking).toBeNull();
  });
});

// ── Regression pin: the exact shape of the original defect ──────────────────

describe("regression: the original contaminated formula", () => {
  test("a direct-heavy hotel no longer reports an inflated ROAS", () => {
    // 1 Meta booking (₹20k) on ₹20k spend = a true 1.0×. Plus ₹180k of direct
    // and organic revenue the ads did not buy. The old formula reported 10×.
    const events = [
      conversion(20_000, META),
      conversion(120_000, DIRECT),
      conversion(60_000, ORGANIC_IG),
    ];
    const k = computeKpis(events, spend(20_000, 0));

    expect(k.roas).toBeCloseTo(1.0, 6); // the honest number
    expect(k.blendedRoas).toBeCloseTo(10.0, 6); // what used to be shown as ROAS
    expect(k.revenue).toBe(200_000);
    expect(k.paidRevenue).toBe(20_000);
  });
});
