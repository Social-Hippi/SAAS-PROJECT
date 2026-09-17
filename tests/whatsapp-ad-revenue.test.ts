import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import {
  countsAsAdBooking,
  summariseValues,
  type WhatsAppBookingValue,
} from "@/lib/whatsapp-booking-values";

// ─────────────────────────────────────────────────────────────────────────────
// REVENUE THE AGENCY TYPES IN.
//
// Kraya records that a WhatsApp booking happened and never what it was worth, so
// the only route from a WhatsApp booking to return-on-ad-spend is a person
// reading the reservations record and keying the amount in.
//
// That makes this the one figure on a client-facing report which is not measured
// — which is exactly why it needs the tightest rules of anything here:
//
//   · an unvalued booking must never read as a booking worth nothing;
//   · a half-filled list must never read as a complete total;
//   · and the ratio built on it must go unknown rather than confident-and-low,
//     because 0.00x on a hotel whose business runs on WhatsApp is a measurement
//     gap being presented as a business result.
// ─────────────────────────────────────────────────────────────────────────────

const LOADER = readCode("lib/metrics/share-views.ts");
const VALUES = readCode("lib/whatsapp-booking-values.ts");
const REPORT = readCode("components/dashboard/ShareReport.tsx");
const ACTION = readCode("app/(agency)/agency/(app)/hotel/[id]/whatsapp-bookings/actions.ts");
const PAGE = readCode("app/(agency)/agency/(app)/hotel/[id]/whatsapp-bookings/page.tsx");
const SCHEMA = readCode("prisma/schema.prisma");

const booking = (over: Partial<WhatsAppBookingValue> = {}): WhatsAppBookingValue => ({
  id: "b1",
  bookedAt: new Date("2026-09-12T10:00:00Z"),
  guestName: "A Guest",
  externalBookingId: "K-1",
  traced: false,
  marked: false,
  amount: null,
  enteredAt: null,
  ...over,
});

describe("1. which bookings count as coming from an ad", () => {
  test("a traced booking counts on the record alone", () => {
    expect(countsAsAdBooking(booking({ traced: true }))).toBe(true);
  });

  test("an untraced booking counts once the agency marks it", () => {
    // Ad tracing began part-way through, so an earlier booking carries no ad
    // even where one plainly caused it. The hotel asked for those included.
    expect(countsAsAdBooking(booking({ marked: true }))).toBe(true);
    expect(countsAsAdBooking(booking())).toBe(false);
  });
});

describe("2. an unvalued booking is never worth zero", () => {
  test("a booking with no amount is counted but not valued", () => {
    const s = summariseValues([booking({ traced: true })]);
    expect(s).toEqual({ countable: 1, valued: 0, total: 0 });
  });

  test("the total sums only what was actually entered", () => {
    const s = summariseValues([
      booking({ id: "a", traced: true, amount: 12_000 }),
      booking({ id: "b", marked: true, amount: 8_000 }),
      booking({ id: "c", traced: true }), // not valued yet
      booking({ id: "d", amount: 99_000 }), // not an ad booking at all
    ]);
    expect(s.countable).toBe(3);
    expect(s.valued).toBe(2);
    expect(s.total).toBe(20_000);
  });

  test("a deliberate zero is a real finding, not a gap", () => {
    const s = summariseValues([booking({ traced: true, amount: 0 })]);
    expect(s.valued).toBe(1);
    expect(s.total).toBe(0);
  });

  test("nothing marked at all is a true zero — nothing counted, nothing missing", () => {
    expect(summariseValues([booking(), booking({ id: "x" })])).toEqual({
      countable: 0,
      valued: 0,
      total: 0,
    });
  });
});

