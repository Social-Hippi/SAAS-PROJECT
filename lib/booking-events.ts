// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL BOOKING EVENT (Phase 1B ingestion contract).
//
// The single internal shape every booking provider — PMS, booking engine, OTA,
// channel manager — is normalized into by its adapter. Everything downstream
// (the ingestion service, lifecycle, identity matching, and eventually
// attribution) speaks only this language and knows nothing about any vendor.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE
//
// 1. A provider may not know a value. Only eventType / provider /
//    externalBookingId / occurredAt are required. Everything else is optional
//    and stays NULL when unsupplied — never defaulted, never zero-filled, and
//    never assumed (currency in particular is NOT assumed to be INR).
//
// 2. Raw provider payloads are UNTRUSTED INPUT. Every field is validated here
//    before it can reach the database, and validation NEVER throws — a bad
//    event is reported, not crashed on, so one malformed record can't take down
//    a batch.
//
// PURE: no DB, no session, no "server-only" — the adapters, the ingest service
// and the tests all share this one implementation.
// ─────────────────────────────────────────────────────────────────────────────

/** Lifecycle transitions a provider can report. */
export const BOOKING_EVENT_TYPES = [
  "BOOKING_CREATED",
  "BOOKING_UPDATED",
  "BOOKING_CANCELLED",
  "BOOKING_REFUNDED",
  "BOOKING_COMPLETED",
] as const;
export type BookingEventType = (typeof BOOKING_EVENT_TYPES)[number];

/** Mirrors the BookingStatus enum (string union so this module needs no Prisma). */
export const BOOKING_STATUSES = ["CONFIRMED", "MODIFIED", "CANCELLED", "REFUNDED", "COMPLETED"] as const;
export type BookingStatusValue = (typeof BOOKING_STATUSES)[number];

/**
 * The status each event type implies when the provider doesn't state one
 * explicitly. BOOKING_UPDATED maps to MODIFIED: an update that changes nothing
 * material simply produces no new lifecycle row (see the ingest service).
 */
const STATUS_FOR_EVENT: Record<BookingEventType, BookingStatusValue> = {
  BOOKING_CREATED: "CONFIRMED",
  BOOKING_UPDATED: "MODIFIED",
  BOOKING_CANCELLED: "CANCELLED",
  BOOKING_REFUNDED: "REFUNDED",
  BOOKING_COMPLETED: "COMPLETED",
};

/** Money the provider reported. Every field optional; absent stays absent. */
export type CanonicalAmounts = {
  gross?: unknown;
  net?: unknown;
  roomRevenue?: unknown;
  ancillaryRevenue?: unknown;
  tax?: unknown;
  refunded?: unknown;
};

/**
 * Guest identity as the provider supplies it. `email`/`phone` are RAW here and
 * are hashed the moment they cross into the ingestion service — they are never
 * persisted, logged, or returned. This type is the only place raw PII is even
 * representable, and it is deliberately not part of the validated output.
 */
export type CanonicalGuest = {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  externalGuestId?: unknown;
};

/** What an adapter produces. Loose types: this is untrusted, pre-validation. */
export type CanonicalBookingEvent = {
  eventType: unknown;
  provider: unknown;
  externalBookingId: unknown;
  occurredAt: unknown;
  externalAccountId?: unknown;
  status?: unknown;
  bookingChannel?: unknown;
  currency?: unknown;
  bookedAt?: unknown;
  checkIn?: unknown;
  checkOut?: unknown;
  guest?: CanonicalGuest;
  amounts?: CanonicalAmounts;
  rawPayload?: unknown;
};

/** What the ingestion service is allowed to persist. Everything is normalized. */
export type ValidatedBookingEvent = {
  eventType: BookingEventType;
  provider: string;
  externalBookingId: string;
  occurredAt: Date;
  externalAccountId: string | null;
  status: BookingStatusValue;
  bookingChannel: string | null;
  /** ISO-4217 uppercase, or NULL for UNKNOWN. Never defaulted. */
  currency: string | null;
  bookedAt: Date | null;
  checkIn: Date | null;
  checkOut: Date | null;
  guestName: string | null;
  /** Raw values, carried only as far as the ingest service, which hashes them. */
  guestEmailRaw: string | null;
  guestPhoneRaw: string | null;
  externalGuestId: string | null;
  amounts: {
    gross: string | null;
    net: string | null;
    roomRevenue: string | null;
    ancillaryRevenue: string | null;
    tax: string | null;
    refunded: string | null;
  };
  rawPayload: unknown;
  /** Non-fatal notes, e.g. a dropped malformed currency. Never contains PII. */
  warnings: string[];
};

export type ValidationResult =
  | { ok: true; event: ValidatedBookingEvent }
  | { ok: false; errors: string[] };

// ── Field normalizers ────────────────────────────────────────────────────────

/** Bounded, control-char-free string, or null. Mirrors the tracking ingest's str(). */
function cleanString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const cleaned = Array.from(v)
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
    .join("")
    .trim()
    .slice(0, max);
  return cleaned.length ? cleaned : null;
}

/** Provider keys are lower-case slugs so "Cloudbeds" and "cloudbeds" are one provider. */
export function normalizeProvider(v: unknown): string | null {
  const s = cleanString(v, 64);
  if (!s) return null;
  const slug = s.toLowerCase();
  return /^[a-z0-9][a-z0-9._-]*$/.test(slug) ? slug : null;
}

