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

describe("4. the referral is never erased, and always fills", () => {
  test("empty fields are filled ONE BY ONE, not all-or-nothing", () => {
    // Never overwrite: Kraya re-sends the whole lead on every stage change, and
    // a hand-edited lead can come back with wa_ref_* blank, which would delete
    // the ad at the moment someone marked it "Booking Confirmed".
    //
    // But always fill. An all-or-nothing gate ("write nothing unless EVERY
    // field is empty") looks equivalent and is not: a row holding a click id
    // but no ad id can never gain the ad id, because the click id makes the
    // gate false. Eighty production rows hit exactly that.
    expect(INGEST).toMatch(/const fill = /);
    expect(INGEST).toMatch(/current == null && incoming != null \? incoming : undefined/);
    expect(INGEST).not.toMatch(/existing\.ctwaClid == null && existing\.sourceId == null/);
  });

  test("undefined entries are dropped so Prisma leaves those columns alone", () => {
    expect(INGEST).toMatch(/filter\(\(\[, v\]\) => v !== undefined\)/);
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

  test("the number is kept ONLY encrypted, never in plain text", () => {
    // Kept so the agency can find the lead in Kraya. Ciphertext at rest; the
    // hash stays the identity every join uses.
    expect(INGEST).toMatch(/return encryptToken\(v\);/);
    expect(INGEST).toMatch(/const phoneEncrypted = encryptPhone\(lead\.phone\);/);
    expect(INGEST).not.toMatch(/phoneEncrypted:\s*lead\.phone/);
    // Email is still not kept in any form beyond its hash.
    expect(INGEST).not.toMatch(/emailEncrypted/);
  });

  test("an import never replaces a real Kraya lead id with a synthesised one", () => {
    // An export carries no lead id, so the importer mints `export:<hash>`. On
    // 18 Sep a re-import overwrote ~35 real ids the webhook had supplied. The
    // same fill-never-downgrade rule the referral fields already follow.
    expect(INGEST).toMatch(
      /\.\.\.\(keepExistingLeadId\(existing\.krayaLeadId, krayaLeadId\) \? \{\} : \{ krayaLeadId \}\)/,
    );
    const fn = INGEST.slice(INGEST.indexOf("function keepExistingLeadId"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    // Keep only when the stored id is real AND the incoming one is not — so a
    // real id still upgrades a synthesised one.
    expect(body).toMatch(/return isReal\(current\) && !isReal\(incoming\);/);
    expect(body).toMatch(/!id\.startsWith\(EXPORT_PREFIX\)/);
    // The unconditional overwrite must be gone from the update.
    const update = INGEST.slice(INGEST.indexOf("await scoped.update({"));
    expect(update.slice(0, update.indexOf("select:"))).not.toMatch(/^\s+krayaLeadId,$/m);
  });

  test("an older export row never rewinds a lead's stage", () => {
    // 18 Sep: an export generated before 17 Sep moved a guest the team had
    // confirmed back to "Interested - Follow-Up", because its row — dated
    // 11 Sep — still said so.
    expect(INGEST).toMatch(/const seenAt = dates\.lastSeenAt \?\? now;/);
    expect(INGEST).toMatch(
      /const isStaleRow =\s*existing\?\.lastMessageAt != null && seenAt\.getTime\(\) < existing\.lastMessageAt\.getTime\(\);/,
    );
    expect(INGEST).toMatch(
      /\.\.\.\(isStaleRow\s*\?\s*\{\}\s*:\s*\{ stageName: lead\.stage, pipelineName: lead\.pipeline, lastMessageAt: seenAt \}\)/,
    );
    // The unconditional writes must be gone from the update.
    const update = INGEST.slice(INGEST.indexOf("await scoped.update({"));
    const data = update.slice(0, update.indexOf("select:"));
    expect(data).not.toMatch(/^\s+stageName: lead\.stage,$/m);
    expect(data).not.toMatch(/lastMessageAt: dates\.lastSeenAt \?\? now/);
  });

  test("a stale row still fills what only ever fills", () => {
    // The number, lead id and ad sticker are not gated on freshness: none of
    // them can move a lead backwards.
    const update = INGEST.slice(INGEST.indexOf("await scoped.update({"));
    const data = update.slice(0, update.indexOf("select:"));
    expect(data).toMatch(/\.\.\.\(phoneEncrypted \? \{ phoneEncrypted \} : \{\}\)/);
    expect(data).toMatch(/\.\.\.referralFields/);
    expect(data).toMatch(/keepExistingLeadId/);
  });

  test("a webhook is dated by its arrival, so it always applies", () => {
    // The webhook path passes no dates; `now` is later than anything stored.
    expect(INGEST).toMatch(/const seenAt = dates\.lastSeenAt \?\? now;/);
  });

  test("a failed encryption never stops a lead being recorded", () => {
    // The number is display data; the hash is the identity. Losing the number
    // must not lose the lead or its booking join.
    const fn = INGEST.slice(INGEST.indexOf("function encryptPhone"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toMatch(/catch \{\s*return null;/);
  });

  test("an unusable phone is refused", () => {
    expect(INGEST).toMatch(/if \(!phoneHash\) return null;/);
  });

  test("every write is agency-scoped", () => {
    expect(INGEST).toMatch(/agencyScopedFor\(agencyId, prisma\.whatsAppConversation\)/);
    expect(INGEST).toMatch(/agencyScopedFor\(agencyId, prisma\.booking\)/);
  });

  test("the booking is idempotent on the phone hash, not the lead id", () => {
    // A lead is upserted on every stage change, so SOME key is required or a
    // guest gains a booking each time anyone touches their record.
    //
    // The key is the phone hash rather than Kraya's lead id because the same
    // booking reaches us two ways: live from the webhook, which knows the
    // numeric id, and from the export, which carries none. Keying on the id
    // would file one guest's booking twice, and a backfill would silently double
    // every confirmed booking it touched.
    expect(INGEST).toMatch(/const externalBookingId = phoneHash;/);
    expect(INGEST).toMatch(/provider: "kraya", externalBookingId\b/);
    expect(INGEST).not.toMatch(/externalBookingId: lead\.leadId/);
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

// ── 7. Setup UI ─────────────────────────────────────────────────────────────

const ACTIONS = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/kraya-actions.ts");
const CARD = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/KrayaCard.tsx");
const PAGE = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/page.tsx");

describe("7. the secret", () => {
  test("is CSPRNG and encrypted before it reaches the database", () => {
    expect(ACTIONS).toMatch(/randomBytes\(32\)/);
    expect(ACTIONS).toMatch(/credentials: encryptToken\(secret\)/);
    expect(ACTIONS).not.toMatch(/credentials:\s*secret\b/);
  });

  test("is returned only by the call that minted it, and never read back", () => {
    expect(ACTIONS).toMatch(/return \{ error: null, ok: true, secret \}/);
    expect(ACTIONS).not.toContain("getTokenForApiCall");
  });

  test("the card warns that regenerating breaks the live webhook", () => {
    expect(CARD).toMatch(/not shown again/i);
    expect(CARD).toMatch(/stops Kraya&apos;s webhook until the new value is/i);
  });
});

describe("8. the confirmed-stage control", () => {
  test("options are learned from this hotel's own leads", () => {
    // Not a hardcoded list: "Booking Confirmed" here, "Won" at the next hotel.
    expect(PAGE).toMatch(/groupBy\(\{[\s\S]{0,120}by: \["stageName"\]/);
    expect(CARD).toMatch(/connection\.observedStages\.map/);
  });

  test("no free-text box before any lead has arrived", () => {
    // A typo there would silently create no bookings, forever, with no symptom.
    expect(CARD).toMatch(/Stage names appear here once the first lead arrives/);
    expect(CARD).not.toMatch(/<input[^>]*name="stage"/);
  });

  test("clearing it is allowed and means create no bookings", () => {
    // A deliberate choice an agency may want, so it is accepted not rejected.
    expect(ACTIONS).toMatch(/raw\.length > 0 \? raw : null/);
    expect(CARD).toMatch(/none: create no bookings/);
  });
});

describe("9. the card reports honestly and isolates tenants", () => {
  test("the badge tracks whether a lead has ARRIVED", () => {
    // A connection made here and never enabled in Kraya looks identical to a
    // working one until the first lead lands.
    expect(PAGE).toMatch(/krayaView\.lastLeadReceivedAt \? "green" : "yellow"/);
    expect(CARD).toMatch(/No lead received yet/);
  });

  test("every action requires an admin and an agency-scoped hotel", () => {
    for (const fn of ["connectKraya", "setKrayaConfirmedStage", "disconnectKraya"]) {
      const body = ACTIONS.slice(ACTIONS.indexOf(`export async function ${fn}`), ACTIONS.indexOf(`export async function ${fn}`) + 700);
      expect(body, fn).toMatch(/requireAdmin\(\)/);
      expect(body, fn).toMatch(/ownHotel\(/);
    }
  });

  test("the row is written under the hotel's own agencyId", () => {
    expect(ACTIONS).toMatch(/agencyId: hotel\.agencyId/);
    expect(ACTIONS).not.toMatch(/agencyId:\s*(formData|member\.agencyId)/);
  });

  test("disconnecting keeps the leads and bookings", () => {
    // They are facts. Deleting attribution history to unhook a webhook would
    // destroy the thing this integration exists to build.
    expect(ACTIONS).toMatch(/prisma\.krayaConnection\.deleteMany/);
    expect(ACTIONS).not.toMatch(/whatsAppConversation\.deleteMany/);
    expect(ACTIONS).not.toMatch(/booking\.deleteMany/);
  });

  test("the page never selects the ciphertext", () => {
    const sel = PAGE.slice(PAGE.indexOf("krayaConnection"), PAGE.indexOf("krayaConnection") + 400);
    expect(sel).not.toMatch(/credentials:\s*true/);
  });
});
