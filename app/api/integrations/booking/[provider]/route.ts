import { createHash, timingSafeEqual } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { rateLimit, clientIpFromHeaders } from "@/lib/ratelimit";
import { getBookingProvider } from "@/lib/booking-provider";
import { ingestBookingEvents } from "@/lib/booking-ingest";
import { getTokenForApiCall } from "@/lib/token-access";
import "@/lib/booking-providers/simplotel";

// ─────────────────────────────────────────────────────────────────────────────
// Booking Push receiver — the provider -> HotelTrack boundary.
//
// This is the ONLY way a booking enters HotelTrack. It is deliberately narrow:
//
//   • POST only, JSON only, size-capped
//   • AUTHENTICATED before the body is read — a bearer secret unique to one
//     BookingConnection, compared in constant time
//   • TENANT COMES FROM THE SECRET, never from the body. A push cannot name the
//     agency or hotel it wants to write to; it can only prove which connection
//     it is, and the connection determines the tenant
//   • idempotent, via the existing ingestion service
//   • no PII and no credential material in any log line
//
// It is NOT a generic unauthenticated webhook. An unknown provider slug 404s
// before anything else happens.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

/** Bodies above this are refused unread — a booking push is a few KB. */
const MAX_BODY_BYTES = 256 * 1024;

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Constant-time compare that never leaks length through early return. */
function secretMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Bearer token, or null. Accepts only the Authorization header. */
function bearerFrom(headers: Headers): string | null {
  const raw = headers.get("authorization");
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  const token = m?.[1]?.trim();
  return token ? token : null;
}

/** One structured line. Never the secret, never guest PII, never the body. */
function logPush(fields: Record<string, unknown>) {
  console.info("[BOOKING-PUSH]", JSON.stringify({ at: new Date().toISOString(), ...fields }));
}

export async function POST(request: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider: rawProvider } = await ctx.params;
  const provider = String(rawProvider ?? "").trim().toLowerCase();

  // 1. Unknown provider — 404 before any credential work.
  const adapter = getBookingProvider(provider);
  if (!adapter || !adapter.capabilities.webhook) {
    logPush({ provider, outcome: "unknown_provider" });
    return json(404, { error: "Unknown provider" });
  }

  // 2. Flood guard, keyed by provider + caller.
  const rl = await rateLimit("webhook", `booking:${provider}:${clientIpFromHeaders(request.headers)}`);
  if (!rl.ok) return json(429, { error: "Too many requests" });

  // 3. Authentication BEFORE the body is touched.
  const presented = bearerFrom(request.headers);
  if (!presented) {
    logPush({ provider, outcome: "missing_auth" });
    return json(401, { error: "Missing Authorization" });
  }

  // 4. Resolve the connection from the secret. Every enabled connection for this
  //    provider is checked in constant time; the FIRST match defines the tenant.
  //    The body has no say in which agency or hotel is written to.
  let connections: { id: string; agencyId: string; hotelClientId: string; provider: string }[];
  try {
    connections = await prisma.bookingConnection.findMany({
      where: { provider, status: { not: "disabled" } },
      select: { id: true, agencyId: true, hotelClientId: true, provider: true },
    });
  } catch {
    return json(503, { error: "Temporarily unavailable" });
  }

  let connection: (typeof connections)[number] | null = null;
  for (const c of connections) {
    let secret: string | null = null;
    try {
      const token = await getTokenForApiCall("booking_provider", c.id, {
        agencyId: c.agencyId,
        hotelClientId: c.hotelClientId,
        source: "booking_push",
      });
      secret = token.reveal();
    } catch {
      continue; // unreadable or unset credential — this connection cannot authenticate
    }
    if (secret && secretMatches(presented, secret)) {
      connection = c;
      break;
    }
  }

  if (!connection) {
    logPush({ provider, outcome: "invalid_auth" });
    return json(403, { error: "Invalid credentials" });
  }

  // 5. Content type + size.
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    logPush({ provider, connectionId: connection.id, outcome: "bad_content_type" });
    return json(415, { error: "Expected application/json" });
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json(400, { error: "Unreadable body" });
  }
  if (rawBody.length > MAX_BODY_BYTES) {
    logPush({ provider, connectionId: connection.id, outcome: "body_too_large", bytes: rawBody.length });
    return json(413, { error: "Body too large" });
  }
  try {
    JSON.parse(rawBody);
  } catch {
    logPush({ provider, connectionId: connection.id, outcome: "malformed_json" });
    return json(400, { error: "Malformed JSON" });
  }

  // 6. Optional provider signature, when the adapter implements one.
  if (adapter.verifyWebhook) {
    let verified = false;
    try {
      const token = await getTokenForApiCall("booking_provider", connection.id, {
        agencyId: connection.agencyId,
        hotelClientId: connection.hotelClientId,
        source: "booking_push_signature",
      });
      verified = adapter.verifyWebhook(rawBody, request.headers, token.reveal());
    } catch {
      verified = false;
    }
    if (!verified) {
      logPush({ provider, connectionId: connection.id, outcome: "bad_signature" });
      return json(403, { error: "Signature verification failed" });
    }
  }

  // 7. Provider-specific mapping. Until Simplotel supplies a payload sample this
  //    refuses every body — see lib/booking-providers/simplotel.ts. A guessed
  //    mapping would produce confident, wrong bookings.
  if (!adapter.parseWebhook) {
    return json(501, { error: "Provider cannot parse webhooks" });
  }
  const parsed = adapter.parseWebhook(rawBody, request.headers);
  if (!parsed.ok) {
    logPush({ provider, connectionId: connection.id, outcome: "unmapped_payload", reason: parsed.error });
    return json(422, { error: parsed.error });
  }
  if (!parsed.value.length) {
    logPush({ provider, connectionId: connection.id, outcome: "no_events" });
    return json(204, {});
  }

  // 8. Ingest. Idempotency, lifecycle history and journey matching all live in
  //    the existing service — this route adds none of its own.
  const batch = await ingestBookingEvents(connection, parsed.value);
  const results = batch.results;
  const accepted = batch.succeeded;
  const rejected = batch.failed;

  logPush({
    provider,
    connectionId: connection.id,
    hotelClientId: connection.hotelClientId,
    outcome: rejected ? "partial" : "accepted",
    events: results.length,
    accepted,
    rejected,
    // Match methods only — never guest identifiers.
    matches: results.map((r) => (r.ok ? (r.match?.method ?? null) : null)).filter(Boolean),
  });

  if (accepted === 0) {
    return json(422, {
      error: "No event could be ingested",
      details: results.flatMap((r) => (r.ok ? [] : r.errors)),
    });
  }
  return json(200, { accepted, rejected });
}

/** Anything but POST. */
export async function GET() {
  return json(405, { error: "Method not allowed" });
}
