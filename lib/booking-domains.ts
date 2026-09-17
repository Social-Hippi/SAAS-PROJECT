// ─────────────────────────────────────────────────────────────────────────────
// Normalising a booking-engine hostname.
//
// Pure, and deliberately NOT in the server-action file: a "use server" module
// may only export async functions, so a sync helper there fails the build. It
// also means this can be unit-tested without a request.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "https://Bookings.Example.com/path?x=1" -> "bookings.example.com".
 *
 * Accepts what an operator will actually paste — a full URL, a bare host, a
 * wildcard prefix, a trailing slash — because a setting that silently fails on
 * a trailing slash is the same class of bug as the one it exists to fix.
 *
 * Returns null for anything that is not a hostname, so a path fragment or a
 * typo cannot be stored as a host that will then never match.
 */
export function normalizeBookingHost(raw: string): string | null {
  let v = String(raw ?? "").trim().toLowerCase();
  if (!v) return null;
  // A wildcard is redundant rather than wrong: the snippet already matches true
  // subdomains, so "*.example.com" is stripped to the domain it wildcards.
  v = v.replace(/^https?:\/\//, "").replace(/^\*\./, "");
  v = v.split("/")[0].split("?")[0].split("#")[0];
  v = v.replace(/\.$/, "").replace(/:\d+$/, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v)) {
    return null;
  }
  return v;
}
