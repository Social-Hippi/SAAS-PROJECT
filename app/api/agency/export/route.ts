import * as XLSX from "xlsx";
import { getCurrentMember } from "@/lib/auth";
import { rateLimit, tooManyRequests } from "@/lib/ratelimit";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { csvResponse, slugForFile, toCsv } from "@/lib/csv";
import { sanitizeAoa, sanitizeRows } from "@/lib/xlsx";
import { classifySourceType, isPaidSourceType } from "@/lib/source-classifier";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Agency rollup export — mirrors what the /agency/dashboard page shows:
//   • headline KPIs (hotels, visits, bookings, revenue, total spend, ROAS) for last 30 days
//   • per-hotel table (visits / bookings / revenue / snippet status / last synced)

const THIRTY_DAYS_MS = 30 * 86_400_000;

export async function GET(request: Request) {
  const member = await getCurrentMember();
  if (!member) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // Throttle expensive report generation per signed-in member. Fails OPEN so a
  // store outage never blocks a paying user's export.
  const rl = await rateLimit("export", member.id);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const url = new URL(request.url);
  const format = (url.searchParams.get("format") ?? "xlsx").toLowerCase();
  const since = new Date(Date.now() - THIRTY_DAYS_MS);

  const [hotels, grouped, spendAgg, googleSpendAgg, paidConversions, agency] = await Promise.all([
    agencyScoped(prisma.hotelClient).findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        websiteUrl: true,
        snippetStatus: true,
        lastSyncedAt: true,
      },
    }),
    agencyScoped(prisma.trackingEvent).groupBy({
      by: ["hotelClientId", "eventType"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { conversionValue: true },
    }),
    agencyScoped(prisma.adSnapshot).aggregate({
      where: { archived: false, date: { gte: since } },
      _sum: { spend: true },
    }),
    // Phase 0: Google Ads spend — previously missing from the export's "Total
    // Ad Spend" and its ROAS denominator.
    agencyScoped(prisma.googleAdsCampaignSnapshot).aggregate({
      where: { date: { gte: since } },
      _sum: { spend: true },
    }),
    // Phase 0: row-level conversions so ROAS uses PAID revenue. The groupBy
    // above cannot classify by source.
    agencyScoped(prisma.trackingEvent).findMany({
      where: { eventType: "conversion", createdAt: { gte: since } },
      select: { utmSource: true, utmMedium: true, utmContent: true, conversionValue: true, gclid: true, gbraid: true, wbraid: true, fbclid: true, },
    }),
    // Agency is the tenant root — findFirst is scoped to the caller's own id.
    agencyScoped(prisma.agency).findFirst({ select: { name: true } }),
  ]);

  type Metric = { visits: number; bookings: number; revenue: number };
  const metrics = new Map<string, Metric>();
  for (const g of grouped) {
    const m = metrics.get(g.hotelClientId) ?? { visits: 0, bookings: 0, revenue: 0 };
    if (g.eventType === "visit") m.visits = g._count._all;
    else {
      m.bookings = g._count._all;
      m.revenue = Number(g._sum.conversionValue ?? 0);
    }
    metrics.set(g.hotelClientId, m);
  }

  const totals = [...metrics.values()].reduce(
    (acc, m) => ({
      visits: acc.visits + m.visits,
      bookings: acc.bookings + m.bookings,
      revenue: acc.revenue + m.revenue,
    }),
    { visits: 0, bookings: 0, revenue: 0 },
  );
  // Phase 0: combined paid spend, and PAID revenue ÷ paid spend (was all
  // booking revenue ÷ Meta-only spend, exported to agencies as "ROAS").
  const totalSpend = Number(spendAgg._sum.spend ?? 0) + Number(googleSpendAgg._sum.spend ?? 0);
  const paidRevenue = paidConversions.reduce(
    (sum, c) =>
      sum +
      (isPaidSourceType(classifySourceType(c)) && c.conversionValue != null
        ? Number(c.conversionValue)
        : 0),
    0,
  );
  const roas = totalSpend > 0 ? paidRevenue / totalSpend : null;

  const hotelRows = hotels.map((h) => {
    const m = metrics.get(h.id) ?? { visits: 0, bookings: 0, revenue: 0 };
    return {
      Hotel: h.name,
      Website: h.websiteUrl,
      "Snippet Status": h.snippetStatus,
      "Last Synced": h.lastSyncedAt ? h.lastSyncedAt.toISOString().slice(0, 10) : "",
      "Visits (30d)": m.visits,
      "Bookings (30d)": m.bookings,
      "Revenue (30d)": Number(m.revenue.toFixed(2)),
    };
  });

  const baseName = slugForFile(agency?.name ?? "agency") + "-dashboard-30d";

  if (format === "csv") {
    return csvResponse(toCsv(hotelRows), `${baseName}.csv`);
  }

  const summaryAoa: (string | number)[][] = [
    ["Agency", agency?.name ?? ""],
    ["Window", "Last 30 days"],
    ["Generated", new Date().toISOString().slice(0, 19).replace("T", " ")],
    [],
    ["Hotels", hotels.length],
    ["Visits", totals.visits],
    ["Bookings", totals.bookings],
    ["Revenue", Number(totals.revenue.toFixed(2))],
    ["Total Meta Ad Spend", Number(totalSpend.toFixed(2))],
    ["ROAS", roas == null ? "—" : Number(roas.toFixed(2))],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(sanitizeAoa(summaryAoa));
  const ws2 = XLSX.utils.json_to_sheet(
    sanitizeRows(
      hotelRows.length
        ? hotelRows
        : [
            {
              Hotel: "",
              Website: "",
              "Snippet Status": "",
              "Last Synced": "",
              "Visits (30d)": 0,
              "Bookings (30d)": 0,
              "Revenue (30d)": 0,
            },
          ],
    ),
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, "Summary");
  XLSX.utils.book_append_sheet(wb, ws2, "Hotels");
  const buffer: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${baseName}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
