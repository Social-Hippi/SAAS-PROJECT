import { createHmac, timingSafeEqual } from "node:crypto";

import { rateLimit, clientIpFromHeaders } from "@/lib/ratelimit";
import { parseInboundMessages, verifySubscription } from "@/lib/whatsapp-webhook";
import { ingestInboundMessages } from "@/lib/whatsapp-ingest";

// ─────────────────────────────────────────────────────────────────────────────
// Meta WhatsApp Cloud API webhook.
//
// GET  — the subscription handshake Meta performs when the URL is saved.
// POST — inbound messages, for every hotel whose number is connected to this app.
//
// ONE URL FOR EVERY HOTEL. Unlike Booking Push, the tenant is NOT resolved from
// a per-hotel secret: Meta delivers all traffic for the app to one endpoint, and
// the routing key is `value.metadata.phone_number_id` inside the payload. That
// is safe only because the id is matched against a WhatsAppConnection row that
// an agency had to create — a payload naming an unknown number is counted and
// dropped, never stored against a guess.
//
// THE SIGNATURE IS THE AUTHENTICATION. X-Hub-Signature-256 is an HMAC of the RAW
// body under the app secret, so the body must be read as text and verified
// BEFORE it is parsed — verifying a re-serialized object compares something Meta
// never signed.
//
// ALWAYS 200 ON A VALID SIGNATURE. Meta retries non-2xx with backoff and
// eventually disables a webhook that keeps failing, so a payload we cannot parse
// is acknowledged and dropped rather than retried forever. Failures are counted
// in the response body for the caller's logs, never as a status code.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Meta's cap is generous; this is a guard against a misconfigured firehose. */
const MAX_BODY_BYTES = 1024 * 1024;

function signatureMatches(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and a thrown comparison is a 500, not a rejection.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Subscription handshake. Meta calls this once, when the URL is saved. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const challenge = verifySubscription(url.searchParams, process.env.WHATSAPP_VERIFY_TOKEN);
  if (challenge == null) {
    return new Response("Forbidden", { status: 403 });
  }
  // Meta requires the challenge echoed as PLAIN TEXT — a JSON-quoted string
  // fails verification with no useful error.
  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(request: Request) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    // A server that cannot verify signatures must not accept payloads: without
    // the secret every caller is unauthenticated and indistinguishable.
    return Response.json({ error: "Webhook is not configured." }, { status: 500 });
  }

  const rl = await rateLimit("webhook", `whatsapp:${clientIpFromHeaders(request.headers)}`);
  if (!rl.ok) return Response.json({ error: "Too many requests" }, { status: 429 });

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Body too large" }, { status: 413 });
  }

  // Verified against the RAW text, before any parsing.
  if (!signatureMatches(rawBody, request.headers.get("x-hub-signature-256"), appSecret)) {
    return Response.json({ error: "Invalid signature" }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Signed but unparseable. Retrying will not help, so acknowledge.
    return Response.json({ ok: true, stored: 0, note: "unparseable" });
  }

  const messages = parseInboundMessages(payload);
  if (messages.length === 0) {
    // Statuses, account updates and other non-message events land here. Normal.
    return Response.json({ ok: true, stored: 0 });
  }

  try {
    const result = await ingestInboundMessages(messages);
    return Response.json({ ok: true, ...result });
  } catch {
    // A database failure IS worth retrying, so this one is a 503.
    return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
  }
}
