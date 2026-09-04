import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";

import { hotelWelcomeEmail, newHotelJoinedEmail } from "@/lib/hotel-invite";

// ─────────────────────────────────────────────────────────────────────────────
// HOTEL INVITE — the product must not promise a door it keeps locked.
//
// Hotel logins are currently disabled at the authorization layer
// (hotelAccessNeutralized in lib/hotel-auth.ts returns true unconditionally, so
// resolveHotelForViewer / requireHotelOwnerAccess / requireShareTokenAccess all
// deny), and proxy.ts redirects any non-agency_admin away from /hotel/*.
//
// The invite flow around it stayed fully live and told the hotel otherwise:
//
//   • the welcome email was headed "Your hotel dashboard is ready" with an
//     "Open my dashboard" button pointing at /hotel/<id>/dashboard,
//   • the signup form redirected there on success,
//   • the agency was emailed "They can already see their dashboard",
//   • and Settings said hotels would be "automatically added" with no mention
//     that they get no login.
//
// So a hotel signed up, was told their dashboard was ready, clicked, and landed
// on the marketing homepage with no message.
//
// The invite itself is genuinely useful — it captures the hotel's own contact,
// room count, channel manager and OTA rate, which the agency would otherwise
// re-key — so the feature is kept and only the false promise removed.
//
// These tests fail if a dashboard link, redirect, or "you can log in" claim is
// reintroduced before a hotel-facing product actually exists.
// ─────────────────────────────────────────────────────────────────────────────


const JOIN_FORM = readCode("app/join/[inviteCode]/JoinSignupForm.tsx");
const SETTINGS_PAGE = readCode("app/(agency)/agency/(app)/settings/page.tsx");
const HOTEL_AUTH = readCode("lib/hotel-auth.ts");

const welcome = hotelWelcomeEmail({
  agencyName: "Social Hippi",
  hotelName: "Coffeeberry Hills",
  hotelClientId: "hotel_abc123",
  siteId: "site_xyz789",
  agencyContact: { email: "hello@socialhippi.com", mobile: "+919876543210" },
});

// ── 0. The precondition these tests exist for ───────────────────────────────

describe("0. hotel access is in fact disabled", () => {
  test("the gate still denies unconditionally", () => {
    // If this ever changes, the assertions below should be revisited — a real
    // hotel product MAY legitimately link to a dashboard again.
    expect(HOTEL_AUTH).toMatch(/function hotelAccessNeutralized\(\)[\s\S]{0,80}return true/);
  });
});

// ── 1. The welcome email promises only what the product delivers ────────────

describe("1. hotel welcome email", () => {
  test("contains NO link to the hotel dashboard route", () => {
    expect(welcome.html).not.toContain("/hotel/hotel_abc123/dashboard");
    expect(welcome.html).not.toMatch(/\/hotel\/[^"'\s]+\/dashboard/);
  });

  test("has no 'open my dashboard' call to action", () => {
    expect(welcome.html.toLowerCase()).not.toContain("open my dashboard");
  });

  test("does not claim a dashboard is ready, or invite them to log in", () => {
    const text = welcome.html.toLowerCase();
    expect(text).not.toContain("dashboard is ready");
    expect(text).not.toContain("log in");
  });

  test("still delivers the one thing the hotel must act on — the snippet", () => {
    // Removing the false promise must not remove the real instruction.
    expect(welcome.html).toContain("site_xyz789");
    expect(welcome.html).toContain("/t.js?id=");
  });

  test("still names the agency and how to reach them", () => {
    expect(welcome.html).toContain("Social Hippi");
    expect(welcome.html).toContain("hello@socialhippi.com");
  });

  test("sets an accurate subject", () => {
    expect(welcome.subject).toBe("Coffeeberry Hills is set up on HotelTrack");
  });
});

// ── 2. The agency is told the same true thing ───────────────────────────────

describe("2. agency notification email", () => {
  const joined = newHotelJoinedEmail({
    agencyName: "Social Hippi",
    hotelName: "Coffeeberry Hills",
    hotelEmail: "owner@coffeeberry.example",
    hotelClientId: "hotel_abc123",
  });

  test("does not tell the agency the hotel can already see a dashboard", () => {
    expect(joined.html.toLowerCase()).not.toContain("already see their dashboard");
  });

  test("points the agency at the action that actually surfaces results", () => {
    expect(joined.html).toMatch(/report link/i);
  });

  test("still links the agency to the hotel's integrations page", () => {
    expect(joined.html).toContain("/agency/hotel/hotel_abc123/integrations");
  });
});

// ── 3. Signup resolves on-page, never into the dead route ───────────────────

describe("3. the signup form does not redirect into a 404", () => {
  test("no navigation to /hotel/<id>/dashboard remains", () => {
    expect(JOIN_FORM).not.toMatch(/\/hotel\/\$\{[^}]*\}\/dashboard/);
    expect(JOIN_FORM).not.toContain("router.push");
  });

  test("success renders an in-page confirmation instead", () => {
    expect(JOIN_FORM).toMatch(/setDone\(true\)/);
    expect(JOIN_FORM).toMatch(/if \(done\)/);
  });

  test("the confirmation explains what happens next, without promising a login", () => {
    expect(JOIN_FORM).toContain("What happens next");
    expect(JOIN_FORM).toMatch(/no login needed/i);
  });
});

// ── 4. Settings tells the agency the truth before they send the code ────────

describe("4. settings invite copy", () => {
  test("states plainly that hotels do not get a login", () => {
    expect(SETTINGS_PAGE).toMatch(/Hotels do not get a login/);
  });

  test("describes the real benefit — the hotel enters its own details", () => {
    expect(SETTINGS_PAGE).toMatch(/enter their own details/);
  });

  test("no longer implies the hotel gains access by signing up", () => {
    expect(SETTINGS_PAGE).not.toMatch(/automatically added to your agency/);
  });
});