/**
 * ISO-4217 or NULL. A malformed code is DROPPED rather than guessed — an
 * unknown currency is a legitimate state, and inventing one would let
 * incompatible amounts be silently summed (the Phase 0 failure mode).
 */
export function normalizeCurrency(v: unknown): string | null {
  const s = cleanString(v, 8);
  if (!s) return null;
  const up = s.toUpperCase();
  return /^[A-Z]{3}$/.test(up) ? up : null;
}

/** Widest value Booking's Decimal(12,2) columns can hold. */
export const MAX_BOOKING_AMOUNT = 9_999_999_999.99;

/**
 * Money → a fixed-2dp string, or null.
 *
 * Rejects (→ null, never 0): non-numeric, NaN/Infinity, negative, and anything
 * exceeding the column width. An over-width amount is DROPPED rather than
 * truncated — a silently truncated price is worse than a missing one.
 */
export function normalizeAmount(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[\s,]/g, "")) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > MAX_BOOKING_AMOUNT) return null;
  return n.toFixed(2);
}

/** A plausible timestamp, or null. Guards against epoch-0 and year-3000 junk. */
export function normalizeDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) && plausible(v) ? v : null;
  if (typeof v === "number") {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) && plausible(d) ? d : null;
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!Number.isFinite(t)) return null;
    const d = new Date(t);
    return plausible(d) ? d : null;
  }
  return null;
}

/** Bookings are not from 1970, and check-outs are not in 2200. */
function plausible(d: Date): boolean {
  const y = d.getUTCFullYear();
  return y >= 2000 && y <= 2100;
}

export function isBookingEventType(v: unknown): v is BookingEventType {
  return typeof v === "string" && (BOOKING_EVENT_TYPES as readonly string[]).includes(v);
}
export function isBookingStatus(v: unknown): v is BookingStatusValue {
  return typeof v === "string" && (BOOKING_STATUSES as readonly string[]).includes(v);
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate + normalize one adapter-produced event. NEVER throws: a bad event
 * comes back as `{ ok: false, errors }` so a batch can skip it and continue.
 *
 * Note what is NOT validated here: hotelClientId and agencyId. Those are never
 * read from a provider payload — the ingestion service takes them from the
 * trusted BookingConnection. See lib/booking-ingest.ts.
 */
export function validateBookingEvent(input: CanonicalBookingEvent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const eventType = isBookingEventType(input.eventType) ? input.eventType : null;
  if (!eventType) errors.push(`eventType must be one of ${BOOKING_EVENT_TYPES.join("|")}`);

  const provider = normalizeProvider(input.provider);
  if (!provider) errors.push("provider is required and must be a slug like 'cloudbeds'");

  const externalBookingId = cleanString(input.externalBookingId, 128);
  if (!externalBookingId) errors.push("externalBookingId is required");

  const occurredAt = normalizeDate(input.occurredAt);
  if (!occurredAt) errors.push("occurredAt is required and must be a plausible date");

  if (errors.length) return { ok: false, errors };

  // An explicit status wins; otherwise it is implied by the event type.
  let status: BookingStatusValue;
  if (input.status === undefined || input.status === null) {
    status = STATUS_FOR_EVENT[eventType!];
  } else if (isBookingStatus(input.status)) {
    status = input.status;
  } else {
    status = STATUS_FOR_EVENT[eventType!];
    warnings.push("unrecognised status; derived from eventType instead");
  }

  const currency = normalizeCurrency(input.currency);
  if (input.currency != null && currency === null) {
    warnings.push("currency was not a valid ISO-4217 code and was dropped (stored as unknown)");
  }

  const checkIn = normalizeDate(input.checkIn);
  const checkOut = normalizeDate(input.checkOut);
  if (checkIn && checkOut && checkOut < checkIn) {
    // Keep both — a provider's own inconsistency is not ours to silently "fix" —
    // but flag it so a later stay-length calculation doesn't trust the pair.
    warnings.push("checkOut precedes checkIn");
  }

  const a = input.amounts ?? {};
  const amounts = {
    gross: normalizeAmount(a.gross),
    net: normalizeAmount(a.net),
    roomRevenue: normalizeAmount(a.roomRevenue),
    ancillaryRevenue: normalizeAmount(a.ancillaryRevenue),
    tax: normalizeAmount(a.tax),
    refunded: normalizeAmount(a.refunded),
  };
  for (const [k, v] of Object.entries(a)) {
    if (v != null && v !== "" && amounts[k as keyof typeof amounts] === null) {
      warnings.push(`amount '${k}' was not a usable non-negative number and was dropped`);
    }
  }

  const g = input.guest ?? {};
  return {
    ok: true,
    event: {
      eventType: eventType!,
      provider: provider!,
      externalBookingId: externalBookingId!,
      occurredAt: occurredAt!,
      externalAccountId: cleanString(input.externalAccountId, 128),
      status,
      bookingChannel: cleanString(input.bookingChannel, 64),
      currency,
      bookedAt: normalizeDate(input.bookedAt),
      checkIn,
      checkOut,
      guestName: cleanString(g.name, 200),
      guestEmailRaw: cleanString(g.email, 320),
      guestPhoneRaw: cleanString(g.phone, 64),
      externalGuestId: cleanString(g.externalGuestId, 128),
      amounts,
      rawPayload: input.rawPayload ?? null,
      warnings,
    },
  };
}
