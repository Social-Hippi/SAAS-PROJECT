// ─────────────────────────────────────────────────────────────────────────────
// Marketing CLICK IDENTIFIERS (Phase 1A).
//
// Until now HotelTrack's only evidence that a visit came from an ad was the UTM
// query string — which the advertiser has to add by hand and which any link can
// carry. Ad platforms also stamp their own deterministic click identifier on the
// destination URL, and that is far stronger evidence:
//
//   gclid   Google Ads  — standard auto-tagging (web)
//   gbraid  Google Ads  — iOS app→web journeys (privacy-preserving)
//   wbraid  Google Ads  — iOS web→app journeys (privacy-preserving)
//   fbclid  Meta        — appended to outbound clicks from Facebook/Instagram
//
// PURE module: no DB, no session, no "server-only" — the snippet's mirror of
// this logic lives in scripts/snippet.src.js, the ingest route and the classifier
// both consume it, and the tests import it directly.
//
// ── An important asymmetry, deliberately encoded here ──
// gclid/gbraid/wbraid are minted ONLY by Google Ads, so their presence proves a
// paid Google click. `fbclid` is appended by Meta to ANY outbound link click from
// its surfaces — including an organic post — so it proves "came from Meta", NOT
// "came from a Meta ad". Treating it as paid would inflate the paid ROAS that
// Phase 0 just corrected. See isGoogleAdsClick / isMetaClick.
// ─────────────────────────────────────────────────────────────────────────────

/** The four identifiers we capture, in the order they are checked. */
export const CLICK_ID_KEYS = ["gclid", "gbraid", "wbraid", "fbclid"] as const;
export type ClickIdKey = (typeof CLICK_ID_KEYS)[number];

/** Google Ads mints exactly these three. */
export const GOOGLE_CLICK_ID_KEYS = ["gclid", "gbraid", "wbraid"] as const;

export type ClickIds = Partial<Record<ClickIdKey, string | null>>;

/**
 * Upper bound for a click identifier. Real gclids run ~60–100 chars and the
 * braid variants are similar; 255 is generous headroom AND the natural width of
 * the column these will land in. Anything longer is not a click id — it is junk
 * or an injection attempt — and is dropped rather than truncated (a truncated
 * click id is worse than none: it would never match the ad platform's records).
 */
export const MAX_CLICK_ID_LENGTH = 255;

/**
 * Click ids are URL-safe tokens. Google and Meta both emit the unreserved
 * base64url set; some carry a dot. Anything outside it (spaces, quotes, angle
 * brackets, control chars, %-escapes that survived decoding) means the value was
 * tampered with or mis-parsed, so it is rejected outright — we never "clean" a
 * click id into a different string that would silently fail to match upstream.
 */
const CLICK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Normalize one raw value into a usable click id, or null.
 * Rejects: non-strings, empty/whitespace, over-length, and invalid charsets.
 */
