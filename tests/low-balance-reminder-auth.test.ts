import { describe, expect, test, vi } from "vitest";

import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// The low-balance reminder write REQUIRES A SESSION.
//
// It previously accepted a /share/<uuid> token as a credential. A share URL is
// unauthenticated and forwardable; the reminder names the address that receives
// a hotel's ad-account BALANCE; and LowBalanceReminder is UNIQUE per hotel. So
// any recipient of a forwarded link could redirect those figures to an inbox of
// their choosing and overwrite the address the agency had set — with no
// confirmation step, and behind a rate limiter that is per-instance (and so
// effectively absent) in production.
//
// Hiding the form on the share surface does not fix that: a server action is an
// HTTP endpoint, reachable whether or not a form is rendered. These tests pin
// the SERVER guard, and then — separately — that the UI agrees with it.
// ─────────────────────────────────────────────────────────────────────────────

// Hoisted above the import below: the action's module graph reaches Clerk
// through lib/hotel-access.ts, and a signed-out caller is exactly the case
// under test.
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: null }),
}));

import { saveLowBalanceReminder } from "@/components/dashboard/funds/actions";

const ACTION = readCode("components/dashboard/funds/actions.ts");
const CARD = readCode("components/dashboard/funds/AvailableFundsCard.tsx");
const FORM = readCode("components/dashboard/funds/LowBalanceReminderForm.tsx");

describe("1. an unauthenticated caller is refused by the SERVER", () => {
  test("a signed-out caller cannot save a reminder", async () => {
    const res = await saveLowBalanceReminder({
      hotelId: "cmtobggbq01amk9o0w46ogod0",
      email: "attacker@example.com",
      threshold: "5000",
    });
    expect(res.ok).toBe(false);
  });

  test("it refuses on ACCESS, not on validation — so auth runs first", async () => {
    // A perfectly valid payload. If the refusal quoted a validation problem, the
    // guard would be sitting behind the parsing and an unauthenticated caller
    // could still probe which inputs this action accepts.
    const res = await saveLowBalanceReminder({
      hotelId: "cmtobggbq01amk9o0w46ogod0",
      email: "attacker@example.com",
      threshold: "5000",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/access/i);
  });

  test("an invalid payload is ALSO refused on access, never parsed", async () => {
    const res = await saveLowBalanceReminder({
      hotelId: "cmtobggbq01amk9o0w46ogod0",
      email: "not-an-email",
      threshold: "-1",
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/access/i);
    expect(res.error).not.toMatch(/valid email|threshold amount/i);
  });
});

describe("2. no share-token path survives in the action", () => {
  test("authorization is resolveHotelAccess and nothing else", () => {
    expect(ACTION).toContain("resolveHotelAccess(input.hotelId)");
    expect(ACTION).toMatch(/if \(!access\)/);
  });

  test("the share-link resolver is not imported or called", () => {
    expect(ACTION).not.toContain("resolveShareLink");
    expect(ACTION).not.toContain("share-link-access");
  });

  test("no shareToken is accepted, anywhere in the signature or body", () => {
    expect(ACTION).not.toContain("shareToken");
  });

  test("the tenant is taken from the resolved access, not the form", () => {
    expect(ACTION).toContain("const { agencyId, hotelClientId } = access");
    // The upsert must key on the resolved hotel, never on input.hotelId.
    expect(ACTION).toMatch(/where:\s*\{\s*hotelClientId\s*\}/);
    expect(ACTION).not.toMatch(/hotelClientId:\s*input\.hotelId/);
  });

  test("the access check precedes every validation and every write", () => {
    const auth = ACTION.indexOf("resolveHotelAccess");
    const email = ACTION.indexOf("EMAIL_RE.test");
    const write = ACTION.indexOf("lowBalanceReminder.upsert");
    expect(auth).toBeGreaterThan(-1);
    expect(email).toBeGreaterThan(auth);
    expect(write).toBeGreaterThan(auth);
  });
});

describe("3. the UI agrees with the guard (it does not replace it)", () => {
  test("the card gates the form on the share viewer", () => {
    expect(CARD).toContain('viewer === "share"');
    expect(CARD).toContain("<LowBalanceReminderForm");
  });

  test("a share viewer is pointed at their agency instead", () => {
    expect(CARD).toMatch(/contact \{agencyName\}/);
  });

  test("the balance figure itself is still shown to a share viewer", () => {
    // Only the WRITE is withheld. Gating the reading too would be a different
    // change, and showAdSpendToHotel already governs whether funds load at all.
    expect(CARD).toContain("Balance unavailable");
    expect(CARD).toContain("{known ? available.text");
  });

  test("neither the card nor the form passes a share token any more", () => {
    expect(CARD).not.toContain("shareToken");
    expect(FORM).not.toContain("shareToken");
  });
});
