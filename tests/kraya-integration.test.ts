import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import { parseKrayaLead, isConfirmedStage } from "@/lib/kraya-webhook";

// ─────────────────────────────────────────────────────────────────────────────
// Reading Kraya's lead webhook.
//
// Kraya holds Aster's reservations WhatsApp number, so this — not Meta's Cloud
// API — is how click-to-WhatsApp attribution actually reaches HotelTrack. A
// number belongs to one platform at a time, and taking it would break the team
// that lives in Kraya all day.
//
// Kraya retries a failed delivery TWICE and has no read endpoint, so anything
// dropped here is gone permanently. That shapes several rules below.
// ─────────────────────────────────────────────────────────────────────────────

const INGEST = readCode("lib/kraya-ingest.ts");
const ROUTE = readCode("app/api/integrations/kraya/route.ts");
const PROXY = readCode("proxy.ts");

// Kraya's own documented sample, plus the wa_ref_* attributes Aster added.
const LEAD = {
  lead_id: 123,
  name: "John Doe",
  phone: "+91-9123456789",
  email: "john.doe@example.com",
  notes: "Interested in product X",
  stage: "Booking Confirmed",
  pipeline: "Coffeeberry",
  event_type: "update",
  wa_ref_ctwa_clid: "ARBxyz123",
  wa_ref_source_id: "120241573189260234",
  wa_ref_source_type: "ad",
  wa_ref_source_url: "https://fb.me/xyz",
  wa_ref_headline: "Monsoon at Coffeeberry Hills",
};

describe("1. reading a lead", () => {
  const lead = parseKrayaLead(LEAD)!;

  test("lead_id survives being sent as a number", () => {
    // Kraya's own sample shows an integer; it is our idempotency key, and a
    // number compared against a stored string would never match.
    expect(lead.leadId).toBe("123");
  });

  test("custom attributes are read by name from the top level", () => {
    // They arrive beside `phone`, not nested. Reading by name means anything the
    // hotel adds later flows through with no code change.
    expect(lead.referral?.ctwaClid).toBe("ARBxyz123");
    expect(lead.referral?.sourceId).toBe("120241573189260234");
  });

  test("the stage is kept verbatim, never mapped", () => {
    // "Sold out" on one pipeline, "Sold out for CBH" on another. A translation
    // table would need a deploy every time someone edited a dropdown.
    expect(lead.stage).toBe("Booking Confirmed");
    expect(lead.pipeline).toBe("Coffeeberry");
  });

  test("no name or notes are read", () => {
    // Attribution needs who and which ad, not what they said.
    expect(JSON.stringify(lead)).not.toContain("John Doe");
    expect(JSON.stringify(lead)).not.toContain("product X");
  });
});

describe("2. what is not a usable lead", () => {
  test.each([
    ["no lead_id", { ...LEAD, lead_id: undefined }],
    ["no phone", { ...LEAD, phone: "" }],
    ["not an object", "string"],
    ["an array", []],
    ["null", null],
  ])("%s returns null rather than throwing", (_n, p) => {
    // A throw is a 500, which costs one of only two retries.
    expect(() => parseKrayaLead(p)).not.toThrow();
    expect(parseKrayaLead(p)).toBeNull();
  });

  test("a lead with no ad attributes is still a lead", () => {
    // "No Response" and "Junk" are real enquiries the marketing produced.
    // Dropping them understates the funnel and flatters every rate built on it.
    const plain = parseKrayaLead({ lead_id: 9, phone: "919900449954", stage: "Junk" });
    expect(plain).not.toBeNull();
    expect(plain!.referral).toBeNull();
  });

  test("a referral naming no ad is not a referral", () => {
    const l = parseKrayaLead({ ...LEAD, wa_ref_ctwa_clid: "", wa_ref_source_id: "  " });
    expect(l!.referral).toBeNull();
  });
});

