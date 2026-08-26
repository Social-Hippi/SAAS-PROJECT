import "server-only";

import { prisma } from "@/lib/prisma";
import { hashGuestEmail, hashGuestPhone } from "@/lib/booking-identity";
import { matchBookingToJourney } from "@/lib/booking-match";
import {
  validateBookingEvent,
  type CanonicalBookingEvent,
  type ValidatedBookingEvent,
} from "@/lib/booking-events";

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING INGESTION SERVICE.
//
// The one place a Booking is ever written. Transport-agnostic: a webhook route
// and a polling cron both arrive here with the same CanonicalBookingEvent, so
// idempotency, lifecycle and matching behave identically either way.
//
// THE TENANT RULE. agencyId and hotelClientId come EXCLUSIVELY from the trusted
// BookingConnection row that the caller already resolved and authenticated.
// They are never read from a provider payload, and an event whose `provider`
// disagrees with the connection is rejected outright — otherwise a compromised
// or careless provider could write bookings into another hotel's account.
//
// Never throws: every failure is a returned result so one bad record cannot
// abort a batch (the convention the Meta / Google Ads syncs already follow).
// ─────────────────────────────────────────────────────────────────────────────

/** The trusted, already-authenticated connection this event arrived on. */
export type TrustedBookingConnection = {
  id: string;
  agencyId: string;
  hotelClientId: string;
  provider: string;
};

export type IngestResult =
  | {
      ok: true;
      bookingId: string;
      /** Whether this call created the booking or updated an existing one. */
      created: boolean;
      /** Whether a lifecycle row was appended (false when nothing material changed). */
      statusEventAppended: boolean;
      match: { method: string; confidence: string; created: number } | null;
      warnings: string[];
    }
  | { ok: false; errors: string[] };

export type IngestOptions = {
  /** Skip identity matching (used by bulk backfills that match afterwards). */
  skipMatching?: boolean;
};

/**
 * Ingest ONE canonical event.
 *
 * Order matters: validate → tenant check → upsert the FACT → append HISTORY →
 * derive EVIDENCE. Matching runs last and its failure never invalidates the
 * booking, because the booking is a fact whether or not we can explain it.
 */
