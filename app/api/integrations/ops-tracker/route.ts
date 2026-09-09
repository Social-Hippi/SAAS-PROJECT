import { rateLimit, clientIpFromHeaders } from "@/lib/ratelimit";
import { ingestTrackerPayload, secretMatches } from "@/lib/ops-tracker/ingest";

// POST /api/integrations/ops-tracker
//
// Called by a Google Apps Script bound to a property's operations workbook, on an
// installable onChange trigger. Public in proxy.ts because Apps Script carries no
// Clerk session; the shared secret is the credential.
//
// THE SECRET IS THE ONLY AUTH, so it is compared in constant time and never
// logged, never echoed, and never named in an error body. A wrong secret and a
// missing secret answer identically — telling a caller which one they got wrong
// is a free bit of information about a credential.
//
// The response is a JSON summary the Apps Script logs, so whoever maintains the
// sheet can see which rows were refused and why without reading server logs they
// have no access to.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const secret = process.env.OPS_TRACKER_INGEST_SECRET;
  if (!secret) {
    // Deliberately a 500: this is a server misconfiguration, not a bad request,
    // and answering 401 would send someone hunting for a credential problem that
    // does not exist.
    return Response.json(
      { ok: false, error: "Ingest is not configured on the server." },
      { status: 500 },
    );
  }

  if (!secretMatches(request.headers.get("x-ingest-secret"), secret)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Authenticated callers only, so the limit is a guard against a misconfigured
  // trigger rather than an anonymous flood. Fails OPEN — a store outage must not
  // stop a property recording its own day.
  const rl = await rateLimit("opsTrackerIngest", clientIpFromHeaders(request.headers));
  if (!rl.ok) {
    return Response.json(
      { ok: false, error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Body must be JSON." }, { status: 400 });
  }
  if (typeof payload !== "object" || payload === null) {
    return Response.json({ ok: false, error: "Body must be a JSON object." }, { status: 400 });
  }

  try {
    const outcome = await ingestTrackerPayload(payload);
    return Response.json(outcome.body, { status: outcome.status });
  } catch {
    // Never leak an internal message to a caller holding only a shared secret.
    return Response.json({ ok: false, error: "Temporarily unavailable" }, { status: 503 });
  }
}
