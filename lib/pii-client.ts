// Browser-safe PII hashing — NO "server-only", so the dashboard's Customer
// Journey Lookup search box can hash an email/phone in the browser before it ever
// touches the network. The tracking snippet (scripts/snippet.src.js) mirrors this
// exact normalization + SHA-256 so the hashes line up; keep the two in sync.
//
// This produces the CLIENT hash. The server then applies a second, salted layer
// (lib/pii.ts → saltedHash) before storing/querying, so the salt stays a
// server-only secret and the raw value never leaves the browser.

/** Lower-case + trim — must match the snippet's email normalization exactly. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A phone number reduced to ONE canonical form: country code + subscriber
 * number, digits only ("919900449954"). Must match the snippet's phone
 * normalization exactly, or a browser hash will never equal a server hash.
 *
 * WHY THIS IS NOT JUST `replace(/[^0-9]/g, "")`, which is what it used to be.
 * One Indian mobile is commonly written four ways, and stripping punctuation
 * alone leaves three DIFFERENT strings:
 *
 *     +91 99004 49954  ->  919900449954
 *     +919900449954    ->  919900449954
 *     09900449954      ->  09900449954   <- different, never matches
 *     9900449954       ->  9900449954    <- different, never matches
 *
 * Nothing errors. The hashes simply never collide, so a guest who messaged from
 * a WhatsApp ad is never recognised as the guest who booked — for every booking,
 * permanently, with no symptom other than an attribution rate that looks
 * disappointing. WhatsApp Cloud API reports "919900449954" while a hotel's own
 * system commonly stores "9900449954", so the two sides we most need to join are
 * exactly the two that would disagree.
 *
 * All four forms above now converge on 919900449954.
 *
 * `defaultCallingCode` is applied only to a bare national number. It is a
 * parameter rather than a constant so a non-Indian property is a call-site
 * change, not a rewrite — but it defaults to India, which is every property
 * today, and guessing wrong is better than refusing to normalise at all.
 */
export function normalizePhone(phone: string, defaultCallingCode = "91"): string {
  let digits = String(phone ?? "").replace(/[^0-9]/g, "");

  // "00" is the international access prefix — 0091 99004 49954 is the same
  // number as +91 99004 49954.
  if (digits.startsWith("00")) digits = digits.slice(2);
  // A single leading 0 is the national trunk prefix, dialled only domestically.
  else if (digits.startsWith("0")) digits = digits.replace(/^0+/, "");

  // A bare subscriber number carries no country code, so it gets the default.
  // 10 digits is the Indian mobile length; a number already carrying its code is
  // longer and is left alone.
  if (digits.length === 10) digits = defaultCallingCode + digits;

  // Too short to be a phone number at all — an extension, a truncated field, a
  // stray value. Returning it would mint a join key that matches other junk.
  if (digits.length < 10) return "";

  return digits;
}

/** Hex SHA-256 of a string via Web Crypto (returns "" if unavailable). */
export async function sha256Hex(input: string): Promise<string> {
  try {
    const data = new TextEncoder().encode(input);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "";
  }
}

/** Client hash for an email (normalize → SHA-256). "" when empty/unavailable. */
export async function hashEmailClient(email: string): Promise<string> {
  const n = normalizeEmail(email);
  return n ? sha256Hex(n) : "";
}

/** Client hash for a phone (normalize → SHA-256). "" when empty/unavailable. */
export async function hashPhoneClient(phone: string): Promise<string> {
  const n = normalizePhone(phone);
  return n ? sha256Hex(n) : "";
}
