// ─────────────────────────────────────────────────────────────────────────────
// Cross-domain journey handoff token (`_ht_j`).
//
// THE PROBLEM IT SOLVES
// A hotel's booking journey frequently leaves the tracked website. Aster
// Holidays is the proven case: the booking CTA on asterholidays.com points at
// bookings.coffeeberryhills.in, and payment happens on a third host. Both
// sessionStorage and the visitor cookie are ORIGIN-scoped, so the visit that
// continues on the booking engine starts as a brand-new visitor with no UTMs.
// The influencer, campaign and content that produced the click are lost at the
// hop, and no downstream conversion can ever be joined back to it.
//
// WHAT THIS IS
// A compact, URL-safe, NON-PII token carrying only what the browser already
// sends on every beacon: the session id, the visitor id, the FIRST-TOUCH UTMs
// and any ad click ids. It is appended to outbound links whose host the hotel
// has explicitly listed in `HotelClient.bookingDomains`.
//
// WHAT THIS IS DELIBERATELY NOT
//   * NOT an authentication or authorisation token. It grants nothing.
//   * NOT a tenant identifier. Tenancy always comes from `siteId` resolved
//     server-side; a token can never name or change a hotel or agency.
//   * NOT a carrier of PII. No email, phone, name, IP or free text.
//
// TRUST MODEL
// Every field here is ALREADY client-supplied on the normal beacon, so the
// token adds no new trust surface at the ingest endpoint. It is unsigned by
// necessity: it is minted in the browser, and signing it would mean shipping a
// secret to every visitor.
//
// The residual risk is link sharing — a URL copied while it still carries
// `_ht_j` would let a second person adopt the first person's session. Two
// controls bound that: a short TTL (`MAX_TOKEN_AGE_MS`, matching the 30-minute
// session idle window), and adoption only when the receiving page has NO
// attribution of its own, so a token can never overwrite stronger evidence.
// This is the same trade-off every cross-domain linker makes (GA's `_gl`).
// ─────────────────────────────────────────────────────────────────────────────

/** Query parameter the snippet reads and writes. */
export const JOURNEY_PARAM = "_ht_j";

/** Token format version — bump if the payload shape ever changes. */
export const JOURNEY_TOKEN_VERSION = 1;

/**
 * A token older than this is ignored. Matches the snippet's 30-minute session
 * idle window: past it the originating session would have expired anyway, so
 * adopting it would stitch together two genuinely separate visits.
 */
export const MAX_TOKEN_AGE_MS = 30 * 60 * 1000;

/** Hard ceiling so a crafted URL cannot push an unbounded string into a beacon. */
export const MAX_TOKEN_LENGTH = 1024;

export type JourneyTokenPayload = {
  /** Originating session id. */
  s: string;
  /** Originating visitor id. */
  i: string;
  /** First-touch UTMs, only the keys that were actually present. */
  u: Partial<Record<"utm_source" | "utm_medium" | "utm_campaign" | "utm_content" | "utm_term", string>>;
  /** Ad click ids, only the keys that were actually present. */
  c: Partial<Record<"gclid" | "gbraid" | "wbraid" | "fbclid", string>>;
  /** Mint time, epoch ms. */
  t: number;
  /** Format version. */
  v: number;
};

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
const CLICK_KEYS = ["gclid", "gbraid", "wbraid", "fbclid"] as const;

/** Base64url, no padding — safe in a query string without further escaping. */
function b64urlEncode(raw: string): string {
  const b64 = typeof btoa === "function"
    ? btoa(unescape(encodeURIComponent(raw)))
    : Buffer.from(raw, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(v: string): string | null {
  try {
    const b64 = v.replace(/-/g, "+").replace(/_/g, "/");
    return typeof atob === "function"
      ? decodeURIComponent(escape(atob(b64)))
      : Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** Build a token. Returns null when there is nothing worth carrying across. */
export function encodeJourneyToken(input: {
  sessionId: string | null | undefined;
  visitorId: string | null | undefined;
  utms?: Record<string, string | null | undefined> | null;
  clickIds?: Record<string, string | null | undefined> | null;
  now: number;
}): string | null {
  const s = (input.sessionId ?? "").trim();
  const i = (input.visitorId ?? "").trim();
  if (!s || !i) return null;

  const u: JourneyTokenPayload["u"] = {};
  for (const k of UTM_KEYS) {
    const v = input.utms?.[k];
    if (typeof v === "string" && v.trim()) u[k] = v.trim().slice(0, 255);
  }
  const c: JourneyTokenPayload["c"] = {};
  for (const k of CLICK_KEYS) {
    const v = input.clickIds?.[k];
    if (typeof v === "string" && v.trim()) c[k] = v.trim().slice(0, 255);
  }

  const payload: JourneyTokenPayload = { s, i, u, c, t: input.now, v: JOURNEY_TOKEN_VERSION };
  const token = b64urlEncode(JSON.stringify(payload));
  return token.length > MAX_TOKEN_LENGTH ? null : token;
}

/**
 * Parse and validate a token. Returns null for anything malformed, oversized,
 * wrong-version or expired — never throws, and never partially trusts a token.
 */
export function decodeJourneyToken(token: string | null | undefined, now: number): JourneyTokenPayload | null {
  if (typeof token !== "string") return null;
  const t = token.trim();
  if (!t || t.length > MAX_TOKEN_LENGTH) return null;

  const json = b64urlDecode(t);
  if (!json) return null;

  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;

  const p = parsed as Record<string, unknown>;
  if (p.v !== JOURNEY_TOKEN_VERSION) return null;
  if (typeof p.s !== "string" || !p.s || typeof p.i !== "string" || !p.i) return null;
  if (typeof p.t !== "number" || !Number.isFinite(p.t)) return null;

  // Expired, or minted in the future (clock skew / tampering) — reject both.
  const age = now - p.t;
  if (age < 0 || age > MAX_TOKEN_AGE_MS) return null;

  const u: JourneyTokenPayload["u"] = {};
  const rawU = (p.u ?? {}) as Record<string, unknown>;
  for (const k of UTM_KEYS) if (typeof rawU[k] === "string" && rawU[k]) u[k] = String(rawU[k]).slice(0, 255);

  const c: JourneyTokenPayload["c"] = {};
  const rawC = (p.c ?? {}) as Record<string, unknown>;
  for (const k of CLICK_KEYS) if (typeof rawC[k] === "string" && rawC[k]) c[k] = String(rawC[k]).slice(0, 255);

  return { s: p.s, i: p.i, u, c, t: p.t, v: JOURNEY_TOKEN_VERSION };
}

/**
 * Host match for `HotelClient.bookingDomains`. Exact host or a subdomain of a
 * listed host; never a suffix match, so "evil-coffeeberryhills.in" can never
 * satisfy an entry for "coffeeberryhills.in".
 */
export function isBookingDomain(host: string | null | undefined, domains: readonly string[] | null | undefined): boolean {
  const h = (host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!h || !domains?.length) return false;
  return domains.some((d) => {
    const t = String(d ?? "").trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    if (!t) return false;
    return h === t || h.endsWith("." + t);
  });
}
