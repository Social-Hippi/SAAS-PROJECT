import { describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1B ingestion contract — PURE tests (no database).
//
// These pin the two promises the canonical event makes to every future provider:
//
//   1. A provider may not know a value. Only eventType / provider /
//      externalBookingId / occurredAt are required; everything else stays NULL
//      when unsupplied — never defaulted, never zero-filled, never assumed.
//   2. A provider payload is UNTRUSTED. Malformed input is rejected or dropped,
//      never coerced into a plausible-looking number or date.
// ─────────────────────────────────────────────────────────────────────────────

import {
  BOOKING_EVENT_TYPES,
  MAX_BOOKING_AMOUNT,
  normalizeAmount,
  normalizeCurrency,
  normalizeDate,
  normalizeProvider,
  validateBookingEvent,
  type CanonicalBookingEvent,
} from "@/lib/booking-events";
import {
  getBookingProvider,
  listBookingProviders,
  registerBookingProvider,
  resetBookingProviders,
  type BookingProviderAdapter,
} from "@/lib/booking-provider";

const OCCURRED = "2026-08-20T10:00:00.000Z";

/** The smallest event a provider can legally send. */
const minimal = (over: Partial<CanonicalBookingEvent> = {}): CanonicalBookingEvent => ({
  eventType: "BOOKING_CREATED",
  provider: "test_pms",
  externalBookingId: "RES-1001",
  occurredAt: OCCURRED,
  ...over,
});

const ok = (e: CanonicalBookingEvent) => {
  const r = validateBookingEvent(e);
  if (!r.ok) throw new Error(`expected valid, got: ${r.errors.join("; ")}`);
  return r.event;
};

// ── Required vs optional ─────────────────────────────────────────────────

describe("canonical event validation", () => {
  test("the minimal event is valid — nothing else is mandatory", () => {
    const e = ok(minimal());
    expect(e.externalBookingId).toBe("RES-1001");
    expect(e.provider).toBe("test_pms");
    expect(e.status).toBe("CONFIRMED"); // derived from eventType
  });

  test.each(["eventType", "provider", "externalBookingId", "occurredAt"])(
    "%s is required",
    (field) => {
      const r = validateBookingEvent(minimal({ [field]: undefined } as Partial<CanonicalBookingEvent>));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join(" ")).toContain(field);
    },
  );

  test("an unsupplied optional field is NULL, never a default or zero", () => {
    const e = ok(minimal());
    expect(e.currency).toBeNull(); // NOT "INR"
    expect(e.checkIn).toBeNull();
    expect(e.checkOut).toBeNull();
    expect(e.bookingChannel).toBeNull();
    expect(e.guestName).toBeNull();
    expect(e.externalGuestId).toBeNull();
    for (const v of Object.values(e.amounts)) expect(v).toBeNull(); // not "0.00"
  });

  test("validation never throws, even on hostile input", () => {
    for (const bad of [{}, { eventType: 1 }, { provider: [] }, { occurredAt: "nonsense" }]) {
      expect(() => validateBookingEvent(bad as CanonicalBookingEvent)).not.toThrow();
    }
  });

  test("every declared event type maps to a status", () => {
    for (const t of BOOKING_EVENT_TYPES) {
      expect(ok(minimal({ eventType: t })).status).toBeTruthy();
    }
  });

  test.each([
    ["BOOKING_CREATED", "CONFIRMED"],
    ["BOOKING_UPDATED", "MODIFIED"],
    ["BOOKING_CANCELLED", "CANCELLED"],
    ["BOOKING_REFUNDED", "REFUNDED"],
    ["BOOKING_COMPLETED", "COMPLETED"],
  ])("%s implies %s", (eventType, status) => {
    expect(ok(minimal({ eventType })).status).toBe(status);
  });

  test("an unrecognised explicit status falls back to the event type, with a warning", () => {
    const e = ok(minimal({ eventType: "BOOKING_CANCELLED", status: "PENDING_MAYBE" }));
    expect(e.status).toBe("CANCELLED");
    expect(e.warnings.join(" ")).toContain("status");
  });
});

// ── Provider normalization ───────────────────────────────────────────────

describe("provider normalization", () => {
  test("provider is slug-normalized so casing never forks a provider", () => {
    expect(normalizeProvider("Cloudbeds")).toBe("cloudbeds");
    expect(normalizeProvider("  STAAH  ")).toBe("staah");
  });

  test.each([["a space", "my pms"], ["a slash", "a/b"], ["empty", ""], ["a symbol", "pms!"]])(
    "rejects %s",
    (_l, v) => expect(normalizeProvider(v)).toBeNull(),
  );
});

// ── Currency ─────────────────────────────────────────────────────────────

describe("currency handling", () => {
  test("a valid ISO-4217 code is upper-cased and kept", () => {
    expect(normalizeCurrency("inr")).toBe("INR");
    expect(normalizeCurrency("USD")).toBe("USD");
  });

  test("a malformed code is DROPPED to unknown — never guessed", () => {
    for (const bad of ["rupees", "IN", "INRR", "12"]) expect(normalizeCurrency(bad)).toBeNull();
  });

  test("dropping a malformed currency is surfaced as a warning, not a silent loss", () => {
    const e = ok(minimal({ currency: "rupees" }));
    expect(e.currency).toBeNull();
    expect(e.warnings.join(" ")).toContain("currency");
  });

  test("INR is never assumed when the provider omits currency", () => {
    expect(ok(minimal()).currency).toBeNull();
  });
});

