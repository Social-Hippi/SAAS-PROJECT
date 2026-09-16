import { describe, expect, test } from "vitest";

import {
  parseInboundMessages,
  verifySubscription,
} from "@/lib/whatsapp-webhook";

// ─────────────────────────────────────────────────────────────────────────────
// Reading Meta's WhatsApp webhook.
//
// This parser is the one piece of the click-to-WhatsApp path that can be tested
// exhaustively before a single real message exists, so it is — including the
// shapes that would otherwise only show up in production at 2am.
//
// The rule it protects: `referral` arrives ONCE, on the first message of a
// conversation that began from an ad. Everything downstream depends on not
// mistaking a later message's absent referral for "this conversation had no ad".
// ─────────────────────────────────────────────────────────────────────────────

const AD_MESSAGE = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_1",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "+91 99004 49954", phone_number_id: "PN_1" },
            contacts: [{ profile: { name: "A Guest" }, wa_id: "919900449954" }],
            messages: [
              {
                from: "919900449954",
                id: "wamid.AAA",
                timestamp: "1789500000",
                type: "text",
                text: { body: "Is a room free this weekend?" },
                referral: {
                  source_url: "https://fb.me/xyz",
                  source_id: "120210000000",
                  source_type: "ad",
                  headline: "Monsoon at Coffeeberry Hills",
                  body: "Book direct",
                  ctwa_clid: "ARBxyz123",
                },
              },
            ],
          },
        },
      ],
    },
  ],
} as unknown;

describe("1. an ad-originated first message", () => {
  const [m] = parseInboundMessages(AD_MESSAGE);

  test("routes to a tenant by phone_number_id", () => {
    // Without this there is no way to know WHICH hotel was messaged.
    expect(m.phoneNumberId).toBe("PN_1");
    expect(m.wabaId).toBe("WABA_1");
  });

  test("carries the sender and the message id", () => {
    expect(m.fromPhone).toBe("919900449954");
    expect(m.messageId).toBe("wamid.AAA");
  });

  test("names the ad that produced it", () => {
    expect(m.referral?.ctwaClid).toBe("ARBxyz123");
    expect(m.referral?.sourceId).toBe("120210000000");
    expect(m.referral?.sourceType).toBe("ad");
  });

  test("reads no message body", () => {
    // The product claim is attribution, not messaging. Data we never hold
    // cannot leak.
    expect(JSON.stringify(m)).not.toContain("room free");
    expect(JSON.stringify(m)).not.toContain("A Guest");
  });
});

describe("2. timestamps", () => {
  const at = (timestamp: unknown) =>
    parseInboundMessages(
      {
        object: "whatsapp_business_account",
        entry: [{ id: "W", changes: [{ field: "messages", value: {
          metadata: { phone_number_id: "PN_1" },
          messages: [{ from: "91990", id: "m1", timestamp }],
        } }] }],
      },
      new Date("2026-09-16T00:00:00Z"),
    )[0]?.sentAt;

  test("seconds are read as seconds", () => {
    expect(at("1789500000").toISOString()).toBe("2026-09-15T19:20:00.000Z");
  });

  test("a millisecond value is rejected, not multiplied into the year 57000", () => {
    // Would otherwise poison every "first message" comparison silently.
    expect(at("1789500000000").toISOString()).toBe("2026-09-16T00:00:00.000Z");
  });

  test.each([[null], [""], ["abc"], [0], [-5]])("%s falls back to now", (v) => {
    expect(at(v).toISOString()).toBe("2026-09-16T00:00:00.000Z");
  });
});

