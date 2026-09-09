import { requireReadAccess } from "@/lib/hotel-auth";
import { runWithAgencyScope } from "@/lib/tenant";
import { TtlLruCache } from "@/lib/lru-cache";
import { parseAgencyWindow } from "@/lib/agency-revenue";
import { loadChannelView, isChannelKey, type ChannelView } from "@/lib/channel-view";
import { stripSpendFromChannelView } from "@/lib/share-spend-gate";

// GET /api/hotel/[hotelClientId]/channel-view?channel=&startDate=&endDate= —
// hotel-owner mirror of the agency channel-view route. Same per-channel deep-dive
// payload (Meta Ads spend/CTR/CPC/CPM/campaigns, Instagram content, Facebook,
// Influencer, Direct, Other). Authorized via requireHotelOwnerAccess; reads run
// inside runWithAgencyScope so they are scoped to the owning agency + this hotel.
//
// Ad spend: a SESSION (agency member or granted hotel user) always sees full spend
// for this hotel — showAdSpendToHotel has never gated the logged-in dashboard. A
// /share/<uuid> caller is gated on that flag, and the strip happens on the way out
// so one cache entry serves both kinds of caller.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const cache = new TtlLruCache<ChannelView | null>(400, 5 * 60_000);

export async function GET(request: Request, { params }: { params: Promise<{ hotelClientId: string }> }) {
  const { hotelClientId } = await params;
  const auth = await requireReadAccess(request, hotelClientId);
  if (!auth.ok) return Response.json({ error: auth.status === 404 ? "Not found" : "Forbidden" }, { status: auth.status });
  const access = auth.access;

  const url = new URL(request.url);
  const channelParam = url.searchParams.get("channel") ?? "all";
  if (!isChannelKey(channelParam)) {
    return Response.json({ error: "Unknown channel" }, { status: 400 });
  }
  const { start, end } = parseAgencyWindow(url.searchParams);

  const key = `${hotelClientId}|${channelParam}|${start.toISOString()}|${end.toISOString()}`;
  const gate = (v: ChannelView | null) =>
    v == null ? { channel: "all" } : access.spendVisible ? v : stripSpendFromChannelView(v);

  const hit = cache.get(key);
  if (hit !== undefined) return Response.json(gate(hit));

  let data: ChannelView | null;
  try {
    data = await runWithAgencyScope(access.agencyId, () =>
      loadChannelView(hotelClientId, channelParam, start, end),
    );
  } catch {
    return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
  }

  cache.set(key, data);
  return Response.json(gate(data));
}
