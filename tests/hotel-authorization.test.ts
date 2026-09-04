import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import {
  can,
  capabilitiesFor,
  isHotelRole,
  isHotelPrincipal,
  HOTEL_ROLES,
  HOTEL_ROLE_LABEL,
  type HotelCapability,
  type HotelPrincipal,
} from "@/lib/hotel-capabilities";
import {
  evaluateHotelInvite,
  hashHotelInviteToken,
  hotelInviteExpiry,
  hotelInviteHashMatches,
  isHotelInviteTokenShape,
  mintHotelInviteToken,
  normalizeInviteEmail,
  HOTEL_INVITE_REJECTION_MESSAGE,
  type EvaluableInvite,
} from "@/lib/hotel-user-invite";

// ─────────────────────────────────────────────────────────────────────────────
// HOTEL AUTHORIZATION.
//
// Before this, the ONLY user↔hotel link was HotelClient.createdByUserId — one
// nullable column that could not express a second person, carry a role, or be
// revoked. Hotel access was therefore all-or-nothing and was switched off
// wholesale (hotelAccessNeutralized in lib/hotel-auth.ts).
//
// The replacement is a HotelMember grant plus a capability model. These tests
// cover the parts that can be proven without a database — the capability table,
// the invitation state machine, and the token discipline — and pin the
// resolver's tenancy contract at source level, because exercising it needs both
// Prisma and a Clerk session.
//
// The cross-tenant assertions the brief asks for (Hotel A user → Hotel B denied)
// are structural here: the resolver looks a membership up by the COMPOSITE key
// (hotelClientId, clerkId), so a grant on hotel A cannot satisfy a request for
// hotel B. That is asserted below against the source, and is covered end-to-end
// by the DB-backed suite once a database is available.
// ─────────────────────────────────────────────────────────────────────────────

const HOTEL_ACCESS = readCode("lib/hotel-access.ts");

const owner: HotelPrincipal = { kind: "hotel", role: "hotel_owner" };
const manager: HotelPrincipal = { kind: "hotel", role: "hotel_manager" };
const marketing: HotelPrincipal = { kind: "hotel", role: "hotel_marketing" };
const agencyAdmin: HotelPrincipal = { kind: "agency", role: "admin" };
const agencyAnalyst: HotelPrincipal = { kind: "agency", role: "analyst" };

const ALL_HOTEL_PRINCIPALS = [owner, manager, marketing];

// ── 1. The capability table ─────────────────────────────────────────────────

describe("1. hotel role capabilities", () => {
  test("every hotel role can see performance — that is the product", () => {
    for (const p of ALL_HOTEL_PRINCIPALS) {
      expect(can(p, "viewPerformance"), p.role).toBe(true);
    }
  });

  test("every hotel role can see whether the data is trustworthy", () => {
    // A user who cannot tell whether tracking works cannot trust any number on
    // the screen, so this is not a privilege — it is a precondition.
    for (const p of ALL_HOTEL_PRINCIPALS) {
      expect(can(p, "viewDataHealth"), p.role).toBe(true);
    }
  });

  test("guest details are limited to owner and manager", () => {
    // The booking list carries guest names. This is the one PII boundary.
    expect(can(owner, "viewGuestDetails")).toBe(true);
    expect(can(manager, "viewGuestDetails")).toBe(true);
    expect(can(marketing, "viewGuestDetails")).toBe(false);
  });

  test("only owner and marketing manage integrations", () => {
    expect(can(owner, "manageIntegrations")).toBe(true);
    expect(can(marketing, "manageIntegrations")).toBe(true);
    expect(can(manager, "manageIntegrations")).toBe(false);
  });

  test("only the owner changes hotel settings or manages the team", () => {
    for (const capability of ["manageHotelSettings", "manageTeam"] as const) {
      expect(can(owner, capability), capability).toBe(true);
      expect(can(manager, capability), capability).toBe(false);
      expect(can(marketing, capability), capability).toBe(false);
    }
  });

  test("NO hotel role may act as the agency", () => {
    // manageAsAgency covers deleting the hotel, mapping ad accounts and issuing
    // share links — agency operations that must never be reachable from the
    // hotel product, whatever the hotel role.
    for (const p of ALL_HOTEL_PRINCIPALS) {
      expect(can(p, "manageAsAgency"), p.role).toBe(false);
    }
  });

  test("a marketing user is not simply a weaker manager", () => {
    // The roles are genuinely different shapes, not points on one scale: each
    // holds a capability the other lacks. If this ever collapses, the three-role
    // model is not earning its complexity.
    expect(can(marketing, "manageIntegrations")).toBe(true);
    expect(can(manager, "manageIntegrations")).toBe(false);
    expect(can(manager, "viewGuestDetails")).toBe(true);
    expect(can(marketing, "viewGuestDetails")).toBe(false);
  });
});

// ── 2. Agency principals keep exactly the access they had ───────────────────

