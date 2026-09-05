import { describe, expect, it } from "vitest";
import { readCode } from "./helpers/read-code";
import {
  HOTEL_ROLES,
  HOTEL_ROLE_DESCRIPTION,
  can,
  type HotelRole,
} from "@/lib/hotel-capabilities";

// The hotel's own People page.
//
// WHY THIS SUITE EXISTS
//
// hotel_owner carried the manageTeam capability, and HOTEL_ROLE_DESCRIPTION told
// the agency admin — at the moment they picked someone's access level — that an
// Owner could "invite other people to this hotel". The only surface that used
// manageTeam was the AGENCY's, behind requireAdmin(). So the owner had been
// promised a power the product gave them nowhere to exercise.
//
// The capability table alone cannot catch that: it was correct. What was missing
// was a route. These assertions therefore tie the three together — the promise
// in the copy, the capability, and a surface that actually spends it — because
// any two of the three agreeing is exactly the state that shipped.

const HOTEL_ACTIONS = readCode("app/hotel/[hotelClientId]/team/actions.ts");
const HOTEL_PAGE = readCode("app/hotel/[hotelClientId]/team/page.tsx");
const AGENCY_ACTIONS = readCode("app/(agency)/agency/(app)/hotel/[id]/team/actions.ts");
const HOTEL_LAYOUT = readCode("app/hotel/layout.tsx");
const TEAM_LIB = readCode("lib/hotel-team.ts");

describe("1. the promise and the power match", () => {
  it("only roles that may invite are described as being able to", () => {
    for (const role of HOTEL_ROLES) {
      const claimsInviting = /invit/i.test(HOTEL_ROLE_DESCRIPTION[role]);
      expect(
        claimsInviting,
        `${role}: description ${claimsInviting ? "claims" : "does not claim"} inviting, ` +
          `capability says ${can({ kind: "hotel", role }, "manageTeam")}`,
      ).toBe(can({ kind: "hotel", role }, "manageTeam"));
    }
  });

  it("the owner is the only hotel role that may invite", () => {
    const inviters = HOTEL_ROLES.filter((r: HotelRole) =>
      can({ kind: "hotel", role: r }, "manageTeam"),
    );
    expect(inviters).toEqual(["hotel_owner"]);
  });

  it("a hotel-side surface exists that spends the capability", () => {
    // The gap that shipped: manageTeam existed, was described to the customer,
    // and was reachable only through requireAdmin() — an agency-only guard.
    expect(HOTEL_ACTIONS).toContain('requireHotelCapability');
    expect(HOTEL_ACTIONS).toContain('"manageTeam"');
    expect(HOTEL_PAGE).toContain('requireHotelCapability(hotelClientId, "manageTeam")');
  });
});

describe("2. every hotel-side action re-authorizes", () => {
  // A server action is a POST endpoint. The page having been gated is not an
  // argument about the request; each action must resolve access for itself.
  const exported = [...HOTEL_ACTIONS.matchAll(/export async function (\w+)/g)].map((m) => m[1]);

  it("there are actions to check", () => {
    expect(exported.length).toBeGreaterThanOrEqual(3);
  });

  it("no exported action reaches the library without passing the gate", () => {
    // Each action body must call gate() (which is requireHotelCapability) and
    // bail before doing any work.
    const bodies = HOTEL_ACTIONS.split(/export async function /).slice(1);
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf("("));
      expect(body, `${name} must resolve access`).toContain("await gate(formData)");
      expect(body, `${name} must bail when denied`).toMatch(/if \(!access\)/);
    }
  });

  it("the gate demands manageTeam, not merely a membership", () => {
    // resolveHotelAccess alone would let a MARKETING user manage the team.
    expect(HOTEL_ACTIONS).toMatch(/requireHotelCapability\([^)]*"manageTeam"\)/s);
    expect(HOTEL_ACTIONS).not.toMatch(/await resolveHotelAccess\(/);
  });

  it("the agencyId written comes from the resolved hotel, never the form", () => {
    // hotelClientId arrives from the request; agencyId must not. Every write
    // takes access.agencyId, which requireHotelCapability read off the hotel row.
    expect(HOTEL_ACTIONS).toContain("agencyId: access.agencyId");
    expect(HOTEL_ACTIONS).not.toMatch(/formData\.get\(\s*"agencyId"/);
  });
});

