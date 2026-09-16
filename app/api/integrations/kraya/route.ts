import { timingSafeEqual } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { getTokenForApiCall } from "@/lib/token-access";
import { rateLimit, clientIpFromHeaders } from "@/lib/ratelimit";
import { parseKrayaLead } from "@/lib/kraya-webhook";
import { ingestKrayaLead } from "@/lib/kraya-ingest";

// ─────────────────────────────────────────────────────────────────────────────
// Kraya lead webhook.
//
// Kraya fires on every lead upsert — a new enquiry and a stage change look the
// same from here. Most payloads are enquiries; one stage per hotel also produces
// a booking.
//
// THE SECRET IS THE TENANT. Kraya sends it in X-KRAYA-WEBHOOK-SECRET, and every
// enabled connection's stored secret is compared in constant time. The FIRST
// match defines the hotel — the body has no say in which agency is written to.
//
// ALWAYS 200 WHEN THE SECRET IS VALID. Kraya retries only TWICE before dropping
// a payload for good, and there is no read API to catch up with — so a lead we
// cannot parse is acknowledged and counted, never retried into oblivion. The one
// exception is a database failure, which IS worth one of those two retries.
//
// Kraya expects a response within 60 seconds.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_BYTES = 256 * 1024;

function secretMatches(presented: string, stored: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(stored);
  // Length first: timingSafeEqual throws on a mismatch, and a thrown comparison
  // is a 500 — which Kraya would retry, then drop.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const presented = request.headers.get("x-kraya-webhook-secret")?.trim();
  if (!presented) {
    return Response.json({ error: "Missing webhook secret" }, { status: 401 });
  }

  const rl = await rateLimit("webhook", `kraya:${clientIpFromHeaders(request.headers)}`);
  if (!rl.ok) return Response.json({ error: "Too many requests" }, { status: 429 });

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Body too large" }, { status: 413 });
  }

  // Resolve the tenant from the secret alone.
  let connections: {
    id: string;
    agencyId: string;
    hotelClientId: string;
    confirmedStageName: string | null;
  }[];
  try {
    connections = await prisma.krayaConnection.findMany({
      where: { status: { not: "disconnected" } },
      select: { id: true, agencyId: true, hotelClientId: true, confirmedStageName: true },
    });
  } catch {
    return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
  }

  let tenant: (typeof connections)[number] | null = null;
  for (const c of connections) {
    let stored: string | null = null;
    try {
      const token = await getTokenForApiCall("kraya_webhook", c.id, {
        agencyId: c.agencyId,
        hotelClientId: c.hotelClientId,
        source: "kraya_webhook",
      });
      stored = token.reveal();
    } catch {
      continue; // unreadable or unset credential — cannot authenticate this one
    }
    if (stored && secretMatches(presented, stored)) {
      tenant = c;
      break;
    }
  }

  if (!tenant) return Response.json({ error: "Invalid credentials" }, { status: 403 });

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ ok: true, skipped: "unparseable" });
  }

  const lead = parseKrayaLead(payload);
  if (!lead) return Response.json({ ok: true, skipped: "not a usable lead" });

  try {
    const result = await ingestKrayaLead({ ...tenant, connectionId: tenant.id }, lead);
    await prisma.krayaConnection.update({
      where: { id: tenant.id },
      data: { lastLeadReceivedAt: new Date(), status: "active", lastError: null },
    });
    return Response.json({ ok: true, ...(result ?? { skipped: "unusable phone" }) });
  } catch {
    // Worth one of Kraya's two retries.
    return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
  }
}

/** Anything but POST. */
export async function GET() {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
