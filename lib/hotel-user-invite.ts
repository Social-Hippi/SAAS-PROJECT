// Per-person hotel invitations — the PURE half: token minting/hashing, the
// state machine, and the reason a given invitation cannot be accepted.
//
// No DB and no "server-only" here, so the server action, the accept route and
// the tests share one definition of "is this invitation usable". The database
// work lives in the server actions that call these.
//
// DISTINCT FROM lib/hotel-invite.ts. That file owns the agency-wide self-signup
// CODE a hotel uses to create its own HotelClient record — it onboards a
// PROPERTY. This one grants a PERSON access to a property that already exists.
// Keeping them apart matters: the self-signup code is deliberately short and
// human-readable because it is read aloud and retyped, whereas this token is a
// single-use secret that goes in a link and must be unguessable.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Mirrors the Prisma HotelInviteState enum. */
export type HotelInviteState = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";

/** How long a hotel-user invitation stays valid. */
export const HOTEL_INVITE_TTL_DAYS = 14;

/** 256 bits, hex — the same strength as HotelClient.shareToken. */
const TOKEN_BYTES = 32;

/** A well-formed invitation token is 64 lowercase hex chars. */
export function isHotelInviteTokenShape(token: string | null | undefined): boolean {
  return typeof token === "string" && /^[a-f0-9]{64}$/.test(token);
}

/**
 * Mint a single-use invitation token.
 *
 * Returns the token (emailed once, never stored) and its SHA-256 (persisted).
 * A leaked database therefore cannot be used to accept an outstanding
 * invitation — the same discipline applied to share-link passwords (scrypt),
 * visitor PII (salted hash) and share-access IPs.
 *
 * SHA-256 with no salt is correct HERE and would not be for a password: the
 * input is 256 bits of CSPRNG output, so there is no dictionary to attack and
 * a per-row salt would only prevent the O(1) lookup the accept path needs.
 */
export function mintHotelInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  return { token, tokenHash: hashHotelInviteToken(token) };
}

/** The stored form of a token. Deterministic, so the accept path can look it up. */
export function hashHotelInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time comparison of two invitation hashes.
 *
 * The accept path looks the row up BY hash (an indexed unique lookup), so this
 * is belt-and-braces for any caller that has both values in hand and would
 * otherwise reach for `===`.
 */
export function hotelInviteHashMatches(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Expiry for a freshly issued invitation. */
export function hotelInviteExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + HOTEL_INVITE_TTL_DAYS * 86_400_000);
}

/** Email addresses are compared case-insensitively; store the normalized form. */
export function normalizeInviteEmail(raw: string): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v || v.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

// ── The state machine ────────────────────────────────────────────────────────

/**
 * Why an invitation cannot be accepted. Every case the brief calls out is a
 * NAMED outcome rather than a generic failure, because each needs a different
 * thing said to the person holding the link — "this was already used" and "this
 * was cancelled" are not the same message, and neither is "you're already on
 * this hotel", which is not really a failure at all.
 */
export type HotelInviteRejection =
  | "malformed"      // the token isn't even the right shape
  | "not_found"      // no invitation for this token
  | "revoked"        // an agency admin cancelled it
  | "already_used"   // accepted before, by someone
  | "expired"        // past expiresAt
  | "hotel_gone"     // the hotel was deleted after the invite went out
  | "agency_suspended";

export type HotelInviteEvaluation =
  | { ok: true }
  | { ok: false; reason: HotelInviteRejection };

/** The record shape the evaluation needs — a subset of HotelUserInvite. */
export type EvaluableInvite = {
  status: HotelInviteState;
  expiresAt: Date;
  hotelDeletedAt: Date | null;
  agencySuspendedAt: Date | null;
};

/**
 * Can this invitation be accepted right now?
 *
 * Order is deliberate: the strongest, most permanent reasons are reported first,
 * so someone holding a revoked invitation is told it was cancelled rather than
 * that it expired. `EXPIRED` is checked both as a stored status and against the
 * clock, because nothing sweeps the table — an invitation that passed its TTL is
 * expired whether or not a background job has noticed.
 */
export function evaluateHotelInvite(
  invite: EvaluableInvite | null,
  now: Date = new Date(),
): HotelInviteEvaluation {
  if (!invite) return { ok: false, reason: "not_found" };
  if (invite.status === "REVOKED") return { ok: false, reason: "revoked" };
  if (invite.status === "ACCEPTED") return { ok: false, reason: "already_used" };
  if (invite.hotelDeletedAt) return { ok: false, reason: "hotel_gone" };
  if (invite.agencySuspendedAt) return { ok: false, reason: "agency_suspended" };
  if (invite.status === "EXPIRED" || invite.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

/** What to tell the person holding the link. Plain language, no jargon. */
export const HOTEL_INVITE_REJECTION_MESSAGE: Record<HotelInviteRejection, string> = {
  malformed: "This invitation link isn't valid. Ask your agency to send a new one.",
  not_found: "This invitation link isn't valid. Ask your agency to send a new one.",
  revoked: "This invitation was cancelled. Ask your agency to send a new one.",
  already_used: "This invitation has already been used. Try signing in instead.",
  expired: "This invitation has expired. Ask your agency to send a new one.",
  hotel_gone: "This hotel is no longer available on HotelTrack.",
  agency_suspended: "This account is not active. Please contact your agency.",
};
