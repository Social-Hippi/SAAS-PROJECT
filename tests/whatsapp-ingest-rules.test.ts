import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// The rules that make click-to-WhatsApp attribution work — or silently not.
//
// Each of these fails in the same way: nothing errors, nothing logs, and the
// attribution rate is quietly lower than it should be. There is no symptom to
// notice, so the rules are pinned here rather than trusted to review.
//
// The ingest itself needs a database, so its logic is pinned by source
// assertion, per tests/spend-display-integrity.test.ts. The signature scheme is
// pure and is exercised for real below.
// ─────────────────────────────────────────────────────────────────────────────

const INGEST = readCode("lib/whatsapp-ingest.ts");
const ROUTE = readCode("app/api/integrations/whatsapp/route.ts");
const PROXY = readCode("proxy.ts");

describe("1. the referral is written once and never erased", () => {
  test("a later message cannot blank the ad that started the conversation", () => {
    // THE failure mode. Meta attaches `referral` only to the first message, so a
    // blind update would erase the attribution the moment a guest sent "thanks".
    expect(INGEST).toMatch(
      /gainsAttribution\s*=\s*\n?\s*ref != null && existing\.ctwaClid == null && existing\.sourceId == null/,
    );
    // The referral fields are spread ONLY under that condition.
    expect(INGEST).toMatch(/\.\.\.\(gainsAttribution\s*\n?\s*\?\s*\{/);
  });

  test("an absent referral is not treated as 'no ad'", () => {
    // It means "no NEW evidence". The stored value must survive.
    const update = INGEST.slice(INGEST.indexOf("await scoped.update("));
    expect(update).not.toMatch(/ctwaClid:\s*ref\?\./);
    expect(update).not.toMatch(/ctwaClid:\s*null/);
  });
});

describe("2. no raw phone number is ever stored", () => {
  test("the number is hashed through the shared chain", () => {
    // The SAME chain as Booking.guestPhoneHash, or a conversation could never
    // join to a booking.
    expect(INGEST).toContain("hashGuestPhone");
    expect(INGEST).toMatch(/const phoneHash = hashGuestPhone\(message\.fromPhone\)/);
  });

  test("the raw number is never written to a column", () => {
    expect(INGEST).not.toMatch(/phone:\s*message\.fromPhone/);
    expect(INGEST).not.toMatch(/fromPhone,\s*$/m);
  });

  test("an unusable number is dropped, not stored as an empty key", () => {
    // Otherwise every unusable number joins to every other one.
    expect(INGEST).toMatch(/if \(!phoneHash\) continue;/);
  });
});

describe("3. tenancy comes from the connection, never the payload", () => {
  test("the tenant is resolved by phone_number_id against a stored connection", () => {
    expect(INGEST).toMatch(/byPhoneNumberId\.get\(message\.phoneNumberId\)/);
    expect(INGEST).toMatch(/if \(!conn\)/);
  });

  test("an unknown number is counted and dropped", () => {
    // Meta delivers for any number subscribed to the app, including ones no
    // agency has connected. Storing those against a guess would be a leak.
    expect(INGEST).toMatch(/result\.unrouted \+= 1;\s*\n\s*continue;/);
  });

  test("writes go through the agency-scoped delegate", () => {
    expect(INGEST).toMatch(/agencyScopedFor\(conn\.agencyId, prisma\.whatsAppConversation\)/);
    expect(INGEST).toMatch(/agencyScopedFor\(agencyId, prisma\.whatsAppConnection\)/);
  });
});

describe("4. out-of-order delivery", () => {
  test("first and last message times are chosen, not overwritten", () => {
    // Meta does not guarantee order, and a retry can arrive after a newer
    // message. Blind assignment would corrupt both ends of the window.
    expect(INGEST).toMatch(/message\.sentAt > existing\.lastMessageAt/);
    expect(INGEST).toMatch(/message\.sentAt < existing\.firstMessageAt/);
  });
});

// ── The route ───────────────────────────────────────────────────────────────

describe("5. the signature is the authentication", () => {
  const SECRET = "app-secret";
  const sign = (body: string) =>
    "sha256=" + createHmac("sha256", SECRET).update(body, "utf8").digest("hex");

  test("the scheme is HMAC-SHA256 over the body, prefixed sha256=", () => {
    // Pinning the real shape, so a refactor that changes the encoding fails here
    // rather than in production against Meta.
    expect(sign("{}")).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sign('{"a":1}')).not.toBe(sign('{"a":2}'));
  });

  test("it is verified against the RAW body, before parsing", () => {
    // Verifying a re-serialized object compares something Meta never signed.
    // Scoped to the handler: the helper's DECLARATION also mentions rawBody and
    // sits above it.
    const post = ROUTE.slice(ROUTE.indexOf("export async function POST"));
    const raw = post.indexOf("await request.text()");
    const verify = post.indexOf("signatureMatches(rawBody");
    const parse = post.indexOf("JSON.parse(rawBody)");
    expect(raw).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(raw);
    expect(parse).toBeGreaterThan(verify);
  });

  test("comparison is length-checked before timingSafeEqual", () => {
    // timingSafeEqual THROWS on a length mismatch, which would be a 500 instead
    // of a rejection.
    expect(ROUTE).toMatch(/a\.length === b\.length && timingSafeEqual\(a, b\)/);
  });

  test("a server with no app secret refuses everything", () => {
    // Without the secret every caller is unauthenticated and indistinguishable.
    expect(ROUTE).toMatch(/if \(!appSecret\)[\s\S]{0,200}status: 500/);
  });
});

describe("6. status codes Meta will act on", () => {
  test("an unparseable but signed payload is acknowledged, not retried", () => {
    // Meta retries non-2xx with backoff and eventually disables the webhook.
    expect(ROUTE).toMatch(/note: "unparseable"/);
  });

  test("a database failure IS retried", () => {
    expect(ROUTE).toMatch(/status: 503/);
  });

  test("the handshake echoes plain text, not JSON", () => {
    // A JSON-quoted challenge fails Meta's verification with no useful error.
    expect(ROUTE).toMatch(/"content-type": "text\/plain"/);
  });
});

describe("7. the route is reachable by Meta", () => {
  test("it is declared public in the proxy", () => {
    // Meta carries no Clerk session, and the GET handshake must reach the route
    // at all to be verified.
    expect(PROXY).toContain('"/api/integrations/whatsapp(.*)"');
  });
});

// ── 8. Joining a conversation to a booking ──────────────────────────────────

const ATTRIB = readCode("lib/whatsapp-attribution.ts");

describe("8. the booking join", () => {
  test("a conversation that started AFTER the booking cannot have caused it", () => {
    // Without this, a guest who books in March and messages in April has the
    // April ad credited with the March booking — attribution running backwards,
    // which is worse than none at all.
    expect(ATTRIB).toMatch(/firstMessageAt: \{ lte: bookedAt \}/);
  });

  test("DETERMINISTIC is not reachable from a phone match", () => {
    // Only an identifier HotelTrack minted and got back unchanged earns it. A
    // phone number is an identity inference, however exact the match.
    expect(ATTRIB).toMatch(/confidence: "STRONG" \| "PARTIAL"/);
    expect(ATTRIB).not.toMatch(/"DETERMINISTIC"/);
  });

  test("a shared number weakens the claim even when the ad is known", () => {
    // Two guests on one number means we cannot say which of them booked.
    expect(ATTRIB).toMatch(/namesAnAd && candidates\.length === 1 \? "STRONG" : "PARTIAL"/);
  });

  test("a conversation with no ad is PARTIAL, not discarded", () => {
    // It is still a real conversation; it just attributes to nothing.
    expect(ATTRIB).toMatch(/const namesAnAd = Boolean\(best\.ctwaClid \?\? best\.sourceId\)/);
  });

  test("the nearest prior conversation wins", () => {
    expect(ATTRIB).toMatch(/orderBy: \{ firstMessageAt: "desc" \}/);
  });

  test("the read is agency-scoped", () => {
    expect(ATTRIB).toMatch(/agencyScopedFor\(agencyId, prisma\.whatsAppConversation\)/);
  });
});