export function normalizeClickId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_CLICK_ID_LENGTH) return null;
  if (!CLICK_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/** A source of raw values: a parsed payload, a query string, or a plain object. */
type RawSource = URLSearchParams | Record<string, unknown> | null | undefined;

function rawValue(src: RawSource, key: string): unknown {
  if (!src) return undefined;
  if (src instanceof URLSearchParams) return src.get(key) ?? undefined;
  return (src as Record<string, unknown>)[key];
}

/**
 * Extract every recognised click id from a query string or payload object.
 * Absent / invalid values come back as null, never as "" — so a missing id is
 * always distinguishable from a present one.
 */
export function parseClickIds(src: RawSource): ClickIds {
  const out: ClickIds = {};
  for (const key of CLICK_ID_KEYS) {
    out[key] = normalizeClickId(rawValue(src, key));
  }
  return out;
}

/**
 * FIRST-TOUCH-WINS merge that can only ever ADD information.
 *
 * A later pageview with no click id in its URL (i.e. every internal navigation
 * after the landing page) must NEVER erase the id captured on arrival — that is
 * the whole persistence requirement. A later page that DOES carry a click id is
 * a genuinely new ad click, so it replaces the value for that platform.
 *
 * Per-key, not whole-object: a Meta click after a Google click keeps both, which
 * is exactly the multi-touch reality we want to preserve for later phases.
 */
export function mergeClickIds(existing: ClickIds | null | undefined, incoming: ClickIds | null | undefined): ClickIds {
  const out: ClickIds = {};
  for (const key of CLICK_ID_KEYS) {
    const next = normalizeClickId(incoming?.[key]);
    const prev = normalizeClickId(existing?.[key]);
    out[key] = next ?? prev ?? null;
  }
  return out;
}

/** True when at least one identifier is present. */
export function hasAnyClickId(ids: ClickIds | null | undefined): boolean {
  return CLICK_ID_KEYS.some((k) => normalizeClickId(ids?.[k]) != null);
}

/**
 * True when this visit carries a GOOGLE ADS click identifier.
 * Deterministic proof of a paid Google click — the basis for never classifying
 * an auto-tagged Google visitor as "direct".
 */
export function isGoogleAdsClick(ids: ClickIds | null | undefined): boolean {
  return GOOGLE_CLICK_ID_KEYS.some((k) => normalizeClickId(ids?.[k]) != null);
}

/**
 * True when this visit carries a Meta click identifier.
 *
 * NOTE what this does and does not mean: `fbclid` proves the click came from a
 * Meta surface, NOT that it came from a paid ad — Meta appends it to organic
 * post links too. It is therefore deliberately NOT used to classify a visit as
 * `meta_ads`; paid/organic still comes from the UTM medium. It is captured and
 * persisted so a later phase (Meta CAPI, offline conversions) can use it.
 */
export function isMetaClick(ids: ClickIds | null | undefined): boolean {
  return normalizeClickId(ids?.fbclid) != null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attribution EVIDENCE hierarchy (Phase 1A establishes it; nothing consumes it
// to re-weight attribution yet — see the phase notes).
//
// Higher rank = stronger, more deterministic evidence about where a visit came
// from. Recorded now so first/last/U-shaped credit can prefer a click-id touch
// over a bare-UTM touch in a later phase WITHOUT re-deriving the rules.
// ─────────────────────────────────────────────────────────────────────────────

export type EvidenceStrength =
  | "click_id" // deterministic: the ad platform stamped this click
  | "utm" // advertiser-supplied tagging; trustworthy but hand-maintained
  | "session" // inferred from another event in the same session
  | "referrer" // inferred from the referring host
  | "none"; // no signal — "direct"

export const EVIDENCE_RANK: Record<EvidenceStrength, number> = {
  click_id: 4,
  utm: 3,
  session: 2,
  referrer: 1,
  none: 0,
};

export type EvidenceInput = ClickIds & {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  referrer?: string | null;
};

/** Classify how strong the evidence behind one touch/event is. */
export function evidenceStrength(input: EvidenceInput | null | undefined): EvidenceStrength {
  if (!input) return "none";
  if (hasAnyClickId(input)) return "click_id";
  if (input.utmSource || input.utmMedium || input.utmCampaign || input.utmContent) return "utm";
  if (input.referrer) return "referrer";
  return "none";
}

/** True when `a` is at least as strong as `b`. */
export function isAtLeastAsStrong(a: EvidenceStrength, b: EvidenceStrength): boolean {
  return EVIDENCE_RANK[a] >= EVIDENCE_RANK[b];
}

/**
 * Log-safe rendering of a click id: length + first 4 chars only.
 *
 * Click ids are not secrets, but they are per-click identifiers tied to one real
 * person's ad interaction, and they are the join key to the ad platform's own
 * records. Emitting them in full into application logs spreads them into log
 * aggregation with no benefit — a prefix is enough to correlate a support case.
 */
export function redactClickId(value: string | null | undefined): string {
  const v = normalizeClickId(value);
  if (!v) return "(none)";
  return `${v.slice(0, 4)}…(${v.length})`;
}

/** Log-safe summary of which identifiers were present. Never emits a value. */
export function describeClickIds(ids: ClickIds | null | undefined): string {
  const present = CLICK_ID_KEYS.filter((k) => normalizeClickId(ids?.[k]) != null);
  return present.length ? present.join(",") : "(none)";
}
