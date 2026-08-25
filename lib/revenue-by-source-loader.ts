import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import {
  aggregateRevenueBySource,
  type ConversionRow,
  type Granularity,
} from "@/lib/revenue-by-source";
import { classifySourceType, type SourceType } from "@/lib/source-classifier";

// Shared "Revenue by Source" compute, used by BOTH the agency route
// (/api/agency/hotels/[hotelId]/revenue-by-source) and the hotel-owner route
// (/api/hotel/[hotelClientId]/revenue-by-source). All reads go through
// agencyScoped() + a hotelClientId filter, so the result is always scoped to one
// hotel within its agency. The hotel-owner route runs this inside
// runWithAgencyScope() so agencyScoped() resolves the owner's agency.

const DAY_MS = 86_400_000;
const MAX_WINDOW_DAYS = 92; // bounds the daily/sparkline arrays + query size

export type RevenueBySourceResult = {
  hotelId: string;
  attributionModel: "first_touch";
  requestedAttributionModel: string;
  range: { startDate: string; endDate: string };
} & ReturnType<typeof aggregateRevenueBySource>;

export async function computeRevenueBySource(args: {
  hotelId: string;
  granularity: Granularity;
  requestedModel: string;
  start: Date;
  end: Date;
  sourceTypeFilter: Set<SourceType> | null;
}): Promise<RevenueBySourceResult> {
  let { start, end } = args;
  const { hotelId, granularity, requestedModel, sourceTypeFilter } = args;
  if (start > end) [start, end] = [end, start];
  if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    start = new Date(end.getTime() - MAX_WINDOW_DAYS * DAY_MS);
  }

  const events = await agencyScoped(prisma.trackingEvent).findMany({
    where: {
      hotelClientId: hotelId,
      eventType: "conversion",
      createdAt: { gte: start, lte: end },
    },
    select: {
      utmSource: true,
      utmMedium: true,
      utmCampaign: true,
      utmContent: true,
      // Phase 1A: click ids so stored conversions classify like live ones.
      gclid: true, gbraid: true, wbraid: true, fbclid: true,
      conversionValue: true,
      couponCodeUsed: true,
      createdAt: true,
    },
  });
  // Snippet/UTM conversions. couponCodeUsed (Phase R2) flips a row to influencer.
  const trackingRows: ConversionRow[] = events.map((e) => ({
    utmSource: e.utmSource,
    utmMedium: e.utmMedium,
    utmCampaign: e.utmCampaign,
    utmContent: e.utmContent,
    value: e.conversionValue == null ? 0 : Number(e.conversionValue), // NULL-safe
    occurredAt: e.createdAt,
    couponCode: e.couponCodeUsed,
    gclid: e.gclid, gbraid: e.gbraid, wbraid: e.wbraid, fbclid: e.fbclid,
  }));

  // Manual redemptions (Path B) are bookings that happened OFF-snippet — they
  // have no TrackingEvent, so they must be UNION-ed in or their revenue is lost.
  // snippet_auto redemptions are NOT added here (their TrackingEvent already
  // carries couponCodeUsed and is counted above) — that prevents double-counting.
  const manual = await agencyScoped(prisma.influencerRedemption).findMany({
    where: {
      hotelClientId: hotelId,
      redemptionSource: "manual_entry",
      OR: [
        { bookingDate: { gte: start, lte: end } },
        { AND: [{ bookingDate: null }, { redeemedAt: { gte: start, lte: end } }] },
      ],
    },
    select: { bookingValue: true, bookingDate: true, redeemedAt: true, couponCode: { select: { code: true } } },
  });
  const manualRows: ConversionRow[] = manual.map((m) => ({
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmContent: null,
    value: Number(m.bookingValue),
    occurredAt: m.bookingDate ?? m.redeemedAt,
    couponCode: m.couponCode?.code ?? "manual",
  }));

  const rows = [...trackingRows, ...manualRows];

  // A row's effective source type is coupon-aware (influencer wins over UTM) so the
  // chip filter agrees with the aggregation.
  const effectiveType = (r: ConversionRow) =>
    r.couponCode && r.couponCode.trim() ? ("influencer" as const) : classifySourceType(r);

  const filtered = sourceTypeFilter ? rows.filter((r) => sourceTypeFilter.has(effectiveType(r))) : rows;
  const result = aggregateRevenueBySource(filtered, granularity, { start, end });

  return {
    hotelId,
    attributionModel: "first_touch", // effective model (only one implemented)
    requestedAttributionModel: requestedModel,
    range: { startDate: start.toISOString(), endDate: end.toISOString() },
    ...result,
  };
}
