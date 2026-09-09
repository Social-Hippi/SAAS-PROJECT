import { getCurrentMember } from "@/lib/auth";
import { loadAgencyRevenueRows, parseAgencyWindow, parseHotelFilter } from "@/lib/agency-revenue";
import { aggregateRevenueBySource, isGranularity, type Granularity } from "@/lib/revenue-by-source";
import { canonicalSourceType } from "@/lib/metrics/canonical";
import { isSourceType, type SourceType } from "@/lib/source-classifier";

// GET /api/agency/revenue-by-source — the agency-wide equivalent of R1's
// per-hotel endpoint. Aggregates conversions (+ manual influencer redemptions)
// across ALL of the agency's non-deleted hotels, by source granularity.
//   ?granularity= source | source_medium | source_medium_campaign  (default source)
//   ?startDate= &endDate=                                          (default 30d)
//   ?hotel=<id>&hotel=<id>  OR  ?hotelFilter=a,b                   (default all)
//   ?sourceTypes=meta_ads,influencer,…                            (chip filter)
//
// Multi-tenant: every read is scoped to the caller's agency; a hotelFilter that
// names another agency's hotel is silently dropped (not 403).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const member = await getCurrentMember();
  if (!member) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const granularity: Granularity = isGranularity(url.searchParams.get("granularity"))
    ? (url.searchParams.get("granularity") as Granularity)
    : "source";
  const { start, end } = parseAgencyWindow(url.searchParams);
  const hotelFilter = parseHotelFilter(url.searchParams);

  const sourceTypesRaw = url.searchParams.get("sourceTypes");
  const sourceTypeFilter: Set<SourceType> | null =
    sourceTypesRaw && sourceTypesRaw !== "all"
      ? new Set(sourceTypesRaw.split(",").map((s) => s.trim()).filter(isSourceType))
      : null;

  let data;
  try {
    data = await loadAgencyRevenueRows(member.agencyId, { start, end, hotelFilter });
  } catch {
    return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
  }

  const filtered = sourceTypeFilter
    ? data.rows.filter((r) => sourceTypeFilter.has(canonicalSourceType(r)))
    : data.rows;

  const result = aggregateRevenueBySource(filtered, granularity, { start, end });

  return Response.json({
    attributionModel: "first_touch",
    range: { startDate: start.toISOString(), endDate: end.toISOString() },
    ...result,
    totals: {
      revenue: result.totals.revenue,
      bookings: result.totals.bookings,
      averageBookingValue: result.totals.averageBookingValue,
      hotelCount: data.hotelIds.length, // hotels in scope
      activeHotels: result.totals.hotelCount, // hotels with ≥1 booking in range
    },
  });
}
