// Hotel-side capability model — PURE. No DB, no session, no "server-only", so
// the authorization helpers, the UI, and the tests all share one definition of
// "what may this principal do with this hotel".
//
// WHY A CAPABILITY SET RATHER THAN A ROLE CHECK
//
// The agency side already showed the failure mode: `role` is a scalar there, so
// every new rule became another `if (member.role !== "admin")` scattered across
// call sites — twelve of them, with the navigation left unaware of any. Adding
// three hotel roles the same way would have multiplied that.
//
// Here a role maps ONCE to a capability set, every guard asks for a capability,
// and the navigation is derived from the same set. Adding a role is one table
// row; adding a rule is one key.
//
// WHAT THE ROLES ACTUALLY DIFFER ON — and it is deliberately narrow, because
// differentiation that is not justified is just friction:
//
//   • GUEST PII       — the booking list carries guest names. An owner and a
//                       manager run the property and see it; a marketing user
//                       does not need it to evaluate a campaign.
//   • CONFIGURATION   — who may connect an ad account or change hotel settings.
//   • TEAM            — who may grant another person access to this hotel.
//
// Everything else (performance, revenue, channels, campaigns, attribution,
// tracking health) is visible to every hotel role. Marketing users in particular
// DO see revenue — ROAS is meaningless without it, and hiding it would make the
// marketing surfaces useless rather than safer.

/** Mirrors the Prisma HotelRole enum (kept as a string union so this module
 *  stays importable without the Prisma client — same pattern as
 *  lib/booking-identity.ts's MatchMethod). */
export type HotelRole = "hotel_owner" | "hotel_manager" | "hotel_marketing";

export const HOTEL_ROLES = ["hotel_owner", "hotel_manager", "hotel_marketing"] as const;

export function isHotelRole(v: unknown): v is HotelRole {
  return typeof v === "string" && (HOTEL_ROLES as readonly string[]).includes(v);
}

export const HOTEL_ROLE_LABEL: Record<HotelRole, string> = {
  hotel_owner: "Owner",
  hotel_manager: "Manager",
  hotel_marketing: "Marketing",
};

export const HOTEL_ROLE_DESCRIPTION: Record<HotelRole, string> = {
  hotel_owner: "Full access, and can invite other people to this hotel.",
  hotel_manager: "Full access to performance, revenue and bookings.",
  hotel_marketing: "Marketing performance and integrations. No guest details.",
};

/** Everything a principal can be permitted to do with ONE hotel. */
export type HotelCapability =
  /** Overview, channels, campaigns, attribution, revenue and ROAS. */
  | "viewPerformance"
  /** The booking LIST, which carries guest names (PII). */
  | "viewGuestDetails"
  /** Whether tracking/integrations are healthy — everyone needs to trust data. */
  | "viewDataHealth"
  /** Connect / disconnect ad + analytics accounts for this hotel. */
  | "manageIntegrations"
  /** Edit the hotel's own settings (contact, OTA rate, funnel rules). */
  | "manageHotelSettings"
  /** Invite or remove people on this hotel. */
  | "manageTeam"
  /** Agency-only operations (delete the hotel, map ad accounts, share links). */
  | "manageAsAgency";

const HOTEL_ROLE_CAPABILITIES: Record<HotelRole, readonly HotelCapability[]> = {
  hotel_owner: ["viewPerformance", "viewGuestDetails", "viewDataHealth", "manageIntegrations", "manageHotelSettings", "manageTeam"],
  hotel_manager: ["viewPerformance", "viewGuestDetails", "viewDataHealth"],
  hotel_marketing: ["viewPerformance", "viewDataHealth", "manageIntegrations"],
};

/** Mirrors the Prisma MemberRole enum (agency side). */
export type AgencyRole = "admin" | "analyst";

/**
 * Agency members keep the access they already had: an agency manages its hotels
 * on the hotel's behalf, so both roles see everything for any hotel in their
 * agency, and both may act as the agency. The existing admin/analyst split is
 * preserved exactly — integrations and hotel settings stay admin-only, matching
 * the requireAdmin() guards already on those actions.
 *
 * This is not a new rule; it is the current behaviour written down so hotel and
 * agency principals can be compared through one interface.
 */
const AGENCY_ROLE_CAPABILITIES: Record<AgencyRole, readonly HotelCapability[]> = {
  admin: ["viewPerformance", "viewGuestDetails", "viewDataHealth", "manageIntegrations", "manageHotelSettings", "manageTeam", "manageAsAgency"],
  analyst: ["viewPerformance", "viewGuestDetails", "viewDataHealth", "manageAsAgency"],
};

/** A resolved principal's relationship to ONE hotel. */
export type HotelPrincipal =
  | { kind: "agency"; role: AgencyRole }
  | { kind: "hotel"; role: HotelRole };

/** The capability set for a principal. Never mutated by callers. */
export function capabilitiesFor(principal: HotelPrincipal): readonly HotelCapability[] {
  return principal.kind === "agency"
    ? AGENCY_ROLE_CAPABILITIES[principal.role]
    : HOTEL_ROLE_CAPABILITIES[principal.role];
}

/**
 * THE authorization question. Every server-side guard and every piece of
 * conditional UI asks this, so the two can never disagree — a hidden button and
 * a rejected action are the same predicate.
 */
export function can(principal: HotelPrincipal, capability: HotelCapability): boolean {
  return capabilitiesFor(principal).includes(capability);
}

/** True when the principal is a hotel-side user (never an agency member). */
export function isHotelPrincipal(p: HotelPrincipal): p is { kind: "hotel"; role: HotelRole } {
  return p.kind === "hotel";
}