describe("2. agency capabilities are unchanged", () => {
  test("an agency admin retains every capability, including agency operations", () => {
    const caps: HotelCapability[] = [
      "viewPerformance", "viewGuestDetails", "viewDataHealth",
      "manageIntegrations", "manageHotelSettings", "manageTeam", "manageAsAgency",
    ];
    for (const c of caps) expect(can(agencyAdmin, c), c).toBe(true);
  });

  test("an agency analyst keeps read access but not configuration", () => {
    // Mirrors the existing requireAdmin() guards on the integration actions —
    // this writes the current rule down, it does not change it.
    expect(can(agencyAnalyst, "viewPerformance")).toBe(true);
    expect(can(agencyAnalyst, "viewGuestDetails")).toBe(true);
    expect(can(agencyAnalyst, "manageAsAgency")).toBe(true);
    expect(can(agencyAnalyst, "manageIntegrations")).toBe(false);
    expect(can(agencyAnalyst, "manageHotelSettings")).toBe(false);
    expect(can(agencyAnalyst, "manageTeam")).toBe(false);
  });
});

// ── 3. Model hygiene ────────────────────────────────────────────────────────

describe("3. the role model is well-formed", () => {
  test("every declared role has a capability set and a label", () => {
    for (const role of HOTEL_ROLES) {
      expect(capabilitiesFor({ kind: "hotel", role }).length, role).toBeGreaterThan(0);
      expect(HOTEL_ROLE_LABEL[role], role).toBeTruthy();
    }
  });

  test("isHotelRole rejects anything not in the enum", () => {
    expect(isHotelRole("hotel_owner")).toBe(true);
    for (const v of ["admin", "owner", "", null, undefined, 1, {}]) {
      expect(isHotelRole(v), String(v)).toBe(false);
    }
  });

  test("isHotelPrincipal separates the two principal kinds", () => {
    expect(isHotelPrincipal(owner)).toBe(true);
    expect(isHotelPrincipal(agencyAdmin)).toBe(false);
  });

  test("capability sets are not shared mutable arrays between roles", () => {
    // A shared reference would let one role's set silently widen another's.
    expect(capabilitiesFor(owner)).not.toBe(capabilitiesFor(manager));
  });
});

// ── 4. The resolver's tenancy contract ──────────────────────────────────────

describe("4. resolveHotelAccess never trusts the URL for tenancy", () => {
  test("agencyId is read off the hotel row, not taken from the request", () => {
    expect(HOTEL_ACCESS).toMatch(/prisma\.hotelClient\.findFirst/);
    expect(HOTEL_ACCESS).toMatch(/agencyId:\s*true/);
    // The returned agencyId comes from the resolved row.
    expect(HOTEL_ACCESS).toMatch(/agencyId:\s*row\.agencyId/);
  });

  test("the hotel membership lookup is constrained to THIS hotel", () => {
    // The composite key is what makes "Hotel A user → Hotel B" structurally
    // impossible: a grant is only ever found for the hotel being requested.
    expect(HOTEL_ACCESS).toMatch(
      /hotelClientId_clerkId:\s*\{\s*hotelClientId:\s*hotel\.id,\s*clerkId:\s*userId\s*\}/,
    );
  });

  test("the agency branch requires the member's agency to own the hotel", () => {
    expect(HOTEL_ACCESS).toMatch(/agencyMember\.agencyId === hotel\.agencyId/);
  });

  test("the staff-domain gate still applies to agency principals", () => {
    // A member provisioned before the access lockdown must not regain entry
    // through this new surface.
    expect(HOTEL_ACCESS).toContain("isAllowedStaffEmail(agencyMember.email)");
  });

  test("soft-deleted hotels and suspended agencies are refused", () => {
    expect(HOTEL_ACCESS).toMatch(/deletedAt:\s*null/);
    expect(HOTEL_ACCESS).toMatch(/hotel\.agency\.suspendedAt/);
  });

  test("it fails closed — every unresolvable branch returns null", () => {
    expect(HOTEL_ACCESS).toMatch(/if \(!userId\) return null/);
    expect(HOTEL_ACCESS).toMatch(/if \(!hotel \|\| hotel\.agency\.suspendedAt\) return null/);
    expect(HOTEL_ACCESS.trimEnd()).toMatch(/return null;[\s\S]{0,40}\}\s*$|return null;\n\}/m);
  });

  test("listHotelMembershipsForCurrentUser excludes agency memberships", () => {
    // Mixing the two lists is how an agency concept leaks into the hotel product.
    const at = HOTEL_ACCESS.indexOf("listHotelMembershipsForCurrentUser");
    const body = HOTEL_ACCESS.slice(at);
    expect(body).toContain("prisma.hotelMember.findMany");
    expect(body).not.toContain("agencyMember");
  });
});

// ── 5. Invitation state machine — every case the flow must handle ───────────

