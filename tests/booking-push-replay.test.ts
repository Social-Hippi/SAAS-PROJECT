import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// Recording the pushes that were held while Simplotel had no field mapping.
//
// This is the half that makes holding worth anything: two real bookings sat
// encrypted from 19 and 21 Sep, and once the mapping existed they became the
// bookings they always were.
//
// The properties that matter are the destructive ones — it must not be possible
// to record a booking twice, and a body that still cannot be mapped must stay
// held rather than be dropped on the floor.
// ─────────────────────────────────────────────────────────────────────────────

const REPLAY = readCode("lib/booking-push-replay.ts");
const ACTIONS = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/booking-actions.ts");
const PANEL = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/HeldPushPanel.tsx");

describe("1. pressing it twice cannot double-count revenue", () => {
  test("an already-recorded body is skipped", () => {
    expect(REPLAY).toMatch(/if \(cap\.replayedAt\) \{\s*out\.alreadyRecorded \+= 1;\s*continue;/);
  });

  test("and even without that mark, ingestion is keyed on the reservation id", () => {
    // Belt and braces: the same body updates the same booking rather than
    // adding a second one.
    expect(REPLAY).toMatch(/ingestBookingEvents\(connection, parsed\.value\)/);
    // The guarantee lives in the ingest: one row per (hotel, provider,
    // reservation id), so a repeat is an update, never a second booking.
    const INGEST = readCode("lib/booking-ingest.ts");
    expect(INGEST).toMatch(/hotelClientId_provider_externalBookingId/);
  });

  test("a body is marked recorded only after it actually was", () => {
    const loop = REPLAY.slice(REPLAY.indexOf("for (const cap of captures)"));
    const markAt = loop.indexOf("replayedAt: new Date()");
    const successAt = loop.indexOf("out.recorded += 1;");
    const bailAt = loop.indexOf("if (batch.succeeded === 0)");
    expect(bailAt).toBeGreaterThan(-1);
    expect(successAt).toBeGreaterThan(bailAt);
    expect(markAt).toBeGreaterThan(bailAt);
  });
});

describe("2. nothing is lost when a body still cannot be mapped", () => {
  test("it stays held, and the reason is rewritten to say why", () => {
    expect(REPLAY).toMatch(/out\.stillHeld \+= 1;/);
    expect(REPLAY).toMatch(/data: \{ reason: reason\.slice\(0, 500\) \}/);
  });

  test("nothing in this path deletes a capture", () => {
    expect(REPLAY).not.toMatch(/\.delete\(|deleteMany/);
  });

  test("each failure mode reports itself", () => {
    for (const re of [
      /could not be decrypted/,
      /contained no booking/,
      /No mapping exists for/,
      /could not be recorded/,
    ]) {
      expect(REPLAY).toMatch(re);
    }
  });

  test("oldest first, so lifecycle order is the real order", () => {
    // A create followed by a cancellation must not be replayed the other way up.
    expect(REPLAY).toMatch(/orderBy: \{ receivedAt: "asc" \}/);
  });
});

describe("3. who may run it, and for whom", () => {
  test("admins only", () => {
    expect(ACTIONS).toMatch(/export async function recordHeldPushes/);
    const fn = ACTIONS.slice(ACTIONS.indexOf("export async function recordHeldPushes"));
    expect(fn).toMatch(/const member = await requireAdmin\(\);/);
    expect(fn).toMatch(/Only an agency admin can record held bookings\./);
  });

  test("the tenant comes from the connection, never from the form", () => {
    const fn = ACTIONS.slice(ACTIONS.indexOf("export async function recordHeldPushes"));
    expect(fn).toMatch(/agencyScoped\(prisma\.bookingConnection\)\.findFirst/);
    // The form supplies only which hotel; agencyId is never read from it.
    expect(fn).not.toMatch(/formData\.get\("agencyId"\)/);
    expect(REPLAY).toMatch(/agencyScopedFor\(connection\.agencyId, prisma\.bookingPushCapture\)/);
    expect(REPLAY).toMatch(/connectionId: connection\.id, hotelClientId: connection\.hotelClientId/);
  });

  test("the hotel's report is rebuilt, since it reads these bookings", () => {
    expect(ACTIONS).toMatch(/revalidatePath\("\/share", "layout"\)/);
  });
});

describe("4. the button says what will happen", () => {
  test("it names how many are waiting, and reports the outcome", () => {
    expect(PANEL).toMatch(/Record \$\{waiting\} held booking/);
    expect(PANEL).toMatch(/state\.summary/);
    expect(PANEL).toMatch(/state\.problems/);
  });

  test("it is hidden when nothing is waiting", () => {
    expect(PANEL).toMatch(/\{waiting > 0 && \(/);
  });

  test("no function prop crosses into the client component", () => {
    // A client component cannot receive a function from a server one; the links
    // are built inside it.
    expect(PANEL).toMatch(/"use client"/);
    expect(PANEL).toMatch(/const hrefFor = \(id: string\)/);
    expect(PANEL).not.toMatch(/hrefFor: \(id: string\) => string;/);
  });
});
