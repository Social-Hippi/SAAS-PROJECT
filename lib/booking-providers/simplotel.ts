import type { CanonicalBookingEvent } from "@/lib/booking-events";
import type { AdapterResult, BookingProviderAdapter } from "@/lib/booking-provider";
import { registerBookingProvider } from "@/lib/booking-provider";

// ─────────────────────────────────────────────────────────────────────────────
// Simplotel — Booking Push adapter.
//
// Written from Simplotel's REAL payloads, held by the receiver on 19 and 21 Sep
// 2026, not from a spec. Every field below was present in those bodies.
//
// TWO THINGS THE PAYLOAD DOES NOT CARRY, and both change what the product can
// claim:
//
//   NO JOURNEY IDENTIFIER. There is no `_ht_j`, no session id, no visitor id,
//   no click id, no UTM. So a Simplotel booking can NEVER be tied deterministic-
//   ally to the visit that produced it. Matching falls back to the guest's email
//   and phone hashes — strong when they are present and unique, and UNKNOWN when
//   they are not. `journey` is therefore absent here, never inferred.
//
//   NO CURRENCY. Amounts arrive as bare strings ("9086.0000"). Currency is left
//   NULL rather than assumed to be rupees: Booking.currency's contract is that
//   NULL means unknown, and inventing one is what lets incompatible amounts be
//   summed silently. Ask Simplotel to add it.
//
// DATE-ONLY FIELDS. `booking_date`, `checkin_date` and `checkout_date` carry no
// time and no zone. They are read as that calendar day at UTC midnight, which
// lands on the same day for any property east of UTC — true of every property
// on this system today. A property west of UTC would need the day resolved in
// its own timezone, which the adapter interface cannot see; revisit then.
// ─────────────────────────────────────────────────────────────────────────────

export const SIMPLOTEL_PROVIDER = "simplotel";

/** Kept so older held pushes still explain themselves after a replay. */
export const PAYLOAD_CONTRACT_PENDING =
  "SIMPLOTEL PAYLOAD SAMPLE REQUIRED — no field mapping has been agreed, so this " +
  "body cannot be translated into a booking. No booking was created.";

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
};

/** A money string as the provider sent it ("9086.0000"), or null. */
const money = (v: unknown): string | null => {
  const s = str(v);
  if (s == null) return null;
  return /^-?\d+(\.\d+)?$/.test(s.replace(/,/g, "")) ? s.replace(/,/g, "") : null;
};

/** Sums money-ish fields across rooms, returning a string or null when none had one. */
function sumMoney(rooms: Json[], key: string): string | null {
  let total = 0;
  let seen = false;
  for (const r of rooms) {
    const m = money(r[key]);
    if (m == null) continue;
    seen = true;
    total += Number(m);
  }
  return seen ? total.toFixed(4) : null;
}

const rowsOf = (v: unknown): Json[] =>
  Array.isArray(v) ? v.filter((r): r is Json => !!r && typeof r === "object") : [];

/**
 * Simplotel's lifecycle, read from the fields it actually sends.
 *
 * `booking_status` is the provider's own word. A cancellation also shows in
 * `cancellation_datetime` and in each room's `is_cancelled`, so those are read
 * too rather than trusting one field. An unrecognised status is REFUSED, not
 * guessed: the body is then held with the unknown value named, which is how we
 * learn Simplotel's vocabulary instead of inventing it.
 */
function lifecycle(body: Json, rooms: Json[]): { eventType: string; status: string } | string {
  const raw = (str(body.booking_status) ?? "").toUpperCase();
  const cancelledAt = str(body.cancellation_datetime);
  const allRoomsCancelled = rooms.length > 0 && rooms.every((r) => r.is_cancelled === true);
  const refunded = Number(sumMoney(rooms, "refund_amount") ?? "0") > 0;

  if (raw === "CANCELLED" || raw === "CANCELED" || cancelledAt != null || allRoomsCancelled) {
    return refunded
      ? { eventType: "BOOKING_REFUNDED", status: "REFUNDED" }
      : { eventType: "BOOKING_CANCELLED", status: "CANCELLED" };
  }
  if (raw === "CONFIRMED" || raw === "CONFIRM") {
    return { eventType: "BOOKING_CREATED", status: "CONFIRMED" };
  }
  if (raw === "MODIFIED" || raw === "AMENDED" || raw === "UPDATED") {
    return { eventType: "BOOKING_UPDATED", status: "MODIFIED" };
  }
  if (raw === "COMPLETED" || raw === "CHECKED_OUT") {
    return { eventType: "BOOKING_COMPLETED", status: "COMPLETED" };
  }
  return raw
    ? `Unrecognised booking_status "${raw}". No booking was created; the push is held so the mapping can be extended.`
    : "No booking_status in the payload. No booking was created; the push is held.";
}

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
   * in constant time BEFORE any body is read.
   */

  parseWebhook(rawBody: string): AdapterResult<CanonicalBookingEvent[]> {
    let body: Json;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "Expected a JSON object describing one booking." };
      }
      body = parsed as Json;
    } catch {
      return { ok: false, error: "Body is not valid JSON." };
    }

    const bookingId = str(body.booking_id);
    if (!bookingId) {
      return {
        ok: false,
        error: "No booking_id in the payload, so this cannot be filed as a booking.",
      };
    }

    const rooms = rowsOf(body.rooms);
    const life = lifecycle(body, rooms);
    if (typeof life === "string") return { ok: false, error: life };

    // Taxes and ancillaries live on the rooms; the top level carries the total.
    const roomRevenue = sumMoney(rooms, "total_amount_before_taxes");
    const roomTax = sumMoney(rooms, "total_taxes");
    const addonTax = sumMoney(rooms, "total_addon_taxes");
    const ancillary = sumMoney(rooms, "total_addon_amount_before_taxes");
    const tax =
      roomTax == null && addonTax == null
        ? null
        : (Number(roomTax ?? 0) + Number(addonTax ?? 0)).toFixed(4);
    const net =
      roomRevenue == null && ancillary == null
        ? null
        : (Number(roomRevenue ?? 0) + Number(ancillary ?? 0)).toFixed(4);

    const guest = {
      name: str(body.name),
      email: str(body.email),
      phone: str(body.phone),
    };

    const event: CanonicalBookingEvent = {
      eventType: life.eventType,
      provider: SIMPLOTEL_PROVIDER,
      externalBookingId: bookingId,
      // When it happened, as best the payload says: a cancellation carries a
      // timestamp; a create carries only a date, so the push's own arrival is
      // the more precise answer for ordering lifecycle rows.
      occurredAt: str(body.cancellation_datetime) ?? new Date().toISOString(),
      // Simplotel's own property id ("8642"), which is how a multi-property
      // account distinguishes its hotels.
      externalAccountId: str(body.hotel_id),
      status: life.status,
      // The hotel's own booking engine: a booking made on their website.
      bookingChannel: "direct_web",
      // Absent from the payload. NULL means unknown; never assumed (see above).
      currency: null,
      bookedAt: str(body.booking_date),
      checkIn: str(body.checkin_date),
      checkOut: str(body.checkout_date),
      guest,
      // No journey identifier is sent, so none is claimed. Matching falls back
      // to the email and phone hashes.
      amounts: {
        gross: money(body.total_amount),
        net,
        roomRevenue,
        ancillaryRevenue: ancillary,
        tax,
        refunded: sumMoney(rooms, "refund_amount"),
      },
      rawPayload: body,
    };

    return { ok: true, value: [event] };
  },
};

registerBookingProvider(simplotelAdapter);
