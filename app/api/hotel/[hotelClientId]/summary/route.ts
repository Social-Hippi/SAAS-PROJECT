import { requireReadAccess } from "@/lib/hotel-auth";
import { runWithAgencyScope } from "@/lib/tenant";
import { TtlLruCache } from "@/lib/lru-cache";
import { generateSummary, type Period, type SummaryResult } from "@/lib/owner-summary";

// GET /api/hotel/[hotelClientId]/summary?period=1d|7d|30d — hotel-owner mirror of
// the agency owner-summary route. Authorized via requireReadAccess (a Clerk session
// OR a /share/<uuid> token); reads run inside runWithAgencyScope so every query is
// scoped to the owning agency + hotel. A hotel owner can therefore only ever read
// their OWN hotel — a foreign id 403s.
//
// Spend gating differs from the other read routes here, and has to: this payload is
// rendered PROSE ("Meta Ads: spent X at Yx ROAS"), so it cannot be stripped after
// the fact. generateSummary takes hideSpend and writes a different sentence — which
// makes the flag part of the cache identity, hence its presence in the key below.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const cache = new TtlLruCache<SummaryResult>(100, 5 * 60_000);
const PERIODS = new Set<Period>(["1d", "7d", "30d"]);

export async function GET(request: Request, { params }: { params: Promise<{ hotelClientId: string }> }) {
  const { hotelClientId } = await params;
  const auth = await requireReadAccess(request, hotelClientId);
  if (!auth.ok) return Response.json({ error: auth.status === 404 ? "Not found" : "Forbidden" }, { status: auth.status });
  const access = auth.access;

  const raw = new URL(request.url).searchParams.get("period");
  const period: Period = PERIODS.has(raw as Period) ? (raw as Period) : "7d";

  // hideSpend changes the generated TEXT, so it must key the cache — otherwise a
  // spend-hidden reader could be served the agency's spend-quoting summary.
  const hideSpend = !access.spendVisible;
  // The audience is constant for this route ("hotel"), so only hideSpend varies.
  const key = `${hotelClientId}|${period}|${hideSpend ? "nospend" : "spend"}`;
  const hit = cache.get(key);
  if (hit) return Response.json(hit);

  let result: SummaryResult | null;
  try {
    result = await runWithAgencyScope(access.agencyId, () =>
      generateSummary(hotelClientId, period, { hideSpend, audience: "hotel" }),
    );
  } catch {
    return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
  }
  if (!result) return Response.json({ error: "Hotel not found" }, { status: 404 });

  cache.set(key, result);
  return Response.json(result);
}
