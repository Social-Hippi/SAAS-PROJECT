import * as XLSX from "xlsx";
import { getCurrentMember } from "@/lib/auth";
import { rateLimit, tooManyRequests } from "@/lib/ratelimit";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { sanitizeAoa, sanitizeRows } from "@/lib/xlsx";
import {
  resolveRange,
  computeContentPerformance,
  computeAdsSummary,
  trueRoi,
  contentIdFromUtmContent,
  type EventInput,
} from "@/lib/attribution";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "report";

export async function GET(request: Request) {
  const member = await getCurrentMember();
  if (!member) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // Throttle expensive report generation per signed-in member. Fails OPEN so a
  // store outage never blocks a paying user's export.
  const rl = await rateLimit("export", member.id);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const url = new URL(request.url);
  const hotelId = url.searchParams.get("hotelId") ?? "";
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;

  // Multi-tenant: hotel must belong to this agency.
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true, name: true, timezone: true },
  });
  if (!hotel) return Response.json({ error: "Not found" }, { status: 404 });

  const range = resolveRange({ from, to }, { timezone: hotel.timezone });

  const [content, events, snapshots] = await Promise.all([
    agencyScoped(prisma.contentPiece).findMany({
      where: { hotelClientId: hotel.id },
      select: { id: true, title: true, contentType: true, platform: true, couponCode: true, influencerName: true },
    }),
    agencyScoped(prisma.trackingEvent).findMany({
      where: {
        hotelClientId: hotel.id,
        createdAt: { gte: range.since, lte: range.until },
      },
      orderBy: { createdAt: "asc" },
      select: {
        createdAt: true,
        eventType: true,
        utmSource: true,
        utmMedium: true,
        utmCampaign: true,
        utmContent: true,
        gclid: true, gbraid: true, wbraid: true, fbclid: true,
        sessionId: true,
        deviceType: true,
        conversionValue: true,
        pageUrl: true,
      },
    }),
    agencyScoped(prisma.adSnapshot).findMany({
      where: { hotelClientId: hotel.id, archived: false, date: { gte: range.since, lte: range.until } },
      orderBy: { date: "asc" },
      select: { date: true, spend: true, conversions: true, roas: true },
    }),
  ]);

  const contentIds = content.map((c) => c.id);
  const redemptionRows =
    contentIds.length > 0
      ? await agencyScoped(prisma.couponRedemption).findMany({
          where: {
            contentPieceId: { in: contentIds },
            redemptionDate: { gte: range.since, lte: range.until },
          },
          orderBy: { redemptionDate: "asc" },
          select: { contentPieceId: true, redemptionDate: true, orderValue: true },
        })
      : [];

  const titleById = new Map(content.map((c) => [c.id, c.title]));
  const metaById = new Map(content.map((c) => [c.id, c]));
  const validIds = new Set(contentIds);

  const eventInputs: EventInput[] = events.map((e) => ({
    eventType: e.eventType,
    utmSource: e.utmSource,
    utmMedium: e.utmMedium,
    utmContent: e.utmContent,
    utmCampaign: e.utmCampaign,
    sessionId: e.sessionId,
    conversionValue: e.conversionValue == null ? null : Number(e.conversionValue),
    gclid: e.gclid, gbraid: e.gbraid, wbraid: e.wbraid, fbclid: e.fbclid,
  }));

  // ── Sheet 1: Daily visits/bookings by source ──
  type DayAgg = { Date: string; Source: string; Visits: number; Bookings: number; Revenue: number };
  const dayMap = new Map<string, DayAgg>();
  for (const e of events) {
    const date = ymd(e.createdAt);
    const source = e.utmSource ?? "direct";
    const key = `${date}|${source}`;
    const row = dayMap.get(key) ?? { Date: date, Source: source, Visits: 0, Bookings: 0, Revenue: 0 };
    if (e.eventType === "visit") row.Visits += 1;
    else {
      row.Bookings += 1;
      row.Revenue += e.conversionValue == null ? 0 : Number(e.conversionValue);
    }
    dayMap.set(key, row);
  }
  const dailyRows = [...dayMap.values()].sort(
    (a, b) => a.Date.localeCompare(b.Date) || a.Source.localeCompare(b.Source),
  );
  const ws1 = XLSX.utils.json_to_sheet(
    sanitizeRows(
      dailyRows.length ? dailyRows : [{ Date: "", Source: "", Visits: 0, Bookings: 0, Revenue: 0 }],
    ),
  );

  // ── Sheet 2: Campaign-level ad performance (+ ad totals) ──
  const ads = computeAdsSummary(snapshots.map((s) => ({ date: s.date, spend: Number(s.spend), conversions: s.conversions, roas: s.roas })));
  const perf = computeContentPerformance(
    content.map((c) => ({ id: c.id, title: c.title, contentType: c.contentType, platform: c.platform, couponCode: c.couponCode, influencerName: c.influencerName })),
    eventInputs,
  );
  const paid = perf.filter((c) => c.contentType === "paid_ad");
  const realAdRevenue = paid.reduce((s, c) => s + c.revenue, 0);
  const roi = trueRoi(realAdRevenue, ads.spend);
  const adsAoa: (string | number)[][] = [
    ["Date range", `${range.fromInput} to ${range.toInput}`],
    ["Total Meta ad spend", Number(ads.spend.toFixed(2))],
    ["Bookings from ads (Meta-reported)", ads.bookingsFromAds],
    ["Meta ROAS", ads.metaRoas == null ? "—" : Number(ads.metaRoas.toFixed(2))],
    ["True ROI (real revenue ÷ spend)", roi == null ? "—" : `${(roi * 100).toFixed(1)}%`],
    [],
    ["Campaign", "Clicks", "Sessions", "Bookings", "Revenue"],
    ...paid.map((c) => [c.title, c.clicks, c.sessions, c.bookings, Number(c.revenue.toFixed(2))]),
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(sanitizeAoa(adsAoa));

  // ── Sheet 3: Influencer coupon redemptions ──
  const redRows = redemptionRows.map((r) => {
    const c = metaById.get(r.contentPieceId);
    return {
      Influencer: c?.influencerName ?? "—",
      Coupon: c?.couponCode ?? "—",
      Content: c?.title ?? r.contentPieceId,
      "Redemption Date": ymd(r.redemptionDate),
      "Order Value": Number(Number(r.orderValue).toFixed(2)),
    };
  });
  const ws3 = XLSX.utils.json_to_sheet(
    sanitizeRows(
      redRows.length
        ? redRows
        : [{ Influencer: "", Coupon: "", Content: "", "Redemption Date": "", "Order Value": 0 }],
    ),
  );

  // ── Sheet 4: Full event log ──
  const logRows = events.map((e) => {
    const cid = contentIdFromUtmContent(e.utmContent, validIds);
    return {
      "Date/Time": e.createdAt.toISOString().replace("T", " ").slice(0, 19),
      Type: e.eventType,
      Source: e.utmSource ?? "",
      Medium: e.utmMedium ?? "",
      Campaign: e.utmCampaign ?? "",
      Content: cid ? (titleById.get(cid) ?? "") : (e.utmContent ?? ""),
      "Page URL": e.pageUrl,
      Session: e.sessionId,
      Device: e.deviceType,
      Value: e.conversionValue == null ? "" : Number(Number(e.conversionValue).toFixed(2)),
    };
  });
  const ws4 = XLSX.utils.json_to_sheet(
    sanitizeRows(
      logRows.length
        ? logRows
        : [{ "Date/Time": "", Type: "", Source: "", Medium: "", Campaign: "", Content: "", "Page URL": "", Session: "", Device: "", Value: "" }],
    ),
  );

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, "Daily by Source");
  XLSX.utils.book_append_sheet(wb, ws2, "Ad Performance");
  XLSX.utils.book_append_sheet(wb, ws3, "Influencer Redemptions");
  XLSX.utils.book_append_sheet(wb, ws4, "Event Log");
  const buffer: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  // Record the report (same as the PDF flow does via a server action).
  await agencyScoped(prisma.report).create({
    data: {
      agencyId: member.agencyId,
      hotelClientId: hotel.id,
      dateRangeStart: range.since,
      dateRangeEnd: range.until,
    },
  });

  const filename = `HotelTrack-${slug(hotel.name)}-${range.toInput}.xlsx`;
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
