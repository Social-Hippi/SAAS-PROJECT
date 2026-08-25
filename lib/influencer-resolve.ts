import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant-scope";
import {
  contentPieceIdFromUtmContent,
  type InfluencerResolution,
} from "@/lib/influencer-attribution";

// ─────────────────────────────────────────────────────────────────────────────
// Server-side influencer lookup (Track A).
//
// Both routes are FOREIGN-KEY resolutions and both are hotel-scoped, so one
// hotel's content or coupon can never resolve an influencer for another hotel.
// Nothing here matches on a display name.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * URL route: utm_content → ContentPiece → Influencer.
 *
 * Returns null when the tag isn't ours, the piece belongs to another hotel, or
 * the piece has no influencer attached — all of which are "we cannot prove an
 * influencer", not "guess one".
 */
export async function resolveInfluencerFromUtmContent(args: {
  agencyId: string;
  hotelClientId: string;
  utmContent: string | null | undefined;
}): Promise<InfluencerResolution | null> {
  const contentPieceId = contentPieceIdFromUtmContent(args.utmContent);
  if (!contentPieceId) return null;

  const piece = await agencyScopedFor(args.agencyId, prisma.contentPiece).findFirst({
    where: { id: contentPieceId, hotelClientId: args.hotelClientId },
    select: { id: true, influencerId: true },
  });
  if (!piece?.influencerId) return null;

  return { influencerId: piece.influencerId, contentPieceId: piece.id, route: "utm_content" };
}

/**
 * Coupon route: couponCodeUsed → CouponCode → Influencer.
 *
 * Deliberately does NOT apply the ACTIVE / validity-window filter that the
 * ingest path uses when creating an InfluencerRedemption: for *attribution* the
 * question is "whose code is this", which an expired code still answers. Whether
 * the redemption counts is a separate decision made at ingest.
 */
export async function resolveInfluencerFromCoupon(args: {
  agencyId: string;
  hotelClientId: string;
  couponCode: string | null | undefined;
}): Promise<InfluencerResolution | null> {
  const code = (args.couponCode ?? "").trim().toUpperCase();
  if (!code) return null;

  const coupon = await agencyScopedFor(args.agencyId, prisma.couponCode).findFirst({
    where: { hotelClientId: args.hotelClientId, code },
    select: { influencerId: true },
  });
  if (!coupon?.influencerId) return null;

  return { influencerId: coupon.influencerId, contentPieceId: null, route: "coupon_code" };
}

/**
 * Resolve by whichever route is available, preferring the coupon.
 *
 * Rationale: a coupon is entered by the guest at booking time and names the
 * influencer directly, whereas a utm_content tag only proves the click arrived
 * via that influencer's link. When both are present and DISAGREE, that conflict
 * is returned rather than silently resolved — two different influencers cannot
 * both have produced one booking, and picking one would invent certainty.
 */
export async function resolveInfluencerForConversion(args: {
  agencyId: string;
  hotelClientId: string;
  utmContent: string | null | undefined;
  couponCode: string | null | undefined;
}): Promise<{ resolution: InfluencerResolution | null; conflict: boolean }> {
  const [viaCoupon, viaUtm] = await Promise.all([
    resolveInfluencerFromCoupon(args),
    resolveInfluencerFromUtmContent(args),
  ]);

  if (viaCoupon && viaUtm && viaCoupon.influencerId !== viaUtm.influencerId) {
    return { resolution: viaCoupon, conflict: true };
  }
  return { resolution: viaCoupon ?? viaUtm, conflict: false };
}
