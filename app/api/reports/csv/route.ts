import { getCurrentMember } from "@/lib/auth";
import { rateLimit, tooManyRequests } from "@/lib/ratelimit";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { resolveRange, contentIdFromUtmContent } from "@/lib/attribution";
import { csvResponse, slugForFile, toCsv } from "@/lib/csv";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// CSV equivalent of the hotel report. CSV cannot have multiple sheets, so this
// returns the raw event log — the most useful single flat file for downstream
// pivoting in Excel/Sheets/BI tools.

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

  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true, name: true, timezone: true },
  });
  if (!hotel) return Response.json({ error: "Not found" }, { status: 404 });

  const range = resolveRange({ from, to }, { timezone: hotel.timezone });

  const [content, events] = await Promise.all([
    agencyScoped(prisma.contentPiece).findMany({
      where: { hotelClientId: hotel.id },
      select: { id: true, title: true },
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
        sessionId: true,
        deviceType: true,
        conversionValue: true,
        pageUrl: true,
      },
    }),
  ]);

  const titleById = new Map(content.map((c) => [c.id, c.title]));
  const validIds = new Set(content.map((c) => c.id));

  const rows = events.map((e) => {
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

  await agencyScoped(prisma.report).create({
    data: {
      agencyId: member.agencyId,
      hotelClientId: hotel.id,
      dateRangeStart: range.since,
      dateRangeEnd: range.until,
    },
  });

  const filename = `HotelTrack-${slugForFile(hotel.name)}-events-${range.toInput}.csv`;
  return csvResponse(toCsv(rows), filename);
}
