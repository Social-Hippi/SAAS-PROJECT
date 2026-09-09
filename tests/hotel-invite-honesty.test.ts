import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";

import { hotelWelcomeEmail, newHotelJoinedEmail } from "@/lib/hotel-invite";

// ─────────────────────────────────────────────────────────────────────────────
// HOTEL INVITE — the promise and the access must move together.
//
// This file originally guarded the OPPOSITE invariant. Hotel logins were
// disabled at the authorization layer while the invite flow stayed live and told
// hotels their dashboard was ready: they signed up, clicked "Open my dashboard",
// and landed on the marketing homepage with no message. The fix then was to
// remove the promise.
//
// The promise is back, because the gap it described is closed: signup now
// creates a HotelMember grant (hotel_owner) alongside the HotelClient, and
// resolveHotelAccess honours it. So the guard inverts — it now asserts that the
// dashboard link is only made because the GRANT is created in the same flow.
//
// If the grant is ever removed while the link stays, these fail. That pairing is
// the whole point: a promise and the access behind it must ship together.
// ─────────────────────────────────────────────────────────────────────────────

const JOIN_FORM = readCode("app/join/[inviteCode]/JoinSignupForm.tsx");
const SETTINGS_PAGE = readCode("app/(agency)/agency/(app)/settings/page.tsx");
const HOTEL_AUTH = readCode("lib/hotel-auth.ts");
const JOIN_ACTIONS = readCode("app/join/[inviteCode]/actions.ts");

const welcome = hotelWelcomeEmail({
  agencyName: "Social Hippi",
  hotelName: "Coffeeberry Hills",
  hotelClientId: "hotel_abc123",
  siteId: "site_xyz789",
  agencyContact: { email: "hello@socialhippi.com", mobile: "+919876543210" },
});

// ── 0. The access this promise depends on ──────────────────────────────────

describe("0. hotel access genuinely exists", () => {
  test("the blanket lockdown is gone", () => {
    expect(HOTEL_AUTH).not.toContain("hotelAccessNeutralized");
  });

  test("self-signup creates the GRANT, not just the hotel record", () => {
    // Without this the email below would promise a dashboard the person cannot
    // open — the exact dead end this file was created to prevent.
    expect(JOIN_ACTIONS).toContain("prisma.hotelMember");
    expect(JOIN_ACTIONS).toMatch(/role:\s*"hotel_owner"/);
  });

  test("the grant is written under the inviting agency's scope", () => {
    expect(JOIN_ACTIONS).toMatch(/agencyScopedFor\(agency\.id, prisma\.hotelMember\)/);
  });
});

// ── 1. The welcome email promises only what the product delivers ────────────

describe("1. hotel welcome email", () => {
  test("links to the dashboard the signup just granted access to", () => {
    expect(welcome.html).toContain("/hotel/hotel_abc123/dashboard");
  });

  test("the call to action is present and unambiguous", () => {
    expect(welcome.html.toLowerCase()).toContain("open my dashboard");
  });

  test("still delivers the one thing the hotel must act on — the snippet", () => {
    expect(welcome.html).toContain("site_xyz789");
    expect(welcome.html).toContain("/t.js?id=");
  });

  test("still names the agency and how to reach them", () => {
    expect(welcome.html).toContain("Social Hippi");
    expect(welcome.html).toContain("hello@socialhippi.com");
  });

  test("the link points at THIS hotel, not a generic route", () => {
    // A generic /hotel link would work for a single-property owner and silently
    // land a multi-property owner on a picker instead of the hotel they joined.
    const links = welcome.html.match(/\/hotel\/[^"'\s]+\/dashboard/g) ?? [];
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l).toContain("hotel_abc123");
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

  test("tells the agency the hotel has owner access — which is now true", () => {
    expect(joined.html).toMatch(/owner access/i);
  });

  test("still links the agency to the hotel's integrations page", () => {
    expect(joined.html).toContain("/agency/hotel/hotel_abc123/integrations");
  });
});

// ── 3. Signup still resolves on-page ───────────────────────────────────────

describe("3. the signup form confirms in place", () => {
  test("it does not redirect straight into the dashboard", () => {
    // The account is created server-side and has no browser session yet, so an
    // immediate redirect would bounce through sign-in. The confirmation states
    // what happened; the emailed link is the way in.
    expect(JOIN_FORM).not.toContain("router.push");
    expect(JOIN_FORM).toMatch(/setDone\(true\)/);
  });

  test("the confirmation tells them they can sign in", () => {
    expect(JOIN_FORM).toMatch(/Sign in any time/i);
  });
});

// ── 4. Settings describes what the code actually does ──────────────────────

describe("4. settings invite copy", () => {
  test("says the signer-up becomes the owner", () => {
    expect(SETTINGS_PAGE).toMatch(/becomes the hotel&apos;s owner/);
  });

  test("points at Hotel access for additional people", () => {
    expect(SETTINGS_PAGE).toMatch(/Hotel access/);
  });

  test("no longer claims hotels get no login", () => {
    expect(SETTINGS_PAGE).not.toMatch(/Hotels do not get a login/);
  });
});