describe("3. the last owner cannot lock the hotel out", () => {
  it("the hotel's own surface asks for the protection", () => {
    expect(HOTEL_ACTIONS).toContain("requireRemainingOwner: true");
  });

  it("the agency's surface deliberately does not", () => {
    // An agency revoking every hotel login is legitimate and locks nobody out of
    // anything the agency needs. Silently applying the hotel-side rule to them
    // would block a decision that is theirs.
    expect(AGENCY_ACTIONS).toContain("requireRemainingOwner: false");
  });

  it("the protection is a real branch, not just a parameter", () => {
    expect(TEAM_LIB).toContain("requireRemainingOwner");
    expect(TEAM_LIB).toMatch(/role: "hotel_owner"/);
    expect(TEAM_LIB).toContain('reason: "last_owner"');
  });

  it("the refusal is reported, not swallowed", () => {
    // Returning quietly leaves the person looking at an unchanged list, unsure
    // whether the click registered.
    expect(HOTEL_ACTIONS).toMatch(/redirect\(`\$\{base\}\?refused=\$\{result\.reason\}`\)/);
  });
});

describe("4. the refusal message is ours, not the URL's", () => {
  it("the page renders from a closed set", () => {
    // A message carried in a query string is a message an attacker can write —
    // a crafted link would put arbitrary text on our page in our voice.
    expect(HOTEL_PAGE).toContain("REMOVE_REFUSAL_MESSAGE");
    expect(HOTEL_PAGE).toMatch(/in REMOVE_REFUSAL_MESSAGE/);
  });

  it("the query value is never rendered directly", () => {
    const suspicious = HOTEL_PAGE.match(/\{\s*(sp\.refused|raw)\s*\}/);
    expect(suspicious).toBeNull();
  });
});

describe("5. navigation cannot offer what the gate refuses", () => {
  it("the sidebar link is derived from the same predicate", () => {
    expect(HOTEL_LAYOUT).toContain('can(primary.role, "manageTeam")');
    expect(HOTEL_LAYOUT).toContain("/team");
  });

  it("the link is only offered when one hotel is unambiguous", () => {
    // "People" is per-hotel. With several properties a single global link would
    // have to pick one, and be wrong for the others.
    expect(HOTEL_LAYOUT).toMatch(/memberships\.length === 1 && can\(/);
  });
});

describe("6. one form, two authorization paths", () => {
  const FORM = readCode("components/hotel/InviteHotelUserForm.tsx");

  it("the shared form makes no authorization decision", () => {
    // Hiding a form is not access control. If this component ever starts
    // deciding, the two surfaces stop being independently enforced.
    expect(FORM).not.toContain("requireHotelCapability");
    expect(FORM).not.toContain("requireAdmin");
    expect(FORM).not.toMatch(/\bcan\(/);
  });

  it("the action is injected, so neither surface can borrow the other's", () => {
    expect(FORM).toMatch(/action:\s*\(/);
    expect(FORM).not.toContain("inviteHotelUserAction");
    expect(FORM).not.toContain("inviteToMyHotelAction");
  });

  it("the client form imports only the pure result type", () => {
    // Importing from lib/hotel-team.ts would drag "server-only", Prisma and the
    // mailer toward the browser bundle.
    expect(FORM).toContain('from "@/lib/hotel-team-result"');
    expect(FORM).not.toContain('from "@/lib/hotel-team"');
  });
});

describe("7. the invitation says who actually sent it", () => {
  it("the sender label is required, not defaulted to the agency", () => {
    // A hotel owner adding their GM is not an agency action. An email apparently
    // from an agency that did not send it is a small dishonesty, and a default
    // is how one gets shipped by accident.
    expect(TEAM_LIB).toContain("invitedByLabel: string;");
    expect(TEAM_LIB).not.toContain("invitedByLabel?:");
    expect(TEAM_LIB).not.toMatch(/invitedByLabel\s*\?\?/);
  });

  it("a hotel-issued invite records no agency member", () => {
    expect(HOTEL_ACTIONS).toContain("invitedByAgencyMemberId: null");
    expect(HOTEL_ACTIONS).toContain("invitedByLabel: access.hotelName");
  });

  it("an agency-issued invite records the agency member who sent it", () => {
    expect(AGENCY_ACTIONS).toContain("invitedByAgencyMemberId: member.id");
    expect(AGENCY_ACTIONS).toContain("invitedByLabel: member.agency.name");
  });
});
