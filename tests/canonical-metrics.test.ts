import { describe, it, expect } from "vitest";
import {
  canonicalSourceType,
  isPaidRow,
  paidRevenueOf,
  paidBookingsOf,
  totalRevenueOf,
  realisedValueOf,
  attributionOutcomeOf,
  coverageOf,
  safeRoas,
  type CanonicalRow,
} from "@/lib/metrics/canonical";

function row(over: Partial<CanonicalRow> = {}): CanonicalRow {
  return { utmSource: null, utmMedium: null, value: 0, ...over };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("canonicalSourceType — the divergence that shipped on two screens", () => {
  it("a paid Meta click that ALSO used a coupon is paid, not influencer", () => {
    // The exact bug: rowSourceType() said influencer, classifySourceType() said
    // meta_ads, and both shipped. One hotel, one day, two ROAS figures.
    const r = row({ utmSource: "facebook", utmMedium: "cpc", couponCode: "PRIYA10", value: 50000 });
    expect(canonicalSourceType(r)).toBe("meta_ads");
    expect(isPaidRow(r)).toBe(true);
  });

  it("a Google auto-tagged click with a coupon is paid, not influencer", () => {
    const r = row({ gclid: "Cj0KCQ", couponCode: "PRIYA10", value: 20000 });
    expect(canonicalSourceType(r)).toBe("google_ads");
  });

  it("a coupon with no paid evidence is still influencer", () => {
    expect(canonicalSourceType(row({ couponCode: "PRIYA10", value: 9000 }))).toBe("influencer");
  });

  it("a coupon outranks organic social", () => {
    const r = row({ utmSource: "instagram", utmMedium: "bio", couponCode: "PRIYA10" });
    expect(canonicalSourceType(r)).toBe("influencer");
  });

  it("no coupon and no paid signal falls through to the UTM classifier", () => {
    expect(canonicalSourceType(row({ utmSource: "instagram", utmMedium: "bio" }))).toBe("instagram_organic");
    expect(canonicalSourceType(row({ utmSource: "email", utmMedium: "newsletter" }))).toBe("email");
    expect(canonicalSourceType(row())).toBe("direct");
  });

  it("classifies each row independently when summing", () => {
    const rows = [
      row({ utmSource: "facebook", utmMedium: "cpc", couponCode: "X", value: 50000 }), // paid
      row({ couponCode: "X", value: 10000 }),                                          // influencer
      row({ value: 4000 }),                                                            // direct
    ];
    expect(totalRevenueOf(rows)).toBe(64000);
    expect(paidRevenueOf(rows)).toBe(50000);
    expect(paidBookingsOf(rows)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("attributionOutcomeOf — positive evidence only", () => {
  const hotelHost = "silentshoresresort.com";

  it("any UTM field is attribution evidence", () => {
    for (const k of ["utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm"] as const) {
      expect(attributionOutcomeOf(row({ [k]: "monsoon" } as Partial<CanonicalRow>))).toBe("attributed");
    }
  });

  it("any click id is attribution evidence", () => {
    for (const k of ["gclid", "gbraid", "wbraid", "fbclid"] as const) {
      expect(attributionOutcomeOf(row({ [k]: "abc123" } as Partial<CanonicalRow>))).toBe("attributed");
    }
  });

  it("a coupon is attribution evidence", () => {
    expect(attributionOutcomeOf(row({ couponCode: "PRIYA10" }))).toBe("attributed");
  });

  it("THE FIX: no evidence and no prior visit is unknown, NOT direct", () => {
    // This is the defect. Previously this booking was reported as "Direct",
    // so an agency reading "Direct 62%" cut the spend that produced it.
    const outcome = attributionOutcomeOf(row({ value: 30000 }), {
      session: { referrer: null },
      hotelHost,
      visitorHasPriorSession: false,
    });
    expect(outcome).toBe("unknown_no_evidence");
    expect(outcome).not.toBe("direct_confirmed");
  });

  it("a returning visitor with no referrer IS direct", () => {
    // Rule 7. Without it the split is a relabelling exercise: everything
    // untraceable becomes "unknown" and genuine direct traffic disappears.
    expect(
      attributionOutcomeOf(row(), { session: { referrer: null }, hotelHost, visitorHasPriorSession: true }),
    ).toBe("direct_confirmed");
  });

  it("an internal referrer is direct; an external one is a referral channel", () => {
    expect(
      attributionOutcomeOf(row(), { session: { referrer: "https://www.silentshoresresort.com/rooms" }, hotelHost }),
    ).toBe("direct_confirmed");
    expect(
      attributionOutcomeOf(row(), { session: { referrer: "https://tripadvisor.in/x" }, hotelHost }),
    ).toBe("attributed");
  });

  it("a bare host referrer and a www prefix are both handled", () => {
    expect(attributionOutcomeOf(row(), { session: { referrer: "silentshoresresort.com" }, hotelHost })).toBe(
      "direct_confirmed",
    );
    expect(
      attributionOutcomeOf(row(), { session: { referrer: "https://www.silentshoresresort.com" }, hotelHost }),
    ).toBe("direct_confirmed");
  });

  it("a malformed referrer does not become direct by accident", () => {
    expect(
      attributionOutcomeOf(row(), { session: { referrer: "   " }, hotelHost, visitorHasPriorSession: false }),
    ).toBe("unknown_no_evidence");
  });

  it("no session at all is unknown_no_session", () => {
    expect(attributionOutcomeOf(row({ value: 1000 }), { session: null })).toBe("unknown_no_session");
  });

  it("a caller supplying no evidence errs toward unknown, never toward direct", () => {
    // A lazy call site must not be able to manufacture a claim it cannot support.
    expect(attributionOutcomeOf(row({ value: 1000 }))).toBe("unknown_no_session");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("realisedValueOf — cancellations and refunds", () => {
  const r = row({ value: 40000 });

  it("no matched booking leaves the value untouched", () => {
    expect(realisedValueOf(r)).toBe(40000);
    expect(realisedValueOf(r, null)).toBe(40000);
  });

  it("cancelled, refunded and no-show remove the revenue entirely", () => {
    for (const status of ["CANCELLED", "REFUNDED", "NO_SHOW", "cancelled"]) {
      expect(realisedValueOf(r, { status })).toBe(0);
    }
  });

  it("confirmed and completed keep it", () => {
    expect(realisedValueOf(r, { status: "CONFIRMED" })).toBe(40000);
    expect(realisedValueOf(r, { status: "COMPLETED" })).toBe(40000);
  });

  it("a partial refund is deducted and never goes negative", () => {
    expect(realisedValueOf(r, { status: "CONFIRMED", refundedAmount: 15000 })).toBe(25000);
    expect(realisedValueOf(r, { status: "CONFIRMED", refundedAmount: 99999 })).toBe(0);
  });

  it("cancelled revenue leaves both totals", () => {
    const rows = [
      row({ utmSource: "facebook", utmMedium: "cpc", value: 50000, sessionId: "a" }),
      row({ utmSource: "facebook", utmMedium: "cpc", value: 30000, sessionId: "b" }),
    ];
    const cancelledB = (x: CanonicalRow) => (x.sessionId === "b" ? { status: "CANCELLED" } : null);
    expect(totalRevenueOf(rows)).toBe(80000);
    expect(totalRevenueOf(rows, cancelledB)).toBe(50000);
    expect(paidRevenueOf(rows, cancelledB)).toBe(50000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("coverageOf — the invariant every screen depends on", () => {
  const hotelHost = "example.com";

  it("splits the three buckets and reconciles exactly", () => {
    const rows = [
      row({ utmSource: "google", utmMedium: "cpc", value: 50000, sessionId: "s1" }),
      row({ value: 20000, sessionId: "s2" }),
      row({ value: 30000, sessionId: "s3" }),
    ];
    const evidence = (x: CanonicalRow) =>
      x.sessionId === "s2"
        ? { session: { referrer: null }, hotelHost, visitorHasPriorSession: true }
        : { session: { referrer: null }, hotelHost, visitorHasPriorSession: false };

    const c = coverageOf(rows, evidence);
    expect(c.attributedRevenue).toBe(50000);
    expect(c.directRevenue).toBe(20000);
    expect(c.unknownRevenue).toBe(30000);
    expect(c.totalRevenue).toBe(100000);
    expect(c.attributedRevenue + c.directRevenue + c.unknownRevenue).toBe(c.totalRevenue);
    expect(c.coveragePct).toBeCloseTo(0.7, 10);
    expect(c.unknownByReason.unknown_no_evidence).toBe(30000);
  });

  it("holds the sum invariant over randomised fixtures", () => {
    for (let seed = 0; seed < 200; seed++) {
      const rows: CanonicalRow[] = [];
      for (let i = 0; i < 25; i++) {
        const k = (seed * 31 + i * 7) % 5;
        rows.push(
          row({
            value: ((seed * 13 + i * 29) % 97) * 100,
            sessionId: k === 4 ? "" : `s${i}`,
            utmSource: k === 0 ? "google" : null,
            utmMedium: k === 0 ? "cpc" : null,
            couponCode: k === 1 ? "CODE" : null,
          }),
        );
      }
      const c = coverageOf(rows, (x) => ({
        session: x.sessionId ? { referrer: null } : null,
        hotelHost,
        visitorHasPriorSession: (x.value / 100) % 2 === 0,
      }));
      expect(c.attributedRevenue + c.directRevenue + c.unknownRevenue).toBe(c.totalRevenue);
      expect(c.attributedBookings + c.directBookings + c.unknownBookings).toBe(c.totalBookings);
    }
  });

  it("coveragePct is NULL, not 0, when there is no revenue", () => {
    // Unknown is never zero. A hotel with no bookings has no coverage figure,
    // it does not have 0% coverage.
    expect(coverageOf([]).coveragePct).toBeNull();
    expect(coverageOf([row({ value: 0 })]).coveragePct).toBeNull();
  });

  it("counts how booking values were derived, for the C-3 disclosure", () => {
    const rows = [
      row({ value: 1000, valueSource: "attribute" }),
      row({ value: 2000, valueSource: "heuristic" }),
      row({ value: 3000, valueSource: "heuristic" }),
      row({ value: 4000 }), // legacy row: derivation unknown, never "measured"
    ];
    const c = coverageOf(rows);
    expect(c.heuristicValueBookings).toBe(2);
    expect(c.unknownValueSourceBookings).toBe(1);
  });

  it("cancelled revenue leaves the coverage total too", () => {
    const rows = [row({ utmSource: "google", utmMedium: "cpc", value: 50000, sessionId: "a" })];
    const c = coverageOf(rows, () => ({}), () => ({ status: "CANCELLED" }));
    expect(c.totalRevenue).toBe(0);
    expect(c.coveragePct).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("safeRoas", () => {
  it("is null on zero, negative, null or non-finite spend", () => {
    for (const spend of [0, -1, null, NaN, Infinity]) {
      expect(safeRoas(100000, spend as number | null)).toBeNull();
    }
  });
  it("divides when it can", () => {
    expect(safeRoas(100000, 25000)).toBe(4);
  });
});
