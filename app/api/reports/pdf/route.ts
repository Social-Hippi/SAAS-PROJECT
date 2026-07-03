import { getCurrentMember } from "@/lib/auth";
import { rateLimit, tooManyRequests } from "@/lib/ratelimit";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { resolveRange } from "@/lib/attribution";
import { slugForFile } from "@/lib/csv";
import { generateHotelReportPdf } from "@/lib/report-pdf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Server-side PDF report for one hotel over the selected range. Multi-tenant:
// the hotel must belong to the caller's agency (agency-scoped lookup → 404 for
// anyone else), and every query inside generateHotelReportPdf is agency-scoped
// too. The PDF is streamed as an attachment — never stored publicly.

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

  // Ownership guard — the report can only ever be generated for THIS agency's hotel.
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true, name: true, websiteUrl: true, funnelStageRules: true },
  });
  if (!hotel) return Response.json({ error: "Not found" }, { status: 404 });

  // Agency identity + public contact for the header/footer (the caller's own agency).
  const agency = await prisma.agency.findUnique({
    where: { id: member.agencyId },
    select: { name: true, contactEmail: true, mobile: true, websiteUrl: true },
  });

  const range = resolveRange({ from, to });

  const pdf = await generateHotelReportPdf({
    agencyId: member.agencyId,
    hotelId: hotel.id,
    hotelName: hotel.name,
    websiteUrl: hotel.websiteUrl,
    funnelStageRules: hotel.funnelStageRules,
    agencyName: agency?.name ?? "Your agency",
    agencyContact: {
      contactEmail: agency?.contactEmail ?? null,
      mobile: agency?.mobile ?? null,
      websiteUrl: agency?.websiteUrl ?? null,
    },
    rangeLabel: range.label,
    from: range.fromInput,
    to: range.toInput,
    since: range.since,
    until: range.until,
    generatedAt: new Date().toLocaleDateString("en-IN"),
  });

  // Record the report (same metadata row as the CSV/Excel exports), agency-scoped.
  await agencyScoped(prisma.report).create({
    data: {
      agencyId: member.agencyId,
      hotelClientId: hotel.id,
      dateRangeStart: range.since,
      dateRangeEnd: range.until,
    },
  });

  const filename = `HotelTrack-${slugForFile(hotel.name)}-${range.toInput}.pdf`;
  return new Response(Buffer.from(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
