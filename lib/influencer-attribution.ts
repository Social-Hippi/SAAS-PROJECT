import { UTM_CONTENT_PREFIX } from "@/lib/utm";

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic influencer resolution (Track A).
//
// An influencer reaches HotelTrack by two independent routes, and BOTH must land
// on the same first-class `Influencer` row:
//
//   URL     utm_content=ht-<contentPieceId> → ContentPiece.influencerId → Influencer
//   COUPON  couponCodeUsed → CouponCode(hotelClientId, code).influencerId → Influencer
//
// Neither route matches on a display name. `ContentPiece.influencerName` is kept
// for history and for the UI label, but resolving identity from it would break
// on two influencers sharing a name and on any rename — so nothing here reads it.
//
// The parsing half is PURE (no DB) so the URL contract is testable without an
// environment; the lookup half lives in lib/influencer-resolve.ts (server-only).
// ─────────────────────────────────────────────────────────────────────────────

/** How an influencer was identified for a given conversion. */
export type InfluencerMatchRoute = "utm_content" | "coupon_code";

export type InfluencerResolution = {
  influencerId: string;
  /** Present only for the URL route. */
  contentPieceId: string | null;
  route: InfluencerMatchRoute;
};

/**
 * Extract a ContentPiece id from a `utm_content` value.
 *
 * Returns null for anything that is not one of our tags — a hand-written
 * `utm_content=summer-reel` is NOT a content piece and must not be coerced into
 * a lookup. Unlike `contentIdFromUtmContent` in lib/attribution.ts, this does
 * not require the caller to already hold the set of valid ids, so it can be used
 * before any database read.
 */
export function contentPieceIdFromUtmContent(utmContent: string | null | undefined): string | null {
  if (typeof utmContent !== "string") return null;
  const trimmed = utmContent.trim();
  if (!trimmed.startsWith(UTM_CONTENT_PREFIX)) return null;
  const id = trimmed.slice(UTM_CONTENT_PREFIX.length);
  // cuid()s are alphanumeric; reject anything else rather than querying on junk.
  return /^[a-z0-9]{6,64}$/i.test(id) ? id : null;
}

/**
 * True when this UTM pair is HotelTrack's influencer convention, i.e. what
 * buildUtmLink() emits for a ContentPiece whose contentType is `influencer`:
 *
 *   utm_source = <platform>   (instagram | facebook | youtube)
 *   utm_medium = influencer
 *
 * Mirrors the `medium === "influencer"` branch in lib/source-classifier.ts.
 */
export function isInfluencerUtm(utmMedium: string | null | undefined): boolean {
  return (utmMedium ?? "").trim().toLowerCase() === "influencer";
}
