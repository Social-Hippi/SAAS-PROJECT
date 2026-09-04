import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// HOTEL SURFACES — the wiring that turns the grant model into a product.
//
// This is the commit that LIFTS the blanket hotel-access lockdown, so the tests
// that matter most are the ones asserting what did NOT get opened along with it:
//
//   • the passwordless /h/<shareToken> dashboard stays retired,
//   • middleware stops role-gating /hotel only because the real gate is
//     server-side and per-hotel — not because the check was dropped,
//   • agency-side team management is admin-only and agency-scoped,
//   • no hotel surface can reach agency-wide data.
//
// Behavioural coverage of the routes themselves needs a database and a Clerk
// session; these are source assertions over the wiring, in the same style as
// tests/spend-display-integrity.test.ts. The DB-backed suite covers the rest
// once a database is reachable.
// ─────────────────────────────────────────────────────────────────────────────

const HOTEL_AUTH = readCode("lib/hotel-auth.ts");
const PROXY = readCode("proxy.ts");
const TEAM_ACTIONS = readCode("app/(agency)/agency/(app)/hotel/[id]/team/actions.ts");
const TEAM_PAGE = readCode("app/(agency)/agency/(app)/hotel/[id]/team/page.tsx");
const HOTEL_LAYOUT = readCode("app/hotel/layout.tsx");
const HOTEL_INDEX = readCode("app/hotel/page.tsx");
const ACCEPT_PAGE = readCode("app/hotel-invite/[token]/page.tsx");
const HOTEL_PAGE = readCode("app/(agency)/agency/(app)/hotel/[id]/page.tsx");

// ── 1. The lockdown is lifted only where a grant model now exists ───────────

describe("1. lifting the lockdown", () => {
  test("the blanket kill-switch is gone", () => {
    expect(HOTEL_AUTH).not.toContain("hotelAccessNeutralized");
  });

  test("session gates delegate to the single grant-aware gate", () => {
    // Both must go through resolveHotelAccess so the loader cannot drift from
    // the authorization rule.
    expect(HOTEL_AUTH).toContain('import { resolveHotelAccess } from "@/lib/hotel-access"');
    const forViewer = HOTEL_AUTH.slice(HOTEL_AUTH.indexOf("export async function resolveHotelForViewer"));
    expect(forViewer).toContain("await resolveHotelAccess(hotelClientId)");
    const ownerAccess = HOTEL_AUTH.slice(HOTEL_AUTH.indexOf("export async function requireHotelOwnerAccess"));
    expect(ownerAccess).toContain("await resolveHotelAccess(hotelClientId)");
  });

  test("edit rights come from the capability model, not a createdByUserId guess", () => {
    expect(HOTEL_AUTH).toContain('access.can("manageHotelSettings")');
    // The old heuristic — "whoever signed the hotel up owns it" — is gone.
    expect(HOTEL_AUTH).not.toMatch(/isOwner = hotel\.createdByUserId === userId/);
  });

  test("the PASSWORDLESS /h dashboard stays retired", () => {
    // Not a missing model — a product decision. It exposed journeys, funnel data
    // and ad spend to anyone holding a URL, regardless of showAdSpendToHotel.
    expect(HOTEL_AUTH).toMatch(/function shareTokenDashboardRetired\(\)[\s\S]{0,80}return true/);
    const shareGate = HOTEL_AUTH.slice(HOTEL_AUTH.indexOf("export async function requireShareTokenAccess"));
    expect(shareGate).toContain("shareTokenDashboardRetired()");
  });
});

// ── 2. Middleware ───────────────────────────────────────────────────────────

