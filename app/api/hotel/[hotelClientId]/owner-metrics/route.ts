import { requireReadAccess } from "@/lib/hotel-auth";
import { runWithAgencyScope } from "@/lib/tenant";
import { TtlLruCache } from "@/lib/lru-cache";
import { parseAgencyWindow } from "@/lib/agency-revenue";
import { loadOwnerMetrics, type OwnerMetrics } from "@/lib/owner-metrics";
import { stripSpendFromOwnerMetrics } from "@/lib/share-spend-gate";

// GET /api/hotel/[hotelClientId]/owner-metrics?startDate=&endDate= — hotel-owner
// mirror of the agency owner-metrics route. Authorized via requireReadAccess (a
// Clerk session OR a /share/<uuid> token); reads run inside runWithAgencyScope so
// every query is scoped to the owning agency + this hotel only.
//
// Spend is stripped on the way OUT, not on the way in, so the cache stays shared
// between a spend-visible and a spend-hidden caller: it holds the full metrics
// and each response is gated per request. Keying the cache on the flag instead
// would double every entry to no benefit.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const cache = new TtlLruCache<OwnerMetrics>(200, 5 * 60_000);

export async function GET(request: Request, { params }: { params: Promise<{ hotelClientId: string }> }) {
  const { hotelClientId } = await params;
  const auth = await requireReadAccess(request, hotelClientId);
  if (!auth.ok) return Response.json({ error: auth.status === 404 ? "Not found" : "Forbidden" }, { status: auth.status });
  const access = auth.access;

  const { start, end } = parseAgencyWindow(new URL(request.url).searchParams);

  const key = `${hotelClientId}|${start.toISOString()}|${end.toISOString()}`;
  const hit = cache.get(key);
  if (hit) return Response.json(access.spendVisible ? hit : stripSpendFromOwnerMetrics(hit));

  let metrics: OwnerMetrics;
  try {
    metrics = await runWithAgencyScope(access.agencyId, () => loadOwnerMetrics(hotelClientId, start, end));
  } catch {
    return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
  }

  cache.set(key, metrics);
  return Response.json(access.spendVisible ? metrics : stripSpendFromOwnerMetrics(metrics));
}