// ── Amounts ──────────────────────────────────────────────────────────────

describe("amount normalization", () => {
  test("numbers and numeric strings both work, at 2dp", () => {
    expect(normalizeAmount(50000)).toBe("50000.00");
    expect(normalizeAmount("50000.5")).toBe("50000.50");
    expect(normalizeAmount("1,25,000")).toBe("125000.00");
  });

  test("zero is a REAL value and is preserved", () => {
    // A provider reporting 0 is different from a provider saying nothing.
    expect(normalizeAmount(0)).toBe("0.00");
  });

  test.each([
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["non-numeric", "fifty thousand"],
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
  ])("%s becomes NULL, never 0", (_l, v) => {
    expect(normalizeAmount(v)).toBeNull();
  });

  test("an over-width amount is DROPPED, not truncated", () => {
    expect(normalizeAmount(MAX_BOOKING_AMOUNT)).toBe(MAX_BOOKING_AMOUNT.toFixed(2));
    expect(normalizeAmount(MAX_BOOKING_AMOUNT + 1)).toBeNull();
  });

  test("each revenue component is kept separately, exactly as supplied", () => {
    const e = ok(minimal({ amounts: { gross: 50000, net: 45000, tax: 5000 } }));
    expect(e.amounts.gross).toBe("50000.00");
    expect(e.amounts.net).toBe("45000.00");
    expect(e.amounts.tax).toBe("5000.00");
    // Nothing is derived: roomRevenue is NOT inferred from gross − tax.
    expect(e.amounts.roomRevenue).toBeNull();
    expect(e.amounts.ancillaryRevenue).toBeNull();
  });

  test("a provider supplying only a total populates only that field", () => {
    const e = ok(minimal({ amounts: { gross: 50000 } }));
    expect(e.amounts.gross).toBe("50000.00");
    expect(e.amounts.net).toBeNull();
    expect(e.amounts.tax).toBeNull();
  });

  test("a bad amount is dropped and warned about, and does not fail the event", () => {
    const e = ok(minimal({ amounts: { gross: 50000, net: "unknown" } }));
    expect(e.amounts.gross).toBe("50000.00");
    expect(e.amounts.net).toBeNull();
    expect(e.warnings.join(" ")).toContain("net");
  });
});

// ── Dates ────────────────────────────────────────────────────────────────

describe("date handling", () => {
  test("ISO strings, epoch millis and Date objects all parse", () => {
    expect(normalizeDate("2026-08-20T10:00:00Z")?.toISOString()).toBe("2026-08-20T10:00:00.000Z");
    expect(normalizeDate(Date.parse("2026-08-20T10:00:00Z"))).toBeInstanceOf(Date);
    expect(normalizeDate(new Date("2026-08-20"))).toBeInstanceOf(Date);
  });

  test.each([["junk", "not a date"], ["epoch 0", 0], ["year 1899", "1899-01-01"], ["year 2200", "2200-01-01"]])(
    "rejects %s",
    (_l, v) => expect(normalizeDate(v)).toBeNull(),
  );

  test("an inconsistent stay is kept but flagged, not silently 'corrected'", () => {
    const e = ok(minimal({ checkIn: "2026-09-10", checkOut: "2026-09-05" }));
    expect(e.checkIn).toBeInstanceOf(Date);
    expect(e.checkOut).toBeInstanceOf(Date);
    expect(e.warnings.join(" ")).toContain("checkOut precedes checkIn");
  });
});

// ── Raw payload isolation ────────────────────────────────────────────────

describe("raw provider data stays out of the canonical fields", () => {
  test("vendor-specific keys are not copied into canonical fields", () => {
    const e = ok(
      minimal({
        rawPayload: { reservationNumber: "R-9", arrivalDate: "2026-09-01", totalAmount: 50000 },
      }),
    );
    // The adapter must map these explicitly; the validator does NOT guess.
    expect(e.checkIn).toBeNull();
    expect(e.amounts.gross).toBeNull();
    expect(e.externalBookingId).toBe("RES-1001"); // not "R-9"
    expect(e.rawPayload).toEqual({
      reservationNumber: "R-9",
      arrivalDate: "2026-09-01",
      totalAmount: 50000,
    });
  });

  test("control characters are stripped from strings", () => {
    const e = ok(minimal({ externalBookingId: "RES -1001" }));
    expect(e.externalBookingId).toBe("RES-1001");
  });
});

// ── Adapter registry ─────────────────────────────────────────────────────

describe("provider adapter registry", () => {
  test("no provider is registered — none is connected yet", () => {
    resetBookingProviders();
    expect(listBookingProviders()).toHaveLength(0);
    expect(getBookingProvider("cloudbeds")).toBeNull();
  });

  test("an adapter can register and be resolved by slug", () => {
    resetBookingProviders();
    const fake: BookingProviderAdapter = {
      provider: "test_pms",
      displayName: "Test PMS",
      capabilities: { webhook: true, polling: false },
      async validateConnection() {
        return { ok: true, value: { externalAccountId: "acct-1" } };
      },
    };
    registerBookingProvider(fake);
    expect(getBookingProvider("test_pms")?.displayName).toBe("Test PMS");
    resetBookingProviders();
  });

  test("an unknown provider resolves to null rather than a stub", () => {
    // A stub would let a misconfigured connection silently ingest nothing.
    expect(getBookingProvider("nope")).toBeNull();
  });
});