describe("2. middleware", () => {
  test("/hotel is no longer gated on the platform role", () => {
    // A hotel person's authority is a grant on a SPECIFIC hotel; middleware has
    // no DB access, so any role check here is either too permissive (wrong
    // hotel) or too strict (legitimate member, unexpected claim).
    const at = PROXY.indexOf("if (isHotelRoute(req))");
    expect(at).toBeGreaterThan(-1);
    const block = PROXY.slice(at, at + 700);
    expect(block).not.toContain('role !== "agency_admin"');
    expect(block).toContain("return NextResponse.next()");
  });

  test("authentication is still required for /hotel", () => {
    // Dropping the role check must not drop the session check: the !userId
    // redirect runs before any route matcher.
    expect(PROXY).toMatch(/if \(!userId\) \{[\s\S]{0,120}redirectToSignIn/);
  });

  test("the invite-accept route is public, so a signed-out recipient can reach it", () => {
    expect(PROXY).toContain('"/hotel-invite(.*)"');
    // And it must be listed BEFORE the /hotel matcher can claim it — isPublicRoute
    // short-circuits first, which is why the ordering matters.
    expect(PROXY.indexOf('"/hotel-invite(.*)"')).toBeLessThan(PROXY.indexOf("isHotelRoute(req)"));
  });
});

// ── 3. Agency-side team management is properly gated ────────────────────────

describe("3. team management authorization", () => {
  test("every action requires an agency ADMIN, server-side", () => {
    const actions = ["inviteHotelUserAction", "revokeHotelInviteAction", "removeHotelMemberAction"];
    for (const name of actions) {
      const at = TEAM_ACTIONS.indexOf(`export async function ${name}`);
      expect(at, name).toBeGreaterThan(-1);
      expect(TEAM_ACTIONS.slice(at, at + 400), name).toContain("await requireAdmin()");
    }
  });

  test("the hotel is resolved through agencyScoped, never trusted from the form", () => {
    expect(TEAM_ACTIONS).toContain("agencyScoped(prisma.hotelClient)");
    expect(TEAM_ACTIONS).toMatch(/if \(!hotel\) return \{ ok: false/);
  });

  test("the role is validated against the enum, not trusted as a string", () => {
    expect(TEAM_ACTIONS).toContain("isHotelRole(role)");
  });

  test("the page itself is admin-only and 404s rather than redirecting", () => {
    // notFound() avoids confirming the page exists to someone who can't use it.
    expect(TEAM_PAGE).toContain("await requireAdmin()");
    expect(TEAM_PAGE).toMatch(/if \(!member\) notFound\(\)/);
    expect(TEAM_PAGE).toMatch(/if \(!hotel\) notFound\(\)/);
  });

  test("the team page is reachable from the hotel dashboard", () => {
    // A surface nobody can navigate to is not a feature — see the orphaned
    // Content Library.
    expect(HOTEL_PAGE).toMatch(/\/agency\/hotel\/\$\{hotel\.id\}\/team/);
  });
});

// ── 4. Hotel navigation is derived from grants ──────────────────────────────

describe("4. hotel-side navigation", () => {
  test("the layout derives links from grants, not from createdByUserId", () => {
    expect(HOTEL_LAYOUT).toContain("listHotelMembershipsForCurrentUser");
    expect(HOTEL_LAYOUT).not.toContain("createdByUserId");
  });

  test("the nav can never offer a hotel the gate would refuse", () => {
    // Both the nav and resolveHotelAccess read the same HotelMember rows.
    expect(HOTEL_LAYOUT).not.toContain("prisma.hotelClient");
  });

  test("a user with no grant gets an explanation, not a bare 404", () => {
    expect(HOTEL_INDEX).toContain("don&apos;t have access to a hotel yet");
    expect(HOTEL_INDEX).toMatch(/memberships\.length === 0/);
  });

  test("a single-hotel user is redirected straight through", () => {
    expect(HOTEL_INDEX).toMatch(/memberships\.length === 1[\s\S]{0,120}redirect\(/);
  });

  test("no agency concept leaks into the hotel shell", () => {
    for (const term of ["Hotel Clients", "Influencer", "Billing", "agencyScoped"]) {
      expect(HOTEL_LAYOUT, term).not.toContain(term);
    }
  });
});

// ── 5. The accept flow ──────────────────────────────────────────────────────

describe("5. invitation acceptance", () => {
  test("a signed-out recipient is sent to sign-in and returned WITH the token", () => {
    // Losing the token on the round-trip would make every invitation unusable
    // for anyone without an existing session.
    expect(ACCEPT_PAGE).toMatch(/redirect\(`\/sign-in\?redirect_url=\$\{back\}`\)/);
    expect(ACCEPT_PAGE).toMatch(/encodeURIComponent\(`\/hotel-invite\/\$\{token\}`\)/);
  });

  test("failures render the specific reason, not a generic error", () => {
    expect(ACCEPT_PAGE).toContain("result.message");
    expect(ACCEPT_PAGE).toContain("This invitation can't be used");
  });

  test("an already-used invitation offers the useful next step", () => {
    // That person very likely already has access.
    expect(ACCEPT_PAGE).toMatch(/result\.reason === "already_used"/);
  });

  test("success lands the user on the hotel they were invited to", () => {
    expect(ACCEPT_PAGE).toMatch(/\/hotel\/\$\{result\.hotelClientId\}\/dashboard/);
  });

  test("the page is not indexable", () => {
    expect(ACCEPT_PAGE).toMatch(/robots:\s*\{\s*index:\s*false/);
  });
});