describe("3. what must NOT be treated as evidence", () => {
  const withReferral = (referral: unknown) =>
    parseInboundMessages({
      object: "whatsapp_business_account",
      entry: [{ id: "W", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "PN_1" },
        messages: [{ from: "91990", id: "m1", timestamp: "1789500000", referral }],
      } }] }],
    })[0]?.referral;

  test("a message with no referral yields none", () => {
    // The caller must read this as "no NEW evidence", never as "no ad".
    expect(withReferral(undefined)).toBeNull();
  });

  test("a referral naming no ad is not a referral", () => {
    // Would otherwise mark the conversation as ad-originated while naming no ad.
    expect(withReferral({ source_type: "ad", headline: "Something" })).toBeNull();
  });

  test("a click id alone is enough", () => {
    expect(withReferral({ ctwa_clid: "ARB1" })?.ctwaClid).toBe("ARB1");
  });

  test("an ad id alone is enough", () => {
    expect(withReferral({ source_id: "120" })?.sourceId).toBe("120");
  });

  test("blank strings are not values", () => {
    expect(withReferral({ ctwa_clid: "   ", source_id: "" })).toBeNull();
  });
});

describe("4. payloads that are not inbound messages", () => {
  const none = (p: unknown) => expect(parseInboundMessages(p)).toEqual([]);

  test("delivery statuses are skipped", () => {
    none({
      object: "whatsapp_business_account",
      entry: [{ id: "W", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "PN_1" },
        statuses: [{ id: "wamid.X", status: "delivered" }],
      } }] }],
    });
  });

  test("other change fields are skipped, not errors", () => {
    none({
      object: "whatsapp_business_account",
      entry: [{ id: "W", changes: [{ field: "phone_number_quality_update", value: {} }] }],
    });
  });

  test("another product's webhook is ignored entirely", () => {
    none({ object: "instagram", entry: [{ id: "W", changes: [] }] });
  });

  test("a message with no phone_number_id is dropped", () => {
    // Unattributable to a tenant, so it must never be stored.
    none({
      object: "whatsapp_business_account",
      entry: [{ id: "W", changes: [{ field: "messages", value: {
        metadata: {}, messages: [{ from: "91990", id: "m1" }],
      } }] }],
    });
  });

  test.each([[null], [undefined], ["string"], [42], [[]], [{}]])(
    "garbage (%s) returns empty rather than throwing",
    (p) => {
      // A throw becomes a 500, and Meta retries a payload that will never parse.
      expect(() => parseInboundMessages(p)).not.toThrow();
      none(p);
    },
  );
});

describe("5. Meta batches, and the parser must not assume it doesn't", () => {
  test("every message across entries and changes is returned", () => {
    const msg = (from: string, id: string) => ({ from, id, timestamp: "1789500000" });
    const got = parseInboundMessages({
      object: "whatsapp_business_account",
      entry: [
        { id: "W1", changes: [
          { field: "messages", value: { metadata: { phone_number_id: "PN_1" }, messages: [msg("a", "1"), msg("b", "2")] } },
          { field: "messages", value: { metadata: { phone_number_id: "PN_2" }, messages: [msg("c", "3")] } },
        ] },
        { id: "W2", changes: [
          { field: "messages", value: { metadata: { phone_number_id: "PN_3" }, messages: [msg("d", "4")] } },
        ] },
      ],
    });
    expect(got.map((m) => m.messageId)).toEqual(["1", "2", "3", "4"]);
    // Two hotels in ONE delivery — each message keeps its own routing key.
    expect(got.map((m) => m.phoneNumberId)).toEqual(["PN_1", "PN_1", "PN_2", "PN_3"]);
  });
});

describe("6. the subscription handshake", () => {
  const params = (o: Record<string, string>) => new URLSearchParams(o);
  const TOKEN = "verify-me";

  test("echoes the challenge when the token matches", () => {
    expect(
      verifySubscription(
        params({ "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "12345" }),
        TOKEN,
      ),
    ).toBe("12345");
  });

  test.each([
    ["wrong token", { "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1" }],
    ["wrong mode", { "hub.mode": "unsubscribe", "hub.verify_token": TOKEN, "hub.challenge": "1" }],
    ["no token", { "hub.mode": "subscribe", "hub.challenge": "1" }],
  ])("refuses on %s", (_n, p) => {
    expect(verifySubscription(params(p), TOKEN)).toBeNull();
  });

  test("refuses when the server has no token configured", () => {
    // Otherwise an unconfigured deployment accepts anyone's subscription.
    expect(
      verifySubscription(params({ "hub.mode": "subscribe", "hub.challenge": "1" }), undefined),
    ).toBeNull();
  });
});
