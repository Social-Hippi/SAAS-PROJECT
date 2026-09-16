import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING CONNECTION SETUP — the half that was missing.
//
// The receiver, tenant resolution from the secret, idempotency, lifecycle
// history and journey matching have all existed for months. What did not exist
// was any way to CREATE the BookingConnection row they depend on, so no hotel
// was ever connected and every booking figure on every report fell back to the
// tracking snippet — which cannot see a booking completed on the booking
// engine's own domain. On Aster Holidays that was 934 visits to the booking
// engines in a month against one detected booking.
//
// What must not regress here is the secret handling: it is minted once, stored
// as ciphertext, and shown exactly once.
// ─────────────────────────────────────────────────────────────────────────────

const ACTIONS = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/booking-actions.ts");
const CARD = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/BookingConnectionCard.tsx");
const PAGE = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/page.tsx");

describe("1. the secret is minted, encrypted, and never stored in the clear", () => {
  test("it comes from a CSPRNG, not Math.random", () => {
    expect(ACTIONS).toMatch(/randomBytes\(32\)/);
    expect(ACTIONS).not.toMatch(/Math\.random/);
  });

  test("it is encrypted before it touches the database", () => {
    expect(ACTIONS).toMatch(/const credentials = encryptToken\(secret\)/);
    // The plaintext must never be the value written to the column.
    expect(ACTIONS).not.toMatch(/credentials:\s*secret\b/);
  });

  test("the plaintext is returned only by the call that minted it", () => {
    // There is no read path: getTokenForApiCall audits every access and no
    // screen can print it again, so "show once" is enforced by storage, not by
    // the UI being careful.
    expect(ACTIONS).toMatch(/return \{ error: null, ok: true, secret \}/);
    expect(ACTIONS).not.toMatch(/getTokenForApiCall/);
  });

  test("the card warns before it is gone", () => {
    expect(CARD).toMatch(/not shown again/i);
    expect(CARD).toMatch(/generate a new one/i);
  });
});

describe("2. tenant isolation", () => {
  test("both actions require an admin and resolve the hotel agency-scoped", () => {
    for (const fn of ["connectBookingProvider", "disconnectBookingProvider"]) {
      const body = ACTIONS.slice(ACTIONS.indexOf(`export async function ${fn}`));
      expect(body.slice(0, 600), fn).toMatch(/requireAdmin\(\)/);
      expect(body.slice(0, 900), fn).toMatch(/ownHotel\(hotelId\)/);
    }
    expect(ACTIONS).toMatch(/agencyScoped\(prisma\.hotelClient\)[\s\S]{0,120}findFirst/);
  });

  test("the row is written under the hotel's OWN agencyId", () => {
    // Never a value from the form: the body must have no say in which tenant is
    // written to.
    expect(ACTIONS).toMatch(/agencyId: hotel\.agencyId/);
    expect(ACTIONS).not.toMatch(/agencyId:\s*(formData|member\.agencyId)/);
  });
});

describe("3. it refuses configurations that cannot work", () => {
  test("a provider with no adapter is rejected at setup, not at push time", () => {
    // Otherwise the row exists, the operator believes they are connected, and
    // every push 404s.
    expect(ACTIONS).toMatch(/if \(!getBookingProvider\(provider\)\)/);
  });

  test("status starts pending — the receiver decides when it is live", () => {
    expect(ACTIONS).toMatch(/status: "pending"/);
  });
});

describe("4. disconnecting keeps the bookings", () => {
  test("only the connection row is deleted", () => {
    // Booking.connectionId is onDelete: SetNull, so reservations survive with
    // their revenue and journey matches. Deleting history to unhook a webhook
    // would destroy the thing the integration exists to build.
    expect(ACTIONS).toMatch(/prisma\.bookingConnection\.deleteMany/);
    expect(ACTIONS).not.toMatch(/prisma\.booking\.deleteMany/);
  });
});

describe("5. the card is reachable and reports honestly", () => {
  test("it renders on the integrations page", () => {
    expect(PAGE).toContain("<BookingConnectionCard");
  });

  test("the badge reflects whether a booking has ARRIVED", () => {
    // A connection configured here but never enabled on the provider's side
    // looks identical to a working one until the first push lands.
    expect(PAGE).toMatch(/bookingConn\.lastBookingReceivedAt \? "green" : "yellow"/);
    expect(CARD).toMatch(/No booking received yet/);
  });

  test("the page never selects the ciphertext column", () => {
    const sel = PAGE.slice(PAGE.indexOf("bookingConnection"), PAGE.indexOf("bookingConnection") + 400);
    expect(sel).not.toMatch(/credentials:\s*true/);
  });
});
