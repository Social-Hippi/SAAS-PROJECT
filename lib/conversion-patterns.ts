// ─────────────────────────────────────────────────────────────────────────────
// Confirmation paths — the URLs that mean "this guest completed a booking".
//
// Stored as ONE newline-separated string in HotelClient.thankYouUrlPattern, and
// split by the snippet's matcher. Newline rather than "|" because the matcher
// ESCAPES "|" when building its glob regex, so a pipe-joined list matches a
// literal pipe and therefore nothing at all — silently.
//
// Backwards compatible: a hotel with a single pattern has no newline in it, so
// existing values keep working untouched.
// ─────────────────────────────────────────────────────────────────────────────

export const PATTERN_SEPARATOR = "\n";

/**
 * A confirmation path, or null.
 *
 * Accepts a full URL and keeps the path — an operator reads a confirmation URL
 * out of their browser bar and pastes the whole thing, and a setting that
 * rejects that is a setting people work around.
 */
export function normalizeThankYouPattern(raw: string): string | null {
  let v = String(raw ?? "").trim();
  if (!v) return null;

  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      // The query is dropped: a booking reference in it is unique per booking,
      // so keeping it would match exactly one guest's confirmation forever.
      v = u.pathname;
    } catch {
      return null;
    }
  }

  if (!v.startsWith("/")) v = "/" + v;

  // Internal whitespace is REFUSED, not stripped. Stripping turns "not a path"
  // into "/notapath" — a different, valid-looking value that silently matches
  // nothing, which is precisely the silence this setting exists to end.
  if (/\s/.test(v)) return null;

  // A bare "/" or "/*" matches every page on the site, so every visit becomes a
  // booking. Refused rather than accepted as written.
  if (v === "/" || v === "/*") return null;
  // Path characters plus the one wildcard the matcher understands.
  if (!/^\/[A-Za-z0-9\-._~!$&'()+,;=:@/%*]*$/.test(v)) return null;

  return v;
}

/** Parse a textarea of paths. Rejected entries are reported, never dropped. */
export function normalizeThankYouPatterns(raw: string): {
  patterns: string[];
  rejected: string[];
} {
  const entries = String(raw ?? "")
    .split(/[\r\n,]+/)
    .map((e) => e.trim())
    .filter(Boolean);

  const patterns: string[] = [];
  const rejected: string[] = [];
  for (const entry of entries) {
    const p = normalizeThankYouPattern(entry);
    if (!p) rejected.push(entry);
    else if (!patterns.includes(p)) patterns.push(p);
  }
  return { patterns, rejected };
}

/** Split a stored value back into its paths, for display. */
export function splitThankYouPatterns(stored: string | null | undefined): string[] {
  return String(stored ?? "")
    .split(PATTERN_SEPARATOR)
    .map((p) => p.trim())
    .filter(Boolean);
}