describe("3. the report refuses to launder the gap", () => {
  test("no amount entered renders not_traceable, never 0", () => {
    expect(LOADER).toMatch(/notTraceable<number>\(WHATSAPP_REVENUE_NOT_ENTERED\)/);
    // Asserted on the constant's own text — readCode strips comments, so prose
    // cannot satisfy a source assertion.
    expect(LOADER).toMatch(/It is not a zero/);
  });

  test("a half-filled list says so on the tile", () => {
    expect(LOADER).toMatch(/valued < countable/);
    expect(LOADER).toMatch(/lower than the true total/);
  });

  test("ROAS spans BOTH revenue lines", () => {
    expect(LOADER).toMatch(/sum\(\[totalRevenue, whatsappAdRevenue\]\)/);
    expect(LOADER).toMatch(/ratio\(adRevenueAllChannels, totalSpend/);
    // The old website-only ratio must be gone, or WhatsApp revenue is collected
    // and then silently dropped from the number it exists to feed.
    expect(LOADER).not.toMatch(/ratio\(totalRevenue, totalSpend/);
  });

  test("an incomplete WhatsApp list is surfaced on ROAS too", () => {
    // ROAS now consumes the typed figure, so it inherits the gap that is
    // depressing it — otherwise the ratio quietly understates with no reason
    // given on the tile carrying the number.
    expect(LOADER).toMatch(/returnOnAdSpend:[\s\S]{0,120}whatsappRevenueNote/);
  });
});

describe("4. a typed figure never contaminates a measured one", () => {
  test("agency revenue is its own column, not grossAmount", () => {
    // grossAmount's contract is "as supplied by the source". A typed figure in
    // there would be indistinguishable from the provider's own number.
    expect(SCHEMA).toMatch(/agencyRevenue\s+Decimal\?\s+@db\.Decimal\(12, 2\)/);
    expect(SCHEMA).toMatch(/agencyAdAttributed\s+Boolean\s+@default\(false\)/);
    expect(ACTION).not.toMatch(/grossAmount/);
  });

  test("who entered it and when is recorded", () => {
    expect(SCHEMA).toMatch(/agencyRevenueBy\s+String\?/);
    expect(SCHEMA).toMatch(/agencyRevenueAt\s+DateTime\?/);
    expect(ACTION).toMatch(/agencyRevenueBy: amount == null \? null : member\.id/);
  });

  test("the caption tells the hotel the figure was keyed in", () => {
    expect(LOADER).toMatch(/whatsappAdRevenue:[\s\S]{0,300}entered from the reservations record/);
  });

  test("the report shows it as its own tile, not folded into revenue", () => {
    expect(REPORT).toMatch(/label="Revenue from WhatsApp ad bookings"/);
    expect(REPORT).toMatch(/label="Revenue from ads \/ website"/);
    expect(REPORT).toMatch(/data\.ads\.whatsappAdRevenue/);
  });
});

describe("5. multi-tenancy holds on the hand-written paths", () => {
  test("the raw list query binds agencyId, not just the hotel", () => {
    // A raw query gets none of agencyScoped's automatic filtering.
    expect(VALUES).toMatch(/b\."agencyId" = \$\{agencyId\}/);
    expect(VALUES).toMatch(/b\."hotelClientId" = \$\{hotelClientId\}/);
    expect(VALUES).toMatch(/c\."agencyId" = b\."agencyId"/);
  });

  test("the report's revenue query is agency-scoped too", () => {
    expect(LOADER).toMatch(/agencyRevenue[\s\S]{0,900}b\."agencyId" = \$\{agencyId\}/);
  });

  test("the write re-reads the booking through the agency scope", () => {
    expect(ACTION).toMatch(/agencyScoped\(prisma\.booking\)\.findFirst/);
    expect(ACTION).toMatch(/agencyScoped\(prisma\.booking\)\.update/);
  });

  test("guest names are admin-only, as on the journeys screen", () => {
    expect(PAGE).toMatch(/requireAdmin\(\)/);
  });
});

describe("6. saving keeps the three states apart", () => {
  test("blank clears, absent leaves alone, a number sets", () => {
    // Blank must not become 0: a booking worth an unknown amount would enter the
    // hotel's revenue as one worth nothing.
    expect(ACTION).toMatch(/if \(t === ""\) return null;/);
    expect(ACTION).toMatch(/if \(raw == null\) return undefined;/);
    expect(ACTION).not.toMatch(/\?\? 0/);
  });

  test("the hotel's share link is rebuilt, not just the agency screen", () => {
    expect(ACTION).toMatch(/revalidatePath\("\/share", "layout"\)/);
  });
});
