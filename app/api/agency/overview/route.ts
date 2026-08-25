import { getCurrentMember } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant";
import { loadAgencyRevenueRows, parseAgencyWindow, parseHotelFilter } from "@/lib/agency-revenue";
import { aggregateRevenueBySource, rowSourceKey, rowSourceType, type ConversionRow } from "@/lib/revenue-by-source";
import { getSpendByPlatformForHotels, safeRoas } from "@/lib/ad-spend";
import { isPaidSourceType } from "@/lib/source-classifier";

// GET /api/agency/overview — the "first thing you see" agency KPIs for the period:
// total revenue/bookings, ad spend + ROAS, active vs total hotels, top
// source/hotel/influencer, and period-over-period revenue growth. Agency-scoped;
// soft-deleted hotels excluded; ROAS is null when there's no ad spend.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sumRevenue(rows: ConversionRow[]): number {
  let t = 0;
  for (const r of rows) if (Number.isFinite(r.value) && r.value > 0) t += r.value;
  return t;
}

export async function GET(request: Request) {
  const member = await getCurrentMember();
  if (!member) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const agencyId = member.agencyId;

  const url = new URL(request.url);
  const { start, end } = parseAgencyWindow(url.searchParams);
  const hotelFilter = parseHotelFilter(url.searchParams);

  // Same-length immediately-preceding window for period-over-period.
  const spanMs = end.getTime() - start.getTime();
  const prevStart = new Date(start.getTime() - spanMs - 1);
  const prevEnd = new Date(start.getTime() - 1);

  let cur, prev, totalHotelsCount;
  try {
    [cur, prev, totalHotelsCount] = await Promise.all([
      loadAgencyRevenueRows(agencyId, { start, end, hotelFilter }),
      loadAgencyRevenueRows(agencyId, { start: prevStart, end: prevEnd, hotelFilter }),
      agencyScopedFor(agencyId, prisma.hotelClient).count({ where: { deletedAt: null } }),
    ]);
  } catch {
    return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
  }

  const inScope = cur.hotelIds;
  const [paidSpend, topInfGroups] = await Promise.all([
    // Phase 0: canonical paid spend across BOTH platforms for the hotels in
    // scope. This used to be a Meta-only AdSnapshot sum called "totalAdSpend".
    getSpendByPlatformForHotels(agencyId, inScope, start, end),
    inScope.length
      ? agencyScopedFor(agencyId, prisma.influencerRedemption).groupBy({
          by: ["influencerId"],
          where: {
            hotelClientId: { in: inScope },
            // Phase 0: match the basis of totalRevenue. loadAgencyRevenueRows
            // UNIONs ONLY manual_entry redemptions (snippet_auto ones are already
            // counted through their TrackingEvent), so grouping every redemption
            // here made topInfluencer.revenue irreconcilable with totalRevenue.
            redemptionSource: "manual_entry",
            redeemedAt: { gte: start, lte: end },
          },
          _sum: { bookingValue: true },
        })
      : Promise.resolve([] as { influencerId: string; _sum: { bookingValue: unknown } }[]),
  ]);

  // totalRevenue keeps its meaning EXACTLY as before: all tracked booking
  // revenue across the agency's hotels. It is a revenue figure, not a ROAS
  // numerator — that was the bug.
  const totalRevenue = sumRevenue(cur.rows);
  const totalBookings = cur.rows.length;
  const totalAdSpend = paidSpend.total;

  // Paid-attributed revenue: the only revenue an ad spend denominator may see.
  let paidRevenue = 0;
  for (const r of cur.rows) {
    if (!Number.isFinite(r.value) || r.value <= 0) continue;
    if (isPaidSourceType(rowSourceType(r))) paidRevenue += r.value;
  }

  const roas = safeRoas(paidRevenue, totalAdSpend);
  const blendedRoas = safeRoas(totalRevenue, totalAdSpend);

  const activeHotels = new Set(cur.rows.map((r) => r.hotelClientId).filter(Boolean));
  const prevRevenue = sumRevenue(prev.rows);
  const periodOverPeriodGrowth =
    prevRevenue > 0 ? ((totalRevenue - prevRevenue) / prevRevenue) * 100 : null;

  // Top source (by revenue) reuses the shared aggregation.
  const agg = aggregateRevenueBySource(cur.rows, "source", { start, end });
  const topSource = agg.topSource ? { key: agg.topSource.key, revenue: agg.topSource.revenue } : null;

  // Top hotel (by revenue).
  const byHotel = new Map<string, number>();
  for (const r of cur.rows) {
    if (!r.hotelClientId) continue;
    const v = Number.isFinite(r.value) && r.value > 0 ? r.value : 0;
    byHotel.set(r.hotelClientId, (byHotel.get(r.hotelClientId) ?? 0) + v);
  }
  let topHotel: { hotelClientId: string; name: string; revenue: number } | null = null;
  for (const [hid, rev] of byHotel) {
    if (!topHotel || rev > topHotel.revenue) topHotel = { hotelClientId: hid, name: cur.hotelNames.get(hid) ?? "—", revenue: rev };
  }

  // Top influencer (by attributed redemption revenue), if any.
  let topInfluencer: { influencerId: string; name: string; revenue: number } | null = null;
  for (const g of topInfGroups) {
    const rev = Number(g._sum.bookingValue ?? 0);
    if (!topInfluencer || rev > topInfluencer.revenue) topInfluencer = { influencerId: g.influencerId, name: "", revenue: rev };
  }
  if (topInfluencer) {
    const inf = await agencyScopedFor(agencyId, prisma.influencer).findFirst({
      where: { id: topInfluencer.influencerId },
      select: { name: true },
    });
    topInfluencer.name = inf?.name ?? "—";
  }

  // Per-hotel performance (ROW 5): revenue, bookings, top source, last booking.
  const perHotel = new Map<string, { revenue: number; bookings: number; bySource: Map<string, number>; last: number }>();
  for (const r of cur.rows) {
    if (!r.hotelClientId) continue;
    const v = Number.isFinite(r.value) && r.value > 0 ? r.value : 0;
    const acc = perHotel.get(r.hotelClientId) ?? { revenue: 0, bookings: 0, bySource: new Map(), last: 0 };
    acc.revenue += v;
    acc.bookings += 1;
    const sk = rowSourceKey(r);
    acc.bySource.set(sk, (acc.bySource.get(sk) ?? 0) + v);
    acc.last = Math.max(acc.last, r.occurredAt.getTime());
    perHotel.set(r.hotelClientId, acc);
  }
  const hotels = [...perHotel.entries()]
    .map(([hotelClientId, a]) => {
      let topSource: string | null = null;
      let topRev = -1;
      for (const [k, rev] of a.bySource) if (rev > topRev) ((topSource = k), (topRev = rev));
      return {
        hotelClientId,
        name: cur.hotelNames.get(hotelClientId) ?? "—",
        revenue: a.revenue,
        bookings: a.bookings,
        topSource,
        lastBookingAt: a.last > 0 ? new Date(a.last).toISOString() : null,
      };
    })
    .sort((x, y) => y.revenue - x.revenue || x.name.localeCompare(y.name));

  return Response.json({
    range: { startDate: start.toISOString(), endDate: end.toISOString() },
    totalRevenue,
    totalBookings,
    totalAdSpend,
    adSpendByPlatform: { meta: paidSpend.meta, google: paidSpend.google },
    mixedCurrency: paidSpend.mixedCurrency,
    paidRevenue,
    nonPaidRevenue: totalRevenue - paidRevenue,
    roas,
    blendedRoas,
    activeHotelsCount: activeHotels.size,
    totalHotelsCount,
    topSource,
    topHotel,
    topInfluencer,
    periodOverPeriodGrowth,
    hotels,
  });
}
