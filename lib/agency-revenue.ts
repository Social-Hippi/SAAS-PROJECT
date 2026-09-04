import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant";
import { TtlLruCache } from "@/lib/lru-cache";
import type { ConversionRow } from "@/lib/revenue-by-source";
import { NO_CLICK_IDS } from "@/lib/source-classifier";

// Agency-wide revenue loader (Phase R3) — fetches every conversion across ALL of
// an agency's non-deleted hotels (plus manual influencer redemptions, which have
// no TrackingEvent) as ConversionRow[] for the shared aggregation. The expensive
// DB read is cached per (agencyId, range, hotelFilter) for 60s — all three agency
// endpoints (revenue-by-source, drill-down, overview) reuse the same cached rows.
//
// Multi-tenant: agencyScopedFor injects the agencyId filter AND default-excludes
// soft-deleted hotels, so a hotelFilter that names another agency's (or a deleted)
// hotel is silently dropped at the DB level — never 403, never leaked.

export type AgencyRevenueRows = {
  rows: ConversionRow[];
  hotelNames: Map<string, string>;
  hotelIds: string[];
};

const DAY_MS = 86_400_000;
export const AGENCY_MAX_WINDOW_DAYS = 92;

function parseDate(raw: string | null, endOfDay: boolean): Date | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0));
  }
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Resolve the [start, end] window from query params (default last 30 days,
 *  span clamped to AGENCY_MAX_WINDOW_DAYS). Shared by all agency endpoints. */
export function parseAgencyWindow(params: URLSearchParams): { start: Date; end: Date } {
  const now = new Date();
  let end = parseDate(params.get("endDate"), true) ?? now;
  let start = parseDate(params.get("startDate"), false) ?? new Date(now.getTime() - 30 * DAY_MS);
  if (start > end) [start, end] = [end, start];
  if (end.getTime() - start.getTime() > AGENCY_MAX_WINDOW_DAYS * DAY_MS) {
    start = new Date(end.getTime() - AGENCY_MAX_WINDOW_DAYS * DAY_MS);
  }
  return { start, end };
}

/** Hotel filter from `?hotel=a&hotel=b` or `?hotelFilter=a,b`; undefined = all. */
export function parseHotelFilter(params: URLSearchParams): string[] | undefined {
  const multi = params.getAll("hotel");
  const csv = (params.get("hotelFilter") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ids = [...new Set([...multi, ...csv])].filter(Boolean);
  return ids.length ? ids : undefined;
}

const cache = new TtlLruCache<AgencyRevenueRows>(100, 60_000);

function cacheKey(agencyId: string, start: Date, end: Date, hotelFilter?: string[]): string {
  const hf = hotelFilter && hotelFilter.length ? [...hotelFilter].sort().join(",") : "all";
  return `${agencyId}|${start.toISOString()}|${end.toISOString()}|${hf}`;
}

export async function loadAgencyRevenueRows(
  agencyId: string,
  opts: { start: Date; end: Date; hotelFilter?: string[] },
): Promise<AgencyRevenueRows> {
  const key = cacheKey(agencyId, opts.start, opts.end, opts.hotelFilter);
  const hit = cache.get(key);
  if (hit) return hit;
  const result = await fetchAgencyRevenueRows(agencyId, opts);
  cache.set(key, result);
  return result;
}

async function fetchAgencyRevenueRows(
  agencyId: string,
  opts: { start: Date; end: Date; hotelFilter?: string[] },
): Promise<AgencyRevenueRows> {
  const { start, end, hotelFilter } = opts;

  // Active hotels for this agency (soft-deleted excluded by the scoped wrapper),
  // intersected with hotelFilter if provided. agencyId guard drops foreign ids.
  const hotels = await agencyScopedFor(agencyId, prisma.hotelClient).findMany({
    where: { deletedAt: null, ...(hotelFilter && hotelFilter.length ? { id: { in: hotelFilter } } : {}) },
    select: { id: true, name: true },
  });
  const hotelNames = new Map(hotels.map((h) => [h.id, h.name]));
  const hotelIds = hotels.map((h) => h.id);
  if (hotelIds.length === 0) return { rows: [], hotelNames, hotelIds };

  // Conversions (snippet/UTM) + manual redemptions, in parallel (PART 8).
  const [events, manual] = await Promise.all([
    agencyScopedFor(agencyId, prisma.trackingEvent).findMany({
      where: { eventType: "conversion", hotelClientId: { in: hotelIds }, createdAt: { gte: start, lte: end } },
      select: {
        utmSource: true, utmMedium: true, utmCampaign: true, utmContent: true,
        conversionValue: true, couponCodeUsed: true, createdAt: true, hotelClientId: true,
        gclid: true, gbraid: true, wbraid: true, fbclid: true,
      },
    }),
    agencyScopedFor(agencyId, prisma.influencerRedemption).findMany({
      where: {
        redemptionSource: "manual_entry",
        hotelClientId: { in: hotelIds },
        OR: [
          { bookingDate: { gte: start, lte: end } },
          { AND: [{ bookingDate: null }, { redeemedAt: { gte: start, lte: end } }] },
        ],
      },
      select: { bookingValue: true, bookingDate: true, redeemedAt: true, hotelClientId: true, couponCode: { select: { code: true } } },
    }),
  ]);

  const rows: ConversionRow[] = [
    ...events.map((e) => ({
      utmSource: e.utmSource,
      utmMedium: e.utmMedium,
      utmCampaign: e.utmCampaign,
      utmContent: e.utmContent,
      value: e.conversionValue == null ? 0 : Number(e.conversionValue),
      occurredAt: e.createdAt,
      couponCode: e.couponCodeUsed,
      hotelClientId: e.hotelClientId,
      gclid: e.gclid, gbraid: e.gbraid, wbraid: e.wbraid, fbclid: e.fbclid,
    })),
    // Manual redemptions only — snippet_auto already counted via their TrackingEvent.
    ...manual.map((m) => ({
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmContent: null,
      value: Number(m.bookingValue),
      occurredAt: m.bookingDate ?? m.redeemedAt,
      couponCode: m.couponCode?.code ?? "manual",
      // Off-snippet booking — no TrackingEvent, so genuinely no click id.
      ...NO_CLICK_IDS,
      hotelClientId: m.hotelClientId,
    })),
  ];

  return { rows, hotelNames, hotelIds };
}
