import { prisma } from "@/lib/prisma";
import { rateLimit, clientIpFromHeaders } from "@/lib/ratelimit";
import { logSnippetRejection } from "@/lib/install-health";

// Public endpoint hit cross-origin by the tracking snippet (t.js) on hotel
// websites. Returns ONLY the conversion config for the one hotel identified by
// its public, unguessable siteId — no agency data is ever exposed. Resilient:
// validates input and never throws.

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  const siteId = new URL(request.url).searchParams.get("id");
  if (!siteId) {
    return Response.json({ error: "Missing id" }, { status: 400, headers: CORS });
  }

  // Cross-instance flood guard (per site+IP). Fails OPEN on a store outage so the
  // snippet keeps working; CORS headers stay on the 429 for the cross-origin call.
  const rl = await rateLimit("trackConfig", `${siteId}:${clientIpFromHeaders(request.headers)}`);
  if (!rl.ok) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { ...CORS, "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let hotel;
  try {
    hotel = await prisma.hotelClient.findUnique({
      where: { siteId },
      select: {
        conversionMethod: true,
        thankYouUrlPattern: true,
        successPhrase: true,
        successSelector: true,
        // Cross-domain handoff: hosts the snippet may decorate outbound links
        // to, and may accept an inbound journey token from. Public by design —
        // these are the hotel's own booking-engine hostnames, not secrets.
        bookingDomains: true,
      },
    });
  } catch {
    return Response.json({ error: "Temporarily unavailable" }, { status: 503, headers: CORS });
  }

  // Reject unknown Hotel Site IDs.
  //
  // A rejection here is almost always a BROKEN INSTALL, not an attack: a siteId
  // mistyped into a site's template silently drops 100% of that site's traffic,
  // and nothing else in the product surfaces it. (Aster Holidays shipped
  // `cmru6bnm00010416vl4yiwa6` on its booking engine — the real id with `o`
  // read as `0` and `l` as `1` — and every event from that host was discarded
  // for weeks with no signal to the agency.)
  //
  // So we log it, with the Origin, so a misconfigured install is greppable.
  // The id is redacted to head/tail: enough to recognise a near-miss of a real
  // siteId, not enough to publish a working one from logs. We deliberately do
  // NOT write a row here — this endpoint is public and unauthenticated, so
  // persisting per-rejection records would let anyone amplify writes at will.
  if (!hotel) {
    await logSnippetRejection({
      siteId,
      headers: request.headers,
      reason: "unknown_site_id",
      endpoint: "track/config",
    });
    return Response.json({ error: "Unknown site id" }, { status: 403, headers: CORS });
  }

  return Response.json(
    {
      method: hotel.conversionMethod,
      thankYouUrlPattern: hotel.thankYouUrlPattern,
      successPhrase: hotel.successPhrase,
      successSelector: hotel.successSelector,
      // Reserved for a future "value pattern" config field; the snippet also
      // falls back to a [data-ht-value] element when this is null.
      valueSelector: null,
      bookingDomains: hotel.bookingDomains ?? [],
    },
    {
      status: 200,
      headers: { ...CORS, "Cache-Control": "public, max-age=300, s-maxage=300" },
    },
  );
}