describe("3. which stage means booked", () => {
  test("it matches case- and whitespace-insensitively", () => {
    // The name is typed into a settings field by a human, and Kraya's own
    // spelling drifts between pipelines.
    expect(isConfirmedStage("Booking Confirmed", "booking confirmed")).toBe(true);
    expect(isConfirmedStage("  Booking Confirmed ", "Booking Confirmed")).toBe(true);
  });

  test("an unset setting creates NO bookings", () => {
    // The safe failure. Leads still flow; nothing invents a booking from a guess.
    expect(isConfirmedStage("Booking Confirmed", null)).toBe(false);
    expect(isConfirmedStage("Booking Confirmed", "")).toBe(false);
  });

  test("a different stage is not a booking", () => {
    expect(isConfirmedStage("Interested - Follow up", "Booking Confirmed")).toBe(false);
  });
});

describe("4. the referral is never erased", () => {
  test("it is written on create, and on update only into empty fields", () => {
    // Kraya re-sends the WHOLE lead on every stage change, and a hand-edited
    // lead can come back with wa_ref_* blank. Assigning unconditionally would
    // delete the ad at the moment someone marked it "Booking Confirmed" — the
    // exact instant the attribution became worth having.
    expect(INGEST).toMatch(
      /gainsAttribution\s*=\s*\n?\s*ref != null && existing != null && existing\.ctwaClid == null && existing\.sourceId == null/,
    );
    expect(INGEST).toMatch(/\.\.\.\(gainsAttribution/);
  });
});

describe("5. identity and isolation", () => {
  test("phone and email are hashed through the shared chain", () => {
    // The same chain as Booking.guestPhoneHash, so a Kraya lead and a booking
    // engine reservation for one guest resolve to the same person.
    expect(INGEST).toContain("hashGuestPhone");
    expect(INGEST).toContain("hashGuestEmail");
    expect(INGEST).not.toMatch(/phone:\s*lead\.phone/);
  });

  test("an unusable phone is refused", () => {
    expect(INGEST).toMatch(/if \(!phoneHash\) return null;/);
  });

  test("every write is agency-scoped", () => {
    expect(INGEST).toMatch(/agencyScopedFor\(agencyId, prisma\.whatsAppConversation\)/);
    expect(INGEST).toMatch(/agencyScopedFor\(agencyId, prisma\.booking\)/);
  });

  test("the booking is idempotent on Kraya's lead id", () => {
    // A lead is upserted on every stage change; without this a guest would gain
    // a booking each time somebody touched their record.
    expect(INGEST).toMatch(/provider: "kraya", externalBookingId: lead\.leadId/);
  });

  test("bookingChannel is how it was booked, not where it came from", () => {
    // A WhatsApp booking may have been produced by a Google ad. Attribution
    // lives on the conversation, not on the channel.
    expect(INGEST).toMatch(/bookingChannel: "whatsapp"/);
  });
});

describe("6. the route", () => {
  test("the secret both authenticates AND resolves the tenant", () => {
    expect(ROUTE).toMatch(/x-kraya-webhook-secret/);
    expect(ROUTE).toMatch(/getTokenForApiCall\("kraya_webhook"/);
    // The body must have no say in which agency is written to.
    expect(ROUTE).not.toMatch(/hotelClientId.*=.*payload/);
  });

  test("comparison is length-checked before timingSafeEqual", () => {
    expect(ROUTE).toMatch(/a\.length === b\.length && timingSafeEqual\(a, b\)/);
  });

  test("an unparseable payload is acknowledged, not retried away", () => {
    // Kraya retries twice, then drops forever, and there is no read API to
    // recover from. A payload that will never parse must not consume them.
    expect(ROUTE).toMatch(/skipped: "unparseable"/);
    expect(ROUTE).toMatch(/skipped: "not a usable lead"/);
  });

  test("a database failure IS retried", () => {
    expect(ROUTE).toMatch(/status: 503/);
  });

  test("the route is reachable without a session", () => {
    expect(PROXY).toContain('"/api/integrations/kraya(.*)"');
  });
});