export async function ingestBookingEvent(
  connection: TrustedBookingConnection,
  input: CanonicalBookingEvent,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const validation = validateBookingEvent(input);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const event = validation.event;

  // The provider on the event must be the provider this connection is for.
  if (event.provider !== connection.provider) {
    return {
      ok: false,
      errors: [
        `event provider '${event.provider}' does not match connection provider '${connection.provider}'`,
      ],
    };
  }

  // Raw guest PII is hashed HERE and the raw values are dropped on the floor.
  // Nothing below this line can persist, log, or return them.
  const guestEmailHash = hashGuestEmail(event.guestEmailRaw);
  const guestPhoneHash = hashGuestPhone(event.guestPhoneRaw);

  const existing = await prisma.booking.findUnique({
    where: {
      hotelClientId_provider_externalBookingId: {
        hotelClientId: connection.hotelClientId,
        provider: event.provider,
        externalBookingId: event.externalBookingId,
      },
    },
    select: { id: true, status: true, grossAmount: true, netAmount: true, refundedAmount: true },
  });

  const supplied = presentFields(event, guestEmailHash, guestPhoneHash);

  let bookingId: string;
  let created: boolean;

  if (existing) {
    // IDEMPOTENT UPDATE. Only fields the provider actually supplied are written:
    // a later event that omits a value must not null out what an earlier one
    // established (the same add-only rule the click-identifier merge uses).
    await prisma.booking.update({
      where: { id: existing.id },
      data: { ...supplied, status: event.status as never, connectionId: connection.id },
    });
    bookingId = existing.id;
    created = false;
  } else {
    const row = await prisma.booking.create({
      data: {
        agencyId: connection.agencyId,
        hotelClientId: connection.hotelClientId,
        connectionId: connection.id,
        provider: event.provider,
        externalBookingId: event.externalBookingId,
        status: event.status as never,
        // bookedAt is required by the schema; fall back to the event time when
        // the provider doesn't state when the booking was actually made.
        bookedAt: event.bookedAt ?? event.occurredAt,
        ...supplied,
      },
      select: { id: true },
    });
    bookingId = row.id;
    created = true;
  }

  // ── Lifecycle history ──────────────────────────────────────────────────
  // Append when the booking is new, when the lifecycle state changed, or when
  // the provider restated any money. An update that changes nothing material
  // appends nothing, so the history stays a record of real events rather than
  // a log of redeliveries. Existing rows are NEVER modified.
  const statusChanged = !existing || existing.status !== event.status;
  const restatesMoney =
    event.amounts.gross !== null || event.amounts.net !== null || event.amounts.refunded !== null;

  let statusEventAppended = false;
  if (statusChanged || restatesMoney) {
    await prisma.bookingStatusEvent.create({
      data: {
        agencyId: connection.agencyId,
        bookingId,
        status: event.status as never,
        grossAmount: event.amounts.gross,
        netAmount: event.amounts.net,
        refundedAmount: event.amounts.refunded,
        currency: event.currency,
        occurredAt: event.occurredAt,
        source: event.provider,
        rawPayload: (event.rawPayload ?? null) as never,
      },
    });
    statusEventAppended = true;
  }

  // ── Evidence ───────────────────────────────────────────────────────────
  // Deterministic matching only, and the result is written to
  // BookingJourneyMatch — never onto the Booking. NOTHING here computes
  // attribution, revenue credit, or ROAS: that is a later phase by design.
  let match: { method: string; confidence: string; created: number } | null = null;
  if (!options.skipMatching) {
    const outcome = await matchBookingToJourney({
      id: bookingId,
      agencyId: connection.agencyId,
      hotelClientId: connection.hotelClientId,
      guestEmailHash,
      guestPhoneHash,
      externalGuestId: event.externalGuestId,
      journeySessionId: event.journeySessionId,
      journeyVisitorId: event.journeyVisitorId,
    });
    match = { method: outcome.method, confidence: outcome.confidence, created: outcome.created };
  }

  return { ok: true, bookingId, created, statusEventAppended, match, warnings: event.warnings };
}

/**
 * Ingest a batch (a webhook carrying several events, or one polling page).
 * A failing record is reported and SKIPPED — it never aborts the rest.
 */
export async function ingestBookingEvents(
  connection: TrustedBookingConnection,
  events: CanonicalBookingEvent[],
  options: IngestOptions = {},
): Promise<{ succeeded: number; failed: number; results: IngestResult[] }> {
  const results: IngestResult[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const e of events) {
    const r = await ingestBookingEvent(connection, e, options);
    results.push(r);
    if (r.ok) succeeded += 1;
    else failed += 1;
  }
  return { succeeded, failed, results };
}

/**
 * The subset of columns this event actually carries. Omitting the nulls is what
 * makes an update add-only, and it is also why an unsupplied amount stays NULL
 * in the database instead of becoming 0.
 */
function presentFields(
  event: ValidatedBookingEvent,
  guestEmailHash: string | null,
  guestPhoneHash: string | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) out[key] = value;
  };

  put("bookingChannel", event.bookingChannel);
  put("currency", event.currency);
  put("bookedAt", event.bookedAt);
  put("checkIn", event.checkIn);
  put("checkOut", event.checkOut);
  put("guestName", event.guestName);
  put("guestEmailHash", guestEmailHash);
  put("guestPhoneHash", guestPhoneHash);
  put("externalGuestId", event.externalGuestId);
  put("journeySessionId", event.journeySessionId);
  put("journeyVisitorId", event.journeyVisitorId);
  put("grossAmount", event.amounts.gross);
  put("netAmount", event.amounts.net);
  put("roomRevenue", event.amounts.roomRevenue);
  put("ancillaryRevenue", event.amounts.ancillaryRevenue);
  put("taxAmount", event.amounts.tax);
  put("refundedAmount", event.amounts.refunded);
  put("rawPayload", event.rawPayload);
  return out;
}
