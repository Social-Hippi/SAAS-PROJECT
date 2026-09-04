// Pure validation + normalization for the agency contact-info fields. No DB, no
// React — safe to import from server actions, route handlers, client components,
// and tests. Every "validate" returns the NORMALIZED value (or null/false) so the
// signup form and the settings form can share one source of truth.

/**
 * Indian mobile number. Accepts +91XXXXXXXXXX, 91XXXXXXXXXX, 0XXXXXXXXXX, or a
 * bare 10-digit XXXXXXXXXX, with spaces / hyphens / parens / dots anywhere.
 * Must resolve to exactly 10 digits whose first digit is 6–9 (valid Indian
 * mobile range). Returns the normalized "+91XXXXXXXXXX" form, or null.
 */
export function validateMobile(value: string): string | null {
  if (typeof value !== "string") return null;
  let digits = value.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  // Strip a country code (91) or trunk prefix (0) to land on the subscriber number.
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `+91${digits}`;
}

/** WhatsApp number — same rules/normalization as a mobile number. */
export function validateWhatsapp(value: string): string | null {
  return validateMobile(value);
}

/** wa.me / tel digits for a normalized number: "+919876543210" → "919876543210". */
export function whatsappDigits(normalized: string): string {
  return normalized.replace(/\D/g, "");
}

/**
 * Standard email check. Rejects the obvious typos the spec calls out — a missing
 * "@" or no dotted domain after it.
 */
export function validateEmail(value: string): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length === 0 || v.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/**
 * Website URL. Auto-prepends "https://" when the user just types "example.com",
 * then validates. Requires a dotted host (so "localhost" / a bare word is
 * rejected as a typo). Returns the normalized URL (no trailing "/" for a bare
 * host), or null.
 */
export function validateUrl(value: string): string | null {
  if (typeof value !== "string") return null;
  let v = value.trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname;
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) return null;
  const out = url.toString();
  // Drop the trailing slash URL adds for a bare host ("https://example.com/").
  return out.endsWith("/") && url.pathname === "/" && !url.search && !url.hash
    ? out.slice(0, -1)
    : out;
}

// ── Organisation name ────────────────────────────────────────────────────────

/** Matches the Agency.name column bound and the onboarding form's own limit. */
export const AGENCY_NAME_MAX = 120;
export const AGENCY_NAME_MIN = 2;

/**
 * The agency's ORGANISATION name — the identity every member of that agency
 * sees in the app header, on generated reports, and in emails to hotels.
 *
 * It is deliberately validated in one shared place because it is written from
 * two: onboarding (creation) and Agency Settings (correction). Until settings
 * could write it there was no correction path at all, so an agency named at
 * signup was named permanently — and onboarding pre-filled that field with
 * `${user.firstName}'s Agency`, which meant a whole organisation was
 * identified by whichever individual happened to sign up first.
 *
 * Returns the trimmed, whitespace-collapsed name, or null with a reason.
 */
export function validateAgencyName(
  value: string,
): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: "Enter your organisation's name." };
  }
  // Collapse runs of whitespace (including pasted newlines) to single spaces.
  const name = value.replace(/\s+/g, " ").trim();
  if (name.length === 0) {
    return { ok: false, error: "Enter your organisation's name." };
  }
  if (name.length < AGENCY_NAME_MIN) {
    return { ok: false, error: `Use at least ${AGENCY_NAME_MIN} characters.` };
  }
  if (name.length > AGENCY_NAME_MAX) {
    return { ok: false, error: `Use ${AGENCY_NAME_MAX} characters or fewer.` };
  }
  return { ok: true, name };
}

/** Physical address: 10–500 chars (newlines allowed for multi-line addresses). */
export function validateAddress(value: string): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  return v.length >= 10 && v.length <= 500;
}

// ── Combined validator for the whole contact form (used by both signup + settings) ──

export type ContactInput = {
  mobile: string;
  contactEmail: string;
  whatsappNumber: string;
  address: string;
  websiteUrl: string;
};

export type NormalizedContact = ContactInput;
export type ContactErrors = Partial<Record<keyof ContactInput, string>>;

/**
 * Shared useActionState shape for the contact form (used by the signup step and
 * the settings section). `redirectTo` lets the signup action drive a client-side
 * navigation after saving; `formError` is a non-field-specific error.
 */
export type ContactFormState = {
  ok: boolean;
  errors?: ContactErrors;
  formError?: string;
  redirectTo?: string;
};

/**
 * Validates + normalizes all five fields at once. On success returns the
 * normalized values ready to persist; on failure returns a per-field error map.
 */
export function validateAgencyContact(
  input: Partial<ContactInput>,
):
  | { ok: true; data: NormalizedContact }
  | { ok: false; errors: ContactErrors } {
  const errors: ContactErrors = {};

  const mobile = validateMobile(input.mobile ?? "");
  if (!mobile) errors.mobile = "Enter a valid 10-digit Indian mobile number.";

  const whatsappNumber = validateWhatsapp(input.whatsappNumber ?? "");
  if (!whatsappNumber) errors.whatsappNumber = "Enter a valid WhatsApp number.";

  const contactEmail = (input.contactEmail ?? "").trim();
  if (!validateEmail(contactEmail)) errors.contactEmail = "Enter a valid email address.";

  const websiteUrl = validateUrl(input.websiteUrl ?? "");
  if (!websiteUrl) errors.websiteUrl = "Enter a valid website URL.";

  const address = (input.address ?? "").trim();
  if (!validateAddress(address)) errors.address = "Enter an address (10–500 characters).";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  // No errors ⇒ every normalizer returned a non-null value.
  return {
    ok: true,
    data: { mobile: mobile!, contactEmail, whatsappNumber: whatsappNumber!, address, websiteUrl: websiteUrl! },
  };
}
