import { normalizeSource, normalizeMedium, DIRECT_SOURCE } from "./utm-normalize";
import { isGoogleAdsClick, type ClickIds } from "./click-ids";

// Source-type classification — folds a conversion's UTM data into one coarse
// marketing category, used for the dashboard's quick-filter chips ("Meta Ads",
// "Influencer", …). The raw + normalized UTM is still preserved for the granular
// table; this is purely the bucket the chips filter on. Pure + deterministic.
//
// To add a new source type: add it to SOURCE_TYPES + SOURCE_TYPE_LABEL, then add
// a branch to classifySourceType BEFORE the `other` fallback. To recognise more
// influencer links, extend INFLUENCER_CONTENT_PATTERNS.

export const SOURCE_TYPES = [
  "meta_ads",
  "google_ads",
  "instagram_organic",
  "facebook_organic",
  "influencer",
  "email",
  "whatsapp",
  "direct",
  "other",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  instagram_organic: "Instagram Organic",
  facebook_organic: "Facebook Organic",
  influencer: "Influencer",
  email: "Email",
  whatsapp: "WhatsApp",
  direct: "Direct",
  other: "Other",
};

export function isSourceType(v: unknown): v is SourceType {
  return typeof v === "string" && (SOURCE_TYPES as readonly string[]).includes(v);
}

/**
 * The PAID buckets — the only revenue that may appear in a ROAS numerator
 * (Phase 0). Everything else (direct, organic social, influencer, email,
 * whatsapp, other) is revenue that no ad spend bought, so dividing it by ad
 * spend is not return on ad spend.
 *
 * Single source of truth: lib/attribution.ts, lib/owner-metrics.ts and the
 * agency overview route all classify "paid" through here, so the definition can
 * never drift between surfaces.
 */
export const PAID_SOURCE_TYPES = ["meta_ads", "google_ads"] as const satisfies readonly SourceType[];

export function isPaidSourceType(t: SourceType): boolean {
  return (PAID_SOURCE_TYPES as readonly SourceType[]).includes(t);
}

// A medium is "paid" if it looks like an ad medium (cpc / paid / ads / ppc).
const PAID_MEDIUM = /(cpc|paid|ppc|ads?)/;
function isPaidMedium(medium: string): boolean {
  return PAID_MEDIUM.test(medium);
}

// utm_content values that indicate an influencer collaboration. Extend as needed
// (e.g. add /^@/ if you tag influencer handles, or specific creator slugs).
const INFLUENCER_CONTENT_PATTERNS: RegExp[] = [/^inf[_-]/, /influencer/];
function contentLooksInfluencer(content: string | null | undefined): boolean {
  const v = (content ?? "").trim().toLowerCase();
  if (!v) return false;
  return INFLUENCER_CONTENT_PATTERNS.some((re) => re.test(v));
}

export type ClassifiableUtm = ClickIds & {
  utmSource: string | null | undefined;
  utmMedium: string | null | undefined;
  utmContent?: string | null | undefined;
};

/**
 * Classify a conversion's UTM into a SourceType. Deterministic; branches are
 * ordered most-specific first so the result is stable.
 *
 * PHASE 1A: a Google Ads click identifier now outranks every UTM heuristic.
 * Google Ads auto-tagging (the DEFAULT setting) sends traffic with a `gclid` and
 * NO utm parameters at all, so every auto-tagged click used to fall through to
 * `direct` — Google-driven revenue was being credited to Direct, and paid ROAS
 * understated. gclid/gbraid/wbraid are minted only by Google Ads, so their
 * presence is deterministic proof of a paid Google click.
 *
 * `fbclid` is deliberately NOT treated the same way: Meta appends it to organic
 * post links as well as ads, so it cannot distinguish paid from organic. It is
 * captured and persisted for later use, but classification stays UTM-driven.
 * (See lib/click-ids.ts for the full reasoning.)
 *
 * Caveat, accepted for this phase: a URL containing a gclid that someone copies
 * and shares elsewhere carries that evidence with it. Validating a click id
 * against the Ads API at ingest time is the only real defence and is out of
 * scope here.
 */
export function classifySourceType(utm: ClassifiableUtm): SourceType {
  // Deterministic ad-click identity beats every string heuristic below, and is
  // checked BEFORE the direct branch so an auto-tagged click is never "direct".
  if (isGoogleAdsClick(utm)) return "google_ads";

  const source = normalizeSource(utm.utmSource);
  const medium = normalizeMedium(utm.utmMedium);

  // No source at all → direct (nothing else can apply).
  if (source === DIRECT_SOURCE) return "direct";

  const paid = isPaidMedium(medium);

  // Paid social / search.
  if ((source === "facebook" || source === "instagram") && paid) return "meta_ads";
  if (source === "google" && paid) return "google_ads";

  // Influencer (an explicit influencer medium, or an influencer-tagged content).
  if (medium === "influencer" || contentLooksInfluencer(utm.utmContent)) return "influencer";

  // Organic social (non-paid).
  if (source === "instagram") return "instagram_organic";
  if (source === "facebook") return "facebook_organic";

  // Owned channels.
  if (source === "email" || source === "newsletter") return "email";
  if (source === "whatsapp") return "whatsapp";

  return "other";
}
