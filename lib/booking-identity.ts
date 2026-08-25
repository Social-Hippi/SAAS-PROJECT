import "server-only";

import { createHash } from "node:crypto";
import { saltedHash } from "@/lib/pii";
import { normalizeEmail, normalizePhone } from "@/lib/pii-client";

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic booking ↔ customer identity (Phase 1B).
//
// A booking source (PMS / booking engine / OTA) supplies a RAW guest email or
// phone. HotelTrack never stores raw PII: VisitorIdentity holds a two-layer hash
//
//     saltedHash( sha256( normalize(raw) ) )
//
// where the inner layer is computed in the visitor's browser (lib/pii-client) and
// the outer salted layer on the server (lib/pii). Both layers are deterministic,
// so the SAME value can be reproduced here from a raw email — which is what makes
// a booking matchable to a known visitor WITHOUT either side ever persisting the
// raw address. The raw value passed in is used to compute a digest and then
// discarded; it is never stored, never logged, and never returned.
//
// DETERMINISTIC ONLY. There is deliberately no fuzzy name matching, no IP
// heuristic, no device fingerprinting, and no "these timestamps are close"
// inference. If the identifiers do not match exactly, there is no match.
// ─────────────────────────────────────────────────────────────────────────────

/** Inner (browser-equivalent) layer: SHA-256 hex of an already-normalized value. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Booking-side email → the exact hash stored on VisitorIdentity.emailHash.
 * Returns null for an empty/unusable value so a blank never becomes a join key
 * that matches every other blank.
 */
export function hashGuestEmail(rawEmail: string | null | undefined): string | null {
  const normalized = normalizeEmail(String(rawEmail ?? ""));
  if (!normalized) return null;
  return saltedHash(sha256Hex(normalized));
}

/** Booking-side phone → the exact hash stored on VisitorIdentity.phoneHash. */
export function hashGuestPhone(rawPhone: string | null | undefined): string | null {
  const normalized = normalizePhone(String(rawPhone ?? ""));
  if (!normalized) return null;
  return saltedHash(sha256Hex(normalized));
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence grading
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors the BookingMatchMethod enum (kept as a string union so this module
 *  stays importable without the Prisma client). */
export type MatchMethod =
  | "booking_id"
  | "customer_id"
  | "email_hash"
  | "phone_hash"
  | "visitor_id"
  | "session_id"
  | "tracking_event"
  | "coupon_code"
  | "manual"
  | "unknown";

/** Mirrors the BookingMatchConfidence enum. */
export type MatchConfidence = "DETERMINISTIC" | "STRONG" | "PARTIAL" | "UNKNOWN";

export const CONFIDENCE_RANK: Record<MatchConfidence, number> = {
  DETERMINISTIC: 3,
  STRONG: 2,
  PARTIAL: 1,
  UNKNOWN: 0,
};

/**
 * Methods that identify an EXACT ROW we already own — the booking source echoed
 * back an id that originated in HotelTrack. Nothing needs to be matched, so the
 * link is a fact rather than an inference.
 */
const EXACT_ROW_METHODS: ReadonlySet<MatchMethod> = new Set([
  "tracking_event",
  "session_id",
  "visitor_id",
  "booking_id",
]);

/**
 * Methods that match a PERSON by a shared identifier. The identity is certain
 * when unique, but "this guest is that visitor" is still a weaker claim than
 * "this booking IS that conversion" — the person may have browsed via one route
 * and booked via a completely unrelated one.
 */
const IDENTITY_METHODS: ReadonlySet<MatchMethod> = new Set([
  "email_hash",
  "phone_hash",
  "customer_id",
  "coupon_code",
]);

export type GradeInput = {
  method: MatchMethod;
  /** How many distinct journey candidates the identifier matched. */
  candidateCount: number;
};

/**
 * Grade the evidence behind one booking↔journey link.
 *
 * The rule that matters: AMBIGUITY IS NEVER PROMOTED. Two visitors sharing a
 * guest email is genuine uncertainty, so it grades PARTIAL and every candidate
 * is recorded — collapsing to "the most recent one" would manufacture certainty
 * that the data does not contain.
 *
 * `manual` is graded PARTIAL, not STRONG: a human asserting a link is a claim,
 * not a deterministic identifier.
 */
export function gradeMatch({ method, candidateCount }: GradeInput): MatchConfidence {
  if (method === "unknown" || candidateCount <= 0) return "UNKNOWN";
  if (method === "manual") return "PARTIAL";
  if (EXACT_ROW_METHODS.has(method)) {
    // An exact row id resolving to more than one row means the id is not the key
    // we thought it was — refuse to call that deterministic.
    return candidateCount === 1 ? "DETERMINISTIC" : "PARTIAL";
  }
  if (IDENTITY_METHODS.has(method)) {
    return candidateCount === 1 ? "STRONG" : "PARTIAL";
  }
  return "UNKNOWN";
}

/**
 * True when the evidence is strong enough for a later attribution phase to
 * credit revenue to the journey. PARTIAL and UNKNOWN are deliberately excluded:
 * an unproven link must stay unattributed rather than be rounded up so a
 * dashboard has a source to show.
 *
 * Nothing consumes this yet — attribution weights are unchanged this phase.
 */
export function isAttributable(confidence: MatchConfidence): boolean {
  return CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK.STRONG;
}
