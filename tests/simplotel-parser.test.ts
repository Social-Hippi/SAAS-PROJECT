import { describe, expect, test } from "vitest";

import { simplotelAdapter } from "@/lib/booking-providers/simplotel";
import { validateBookingEvent } from "@/lib/booking-events";

// ─────────────────────────────────────────────────────────────────────────────
// The Simplotel mapping, written from the payloads Simplotel actually sent —
// held by the receiver on 19 and 21 Sep 2026 — not from a spec.
//
// The payload below is that real body, with the guest masked exactly as the
// viewer masks it. Field names, formats and amounts are untouched.
// ─────────────────────────────────────────────────────────────────────────────

const PAYLOAD = {
  hotel_id: "8642",
  booking_id: "SKQVHO",
  checkin_date: "2026-09-28",
  checkout_date: "2026-09-29",
  total_amount: "9086.0000",
  amount_paid: "0.0000",
  promocode: "goapp",
  booking_status: "CONFIRMED",
  special_requests: "non smoking family room",
  name: "A Guest",
  email: "guest@example.com",
  phone: "919000000051",
  address: "",
  pincode: "",
  gst_number: "",
  rooms: [
    {
      id: 3764451,
      room_type: 111648,
      room_name: "Family Room",
      total_taxes: "1386.0000",
      total_amount_before_taxes: "7700.0000",
      total_amount: "9086.0000",
      day_rates: [{ stay_date: "2026-09-28", rate: "7700.0000", id: 6787396 }],
      is_cancelled: false,
      refund_amount: "0.0000",
      rate_plan: 64328,
      adults: 3,
      children: 0,
      addons: [],
      total_addon_amount_before_taxes: "0",
      total_addon_taxes: "0",
      total_addon_amount: "0",
    },
  ],
  independent_addons: [],
  no_of_guests: { adults: 3, childs: 0 },
  booking_date: "2026-09-21",
  pg_name: "RAZORPAY",
};

const parse = (body: unknown) => simplotelAdapter.parseWebhook!(JSON.stringify(body), new Headers());

const first = (body: unknown) => {
  const r = parse(body);
  if (!r.ok) throw new Error(`expected a parse, got: ${r.error}`);
  expect(r.value).toHaveLength(1);
  return r.value[0];
};

describe("1. the real payload maps to a booking", () => {
  const e = first(PAYLOAD);

  test("identity and lifecycle", () => {
    expect(e.provider).toBe("simplotel");
    expect(e.externalBookingId).toBe("SKQVHO");
    expect(e.eventType).toBe("BOOKING_CREATED");
    expect(e.status).toBe("CONFIRMED");
    // Simplotel's own property id, for a multi-property account.
    expect(e.externalAccountId).toBe("8642");
    expect(e.bookingChannel).toBe("direct_web");
  });

  test("dates and stay", () => {
    expect(e.checkIn).toBe("2026-09-28");
    expect(e.checkOut).toBe("2026-09-29");
    expect(e.bookedAt).toBe("2026-09-21");
  });

  test("money, including tax split out of the rooms", () => {
    expect(e.amounts?.gross).toBe("9086.0000");
    expect(e.amounts?.roomRevenue).toBe("7700.0000");
    expect(e.amounts?.tax).toBe("1386.0000");
    expect(e.amounts?.net).toBe("7700.0000");
    expect(e.amounts?.refunded).toBe("0.0000");
    // gross = net + tax, which is the check a reader will do by eye.
    expect(Number(e.amounts?.net) + Number(e.amounts?.tax)).toBeCloseTo(Number(e.amounts?.gross), 2);
  });

  test("NO journey identifier is claimed, because none is sent", () => {
    // The payload carries no _ht_j, session, visitor, click id or UTM. A
    // Simplotel booking can never be tied deterministically to a visit;
    // matching falls back to the email and phone hashes.
    expect(e.journey).toBeUndefined();
    expect(JSON.stringify(PAYLOAD)).not.toMatch(/_ht_j|session|visitor|gclid|fbclid|utm_/i);
  });

  test("currency stays UNKNOWN rather than being assumed", () => {
    // Amounts arrive as bare strings. Inventing INR is what lets incompatible
    // amounts be summed silently.
    expect(e.currency).toBeNull();
  });

  test("the whole body is kept for audit", () => {
    expect((e.rawPayload as { booking_id: string }).booking_id).toBe("SKQVHO");
  });

  test("it survives the shared validator", () => {
    const v = validateBookingEvent(e);
    expect(v.ok, v.ok ? "" : v.errors.join("; ")).toBe(true);
    if (v.ok) {
      expect(v.event.externalBookingId).toBe("SKQVHO");
      expect(v.event.currency).toBeNull();
      expect(v.event.journeySessionId).toBeNull();
      expect(v.event.amounts.gross).toBe("9086.00");
    }
  });
});

describe("2. lifecycle is read from every field that carries it", () => {
  test("a cancellation timestamp cancels, even if the status still says confirmed", () => {
    const e = first({ ...PAYLOAD, cancellation_datetime: "2026-09-22T10:00:00Z" });
    expect(e.eventType).toBe("BOOKING_CANCELLED");
    expect(e.status).toBe("CANCELLED");
    expect(e.occurredAt).toBe("2026-09-22T10:00:00Z");
  });

  test("every room cancelled cancels the booking", () => {
    const e = first({
      ...PAYLOAD,
      rooms: [{ ...PAYLOAD.rooms[0], is_cancelled: true }],
    });
    expect(e.eventType).toBe("BOOKING_CANCELLED");
  });

  test("a refund is a refund, not just a cancellation", () => {
    const e = first({
      ...PAYLOAD,
      booking_status: "CANCELLED",
      rooms: [{ ...PAYLOAD.rooms[0], is_cancelled: true, refund_amount: "9086.0000" }],
    });
    expect(e.eventType).toBe("BOOKING_REFUNDED");
    expect(e.amounts?.refunded).toBe("9086.0000");
  });

  test("an unknown status is REFUSED and named, never guessed", () => {
    // The body is then held with the unknown value in the reason, which is how
    // we learn Simplotel's vocabulary instead of inventing it.
    const r = parse({ ...PAYLOAD, booking_status: "ON_HOLD" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ON_HOLD/);
  });
});

describe("3. a body it cannot file is refused, not half-mapped", () => {
  test("no booking_id", () => {
    const r = parse({ ...PAYLOAD, booking_id: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/booking_id/);
  });

  test("not JSON, or not an object", () => {
    expect(simplotelAdapter.parseWebhook!("not json", new Headers()).ok).toBe(false);
    expect(parse([PAYLOAD]).ok).toBe(false);
  });

  test("a missing amount stays missing rather than becoming zero", () => {
    const e = first({ ...PAYLOAD, total_amount: undefined, rooms: [] });
    expect(e.amounts?.gross).toBeNull();
    expect(e.amounts?.tax).toBeNull();
    expect(e.amounts?.roomRevenue).toBeNull();
  });
});
