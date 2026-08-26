import type { CanonicalBookingEvent } from "@/lib/booking-events";
import type { AdapterResult, BookingProviderAdapter } from "@/lib/booking-provider";
import { registerBookingProvider } from "@/lib/booking-provider";

// ─────────────────────────────────────────────────────────────────────────────
// Simplotel — Booking Push adapter.
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │  SIMPLOTEL PAYLOAD SAMPLE REQUIRED                                        │
// │                                                                           │
// │  Simplotel has confirmed Booking Push exists and asked us for the URL,    │
// │  method, headers and payload mapping. We have NOT yet received a sample   │
// │  payload or field documentation.                                          │
// │                                                                           │
// │  `parseWebhook` therefore refuses every body. It is NOT a stub that       │
// │  guesses at `booking_id` / `reservation_id` / `total_amount` and quietly  │
// │  half-works: a mapping invented from plausible names would produce        │
// │  confident, wrong bookings and wrong revenue. Refusing is the honest      │
// │  behaviour until the contract is known, and the receiver surfaces it as   │
// │  422 with a clear reason.                                                 │
// │                                                                           │
// │  Everything AROUND the mapping — transport, authentication, tenant        │
// │  resolution, idempotency, lifecycle, journey matching — is complete and   │
// │  tested. Only these ~20 lines wait on Simplotel.                          │
// └───────────────────────────────────────────────────────────────────────────┘
//
// WHAT WE NEED (see the message prepared for Simplotel):
//   • sample JSON for create / modify / cancel / refund
//   • the reservation identifier field      -> externalBookingId
//   • booking status values                 -> BookingStatus
//   • amount fields + what each represents  -> gross / net / tax / discount
//   • currency field                        -> ISO-4217
//   • customer identifier fields            -> customerId / email / phone
//   • check-in / check-out fields
//   • whether our journey parameter survives to the booking (see below)
//   • retry behaviour, expected response status, timeout
//
// JOURNEY LINKAGE — the field that makes attribution deterministic.
// HotelTrack's snippet carries `_ht_j` to the booking engine. If Simplotel can
// echo back either the raw `_ht_j` value or the session/visitor ids it decodes
// to, a booking joins to the exact visit that produced it. Without it we fall
// back to email/phone hashes (STRONG at best, PARTIAL when shared) and, failing
// those, UNKNOWN — which is recorded honestly rather than guessed.

export const SIMPLOTEL_PROVIDER = "simplotel";

/** Thrown-free marker so the receiver can distinguish "no contract yet". */
export const PAYLOAD_CONTRACT_PENDING =
  "SIMPLOTEL PAYLOAD SAMPLE REQUIRED — no field mapping has been agreed, so this " +
  "body cannot be translated into a booking. No booking was created.";

export const simplotelAdapter: BookingProviderAdapter = {
  provider: SIMPLOTEL_PROVIDER,
  displayName: "Simplotel",

  capabilities: {
    // Booking Push is provider -> us. Confirmed available by Simplotel.
    webhook: true,
    // No polling API is known to exist; do not advertise one we cannot call.
    polling: false,
  },

  /**
   * There is no Simplotel API for us to call — Booking Push is one-way, into
   * HotelTrack. A connection is therefore "valid" once a shared secret exists;
   * the real proof is the first authenticated push arriving.
   */
  async validateConnection(): Promise<AdapterResult<{ externalAccountId?: string | null }>> {
    return { ok: true, value: { externalAccountId: null } };
  },

  /**
   * Signature verification is intentionally absent: Simplotel has not published
   * a signing scheme. Authentication is a bearer secret checked by the receiver
   * in constant time BEFORE any body is read. If Simplotel later offers HMAC
   * signing, implement it here and the receiver will prefer it.
   */

  parseWebhook(): AdapterResult<CanonicalBookingEvent[]> {
    return { ok: false, error: PAYLOAD_CONTRACT_PENDING };
  },
};

registerBookingProvider(simplotelAdapter);
