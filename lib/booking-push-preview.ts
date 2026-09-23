import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptToken } from "@/lib/encryption";
import { agencyScopedFor } from "@/lib/tenant-scope";

// ─────────────────────────────────────────────────────────────────────────────
// Reading a held Booking Push body, so a parser can be written from it.
//
// A held body is the provider's REAL payload — the sample we spent weeks asking
// Simplotel for. To map it we need the field names, the shapes and the formats;
// we do not need the guest.
//
// So the preview masks by VALUE, not by removing fields: a masked email is still
// an email-shaped string in the same place, an amount keeps its formatting, a
// date keeps its layout. The structure survives; the guest does not.
//
// WHAT IS NEVER MASKED. HotelTrack's own journey identifiers (_ht_j, session and
// visitor ids) are not guest data — they are the strongest evidence a booking
// can carry, and the whole point of reading the payload is to find out whether
// the provider echoes them back. Masking them would hide the answer.
// ─────────────────────────────────────────────────────────────────────────────

/** Keys whose value is guest data whatever it looks like. */
const SENSITIVE_KEY = /name|email|mail|phone|mobile|contact|address|city|pincode|zip|guest|customer/i;

/** Keys that are ours, not the guest's — never masked. */
const OURS = /_ht_j|journey|session|visitor|utm|gclid|fbclid|click/i;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A date or timestamp, in the formats providers actually send. Checked FIRST and
 * never masked: "2026-10-02" is digits with separators, so the phone rules below
 * would otherwise eat every check-in date — which is exactly what a parser needs.
 */
const DATE_LIKE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$|^\d{2}[/-]\d{2}[/-]\d{4}/;

/** Seven or more digits in a row — an unbroken number that long is not an amount. */
const LONG_DIGIT_RUN = /\d{7,}/;

/**
 * The whole value reads as a phone number, separators and all ("+91 98765 43210").
 *
 * A DECIMAL POINT IS NOT A SEPARATOR HERE. Allowing it made "12450.00" — seven
 * digits around a dot — look like a phone number and masked the booking amount,
 * which is the field the whole mapping exists to read. A run of seven or more
 * unbroken digits is caught above, so a plain "9876543210" is still masked.
 */
const PHONE_SHAPED = /^[+(]?\d[\d\s()-]{6,}$/;

const digitCount = (v: string) => (v.match(/\d/g) ?? []).length;

/** Masks a string, keeping its shape so the format stays readable. */
function maskString(v: string): string {
  if (EMAIL.test(v)) {
    const [, domain = ""] = v.split("@");
    const dot = domain.lastIndexOf(".");
    return `•••@•••${dot >= 0 ? domain.slice(dot) : ""}`;
  }
  // Keep the last two characters: enough to match a record by eye, not to
  // identify anyone.
  const tail = v.trim().slice(-2);
  return v.length <= 2 ? "••" : `${"•".repeat(Math.min(v.length - 2, 12))}${tail}`;
}

/**
 * Masks guest data inside a parsed payload, leaving every key, type and format
 * in place. Returns a structure ready to be printed as JSON.
 */
export function maskPayload(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => maskPayload(v, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskPayload(v, k)]),
    );
  }
  if (typeof value !== "string" || value === "") return value;
  if (OURS.test(key)) return value;
  if (SENSITIVE_KEY.test(key)) return maskString(value);
  // Dates first: they are digits with separators, and a parser lives on them.
  if (DATE_LIKE.test(value.trim())) return value;
  if (EMAIL.test(value)) return maskString(value);
  if (LONG_DIGIT_RUN.test(value)) return maskString(value);
  if (PHONE_SHAPED.test(value.trim()) && digitCount(value) >= 7) return maskString(value);
  return value;
}

export type HeldPush = {
  id: string;
  provider: string;
  outcome: string;
  reason: string | null;
  bodyBytes: number;
  receivedAt: Date;
  replayedAt: Date | null;
};

export type HeldPushBody = HeldPush & {
  /** The payload with guest data masked, pretty-printed. */
  masked: string;
  /** True when the body was not JSON at all — then `masked` is a note. */
  unreadable: boolean;
};

/** Held pushes for a hotel, newest first. Metadata only — no body. */
export async function listHeldPushes(agencyId: string, hotelClientId: string): Promise<HeldPush[]> {
  return agencyScopedFor(agencyId, prisma.bookingPushCapture).findMany({
    where: { hotelClientId },
    orderBy: { receivedAt: "desc" },
    take: 20,
    select: {
      id: true,
      provider: true,
      outcome: true,
      reason: true,
      bodyBytes: true,
      receivedAt: true,
      replayedAt: true,
    },
  });
}

/** One held push with its body decrypted and masked. Null when not found. */
export async function readHeldPush(
  agencyId: string,
  hotelClientId: string,
  id: string,
): Promise<HeldPushBody | null> {
  const row = await agencyScopedFor(agencyId, prisma.bookingPushCapture).findFirst({
    where: { id, hotelClientId },
  });
  if (!row) return null;

  const base: HeldPush = {
    id: row.id,
    provider: row.provider,
    outcome: row.outcome,
    reason: row.reason,
    bodyBytes: row.bodyBytes,
    receivedAt: row.receivedAt,
    replayedAt: row.replayedAt,
  };

  let raw: string;
  try {
    raw = decryptToken(row.bodyEncrypted).reveal();
  } catch {
    return { ...base, masked: "This body could not be decrypted.", unreadable: true };
  }

  try {
    return { ...base, masked: JSON.stringify(maskPayload(JSON.parse(raw)), null, 2), unreadable: false };
  } catch {
    // Held bodies are checked as JSON before being stored, so this is unlikely —
    // but a body we cannot parse is exactly the kind we must not print raw.
    return { ...base, masked: "This body is not valid JSON.", unreadable: true };
  }
}
