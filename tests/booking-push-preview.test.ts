import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import { maskPayload } from "@/lib/booking-push-preview";

// ─────────────────────────────────────────────────────────────────────────────
// Reading a held Booking Push body to write a parser from it.
//
// The held body is the provider's REAL booking — the sample we asked Simplotel
// for since August. Mapping it needs the field names, shapes and formats. It
// does not need the guest, so guest data is masked by VALUE, leaving every key,
// type and format in place.
// ─────────────────────────────────────────────────────────────────────────────

const PREVIEW = readCode("lib/booking-push-preview.ts");
const PANEL = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/HeldPushPanel.tsx");
const PAGE = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/page.tsx");

const payload = {
  reservation_id: "SJZL3B",
  status: "CONFIRMED",
  guest: { name: "Priya Sharma", email: "priya@example.com", phone: "+91 98765 43210" },
  check_in: "2026-10-02",
  total_amount: "12450.00",
  currency: "INR",
  _ht_j: "eyJzIjoic2Vzc181NmRlMzU3OS01OGVm",
  journey_session_id: "sess_56de3579-58ef-44f3",
  rooms: [{ room_type: "Deluxe", nights: 2, rate: 6225 }],
};

describe("1. the structure survives; the guest does not", () => {
  const masked = maskPayload(payload) as Record<string, unknown>;
  const guest = masked.guest as Record<string, string>;

  test("every key stays, in place", () => {
    expect(Object.keys(masked)).toEqual(Object.keys(payload));
    expect(Object.keys(guest)).toEqual(["name", "email", "phone"]);
  });

  test("name, email and phone are masked", () => {
    expect(guest.name).not.toContain("Priya");
    expect(guest.email).not.toContain("priya");
    expect(guest.phone).not.toContain("98765");
  });

  test("an email still looks like an email, so the format is readable", () => {
    expect(guest.email).toMatch(/^•+@•+\.com$/);
  });

  test("what a parser needs is untouched", () => {
    // Booking reference, status, dates, amounts, currency, nested numbers.
    expect(masked.reservation_id).toBe("SJZL3B");
    expect(masked.status).toBe("CONFIRMED");
    expect(masked.check_in).toBe("2026-10-02");
    expect(masked.total_amount).toBe("12450.00");
    expect(masked.currency).toBe("INR");
    expect((masked.rooms as { rate: number }[])[0].rate).toBe(6225);
  });

  test("OUR journey identifiers are never masked", () => {
    // Whether the provider echoes these back is the single most valuable thing
    // in the payload: it is what makes a booking traceable to a visit.
    expect(masked._ht_j).toBe(payload._ht_j);
    expect(masked.journey_session_id).toBe(payload.journey_session_id);
  });
});

describe("2. masking catches guest data wherever it hides", () => {
  test("a phone number in an unexpected field is still masked", () => {
    const m = maskPayload({ note: "call back on 9876543210" }) as Record<string, string>;
    expect(m.note).not.toContain("9876543210");
  });

  test("a sensitive key is masked even when the value looks harmless", () => {
    const m = maskPayload({ guest_name: "Ann" }) as Record<string, string>;
    expect(m.guest_name).not.toBe("Ann");
  });

  test("arrays and nesting are followed", () => {
    const m = maskPayload({ guests: [{ email: "a@b.com" }, { email: "c@d.com" }] }) as {
      guests: { email: string }[];
    };
    expect(m.guests).toHaveLength(2);
    for (const g of m.guests) expect(g.email).not.toContain("@b.com".slice(1, 2));
    expect(m.guests[0].email).toMatch(/^•+@•+\.com$/);
  });

  test("dates and timestamps survive — a parser lives on them", () => {
    // This caught a real bug: "2026-10-02" is digits with separators, and the
    // phone rule masked every check-in date.
    const m = maskPayload({
      check_in: "2026-10-02",
      checked_out_at: "2026-10-04T11:30:00Z",
      booked_on: "02/10/2026",
      amount: "12450.00",
    }) as Record<string, string>;
    expect(m.check_in).toBe("2026-10-02");
    expect(m.checked_out_at).toBe("2026-10-04T11:30:00Z");
    expect(m.booked_on).toBe("02/10/2026");
    expect(m.amount).toBe("12450.00");
  });

  test("an amount is never mistaken for a phone number", () => {
    // "12450.00" is seven digits around a dot; allowing "." as a phone separator
    // masked the booking amount — the field the mapping exists to read.
    const m = maskPayload({
      total: "12450.00",
      tax: "1,245.50",
      big: "1234567.89",
      room_rate: "6225",
      phone_plain: "9876543210",
    }) as Record<string, string>;
    expect(m.total).toBe("12450.00");
    expect(m.tax).toBe("1,245.50");
    expect(m.room_rate).toBe("6225");
    // …while a real 10-digit number is still masked.
    expect(m.phone_plain).not.toContain("9876543210");
    // A seven-digit unbroken run is masked even inside a decimal.
    expect(m.big).not.toBe("1234567.89");
  });

  test("numbers, booleans and nulls pass through untouched", () => {
    expect(maskPayload({ n: 1234, ok: true, none: null })).toEqual({ n: 1234, ok: true, none: null });
  });
});

describe("3. who may read a held body", () => {
  test("admins only, and only the one push asked for", () => {
    expect(PAGE).toMatch(/const canReadHeld = member\.role === "admin" && heldPushCount > 0;/);
    expect(PAGE).toMatch(/canReadHeld && openHeldId \? await readHeldPush\(/);
    // The list is metadata; bodies are not loaded with it.
    expect(PREVIEW).toMatch(/select: \{[\s\S]{0,200}bodyBytes: true/);
    const list = PREVIEW.slice(PREVIEW.indexOf("export async function listHeldPushes"));
    expect(list.slice(0, list.indexOf("\n}\n"))).not.toMatch(/bodyEncrypted/);
  });

  test("reads are agency-scoped and hotel-scoped", () => {
    expect(PREVIEW).toMatch(/agencyScopedFor\(agencyId, prisma\.bookingPushCapture\)\.findMany/);
    expect(PREVIEW).toMatch(/agencyScopedFor\(agencyId, prisma\.bookingPushCapture\)\.findFirst/);
    expect(PREVIEW).toMatch(/where: \{ id, hotelClientId \}/);
  });

  test("a body that cannot be decrypted or parsed is never printed raw", () => {
    expect(PREVIEW).toMatch(/could not be decrypted/);
    expect(PREVIEW).toMatch(/not valid JSON/);
    const read = PREVIEW.slice(PREVIEW.indexOf("export async function readHeldPush"));
    expect(read).not.toMatch(/masked: raw/);
  });

  test("the panel says plainly what is masked and what is not", () => {
    const text = PANEL.replace(/\s+/g, " ");
    expect(text).toMatch(/are masked/);
    expect(text).toMatch(/journey identifiers are not/);
  });
});