describe("5. evaluateHotelInvite", () => {
  const base = (over: Partial<EvaluableInvite> = {}): EvaluableInvite => ({
    status: "PENDING",
    expiresAt: new Date(Date.now() + 86_400_000),
    hotelDeletedAt: null,
    agencySuspendedAt: null,
    ...over,
  });

  test("a fresh pending invitation is acceptable", () => {
    expect(evaluateHotelInvite(base())).toEqual({ ok: true });
  });

  test("a missing invitation is not_found, not a crash", () => {
    expect(evaluateHotelInvite(null)).toEqual({ ok: false, reason: "not_found" });
  });

  test("each rejection is NAMED, so the user gets the right message", () => {
    const cases: [Partial<EvaluableInvite>, string][] = [
      [{ status: "REVOKED" }, "revoked"],
      [{ status: "ACCEPTED" }, "already_used"],
      [{ status: "EXPIRED" }, "expired"],
      [{ expiresAt: new Date(Date.now() - 1000) }, "expired"],
      [{ hotelDeletedAt: new Date() }, "hotel_gone"],
      [{ agencySuspendedAt: new Date() }, "agency_suspended"],
    ];
    for (const [over, reason] of cases) {
      expect(evaluateHotelInvite(base(over)), reason).toEqual({ ok: false, reason });
    }
  });

  test("expiry is judged against the clock, not only the stored status", () => {
    // Nothing sweeps the table, so a PENDING row past its TTL is expired.
    const stale = base({ status: "PENDING", expiresAt: new Date(Date.now() - 1) });
    expect(evaluateHotelInvite(stale)).toEqual({ ok: false, reason: "expired" });
  });

  test("expiry is exact at the boundary (<= now is expired)", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(evaluateHotelInvite(base({ expiresAt: now }), now)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(
      evaluateHotelInvite(base({ expiresAt: new Date(now.getTime() + 1) }), now),
    ).toEqual({ ok: true });
  });

  test("a permanent reason outranks expiry, so the message is the useful one", () => {
    // A revoked invitation that also aged out should say it was cancelled.
    const both = base({ status: "REVOKED", expiresAt: new Date(Date.now() - 86_400_000) });
    expect(evaluateHotelInvite(both)).toEqual({ ok: false, reason: "revoked" });
  });

  test("every rejection reason has a plain-language message", () => {
    const reasons = [
      "malformed", "not_found", "revoked", "already_used",
      "expired", "hotel_gone", "agency_suspended",
    ] as const;
    for (const r of reasons) {
      const msg = HOTEL_INVITE_REJECTION_MESSAGE[r];
      expect(msg, r).toBeTruthy();
      // No jargon, no ids, no status codes leaking to the recipient.
      expect(msg, r).not.toMatch(/null|undefined|PENDING|REVOKED|4\d\d/);
    }
  });
});

// ── 6. Token discipline ─────────────────────────────────────────────────────

describe("6. invitation tokens", () => {
  test("a minted token is 256 bits of hex", () => {
    const { token } = mintHotelInviteToken();
    expect(isHotelInviteTokenShape(token)).toBe(true);
    expect(token).toHaveLength(64);
  });

  test("tokens are unique across mints", () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintHotelInviteToken().token));
    expect(seen.size).toBe(200);
  });

  test("the stored value is a HASH — the token itself is never persistable", () => {
    const { token, tokenHash } = mintHotelInviteToken();
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).toBe(hashHotelInviteToken(token));
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("hashing is deterministic, so the accept path can look the row up", () => {
    const { token } = mintHotelInviteToken();
    expect(hashHotelInviteToken(token)).toBe(hashHotelInviteToken(token));
  });

  test("shape validation rejects malformed tokens before any DB round-trip", () => {
    for (const v of ["", "abc", "A".repeat(64), "g".repeat(64), "a".repeat(63), null, undefined]) {
      expect(isHotelInviteTokenShape(v as string), String(v)).toBe(false);
    }
  });

  test("hash comparison is length-safe and correct", () => {
    const { tokenHash } = mintHotelInviteToken();
    expect(hotelInviteHashMatches(tokenHash, tokenHash)).toBe(true);
    expect(hotelInviteHashMatches(tokenHash, hashHotelInviteToken("other"))).toBe(false);
    // Different lengths must not throw (timingSafeEqual would).
    expect(hotelInviteHashMatches(tokenHash, "short")).toBe(false);
  });

  test("expiry is 14 days out", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    expect(hotelInviteExpiry(from).toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });
});

// ── 7. Invitee email normalization ──────────────────────────────────────────

describe("7. normalizeInviteEmail", () => {
  test("lowercases and trims so acceptance compares deterministically", () => {
    expect(normalizeInviteEmail("  Owner@Hotel.COM ")).toBe("owner@hotel.com");
  });

  test("rejects malformed addresses", () => {
    for (const v of ["", "   ", "no-at-sign", "a@b", "a@b.", "@b.com", "a b@c.com"]) {
      expect(normalizeInviteEmail(v), JSON.stringify(v)).toBeNull();
    }
  });

  test("rejects an over-long address rather than truncating it", () => {
    expect(normalizeInviteEmail("a".repeat(250) + "@example.com")).toBeNull();
  });
});
