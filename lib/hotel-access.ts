import "server-only";

import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { isAllowedStaffEmail } from "@/lib/access";
import {
  can,
  capabilitiesFor,
  type HotelCapability,
  type HotelPrincipal,
} from "@/lib/hotel-capabilities";

// ─────────────────────────────────────────────────────────────────────────────
// THE hotel authorization gate.
//
// One function answers "may this request touch this hotel, and as what?" for
// both principals — an agency member acting on a client hotel, and a hotel-side
// user acting on their own. Callers then ask for a CAPABILITY rather than
// re-deriving a role, so a guard and the UI that hides the corresponding control
// evaluate the same predicate.
//
// TENANCY. hotelClientId arrives from the URL and is NEVER trusted for tenancy.
// Both branches resolve the hotel row FIRST and read agencyId OFF THAT ROW; the
// membership lookup is then constrained to that hotel. A caller who knows or
// guesses another hotel's id resolves to a row they hold no membership on and is
// denied — the id is a lookup key, never an authorization claim. This mirrors
// the existing requireHotelOwnerAccess contract in lib/hotel-auth.ts.
//
// Returning the agencyId is what lets the caller run the existing agency-scoped
// data loaders via runWithAgencyScope(), so hotel surfaces reuse the SAME
// tenancy layer rather than introducing a second one. Reads stay filtered by
// agencyId AND hotelClientId.
//
// FAILS CLOSED. Every unresolvable case — signed out, no membership, deleted
// hotel, suspended agency, non-staff agency email — returns null. Callers 404
// rather than 403 so the existence of another tenant's hotel is never confirmed.
// ─────────────────────────────────────────────────────────────────────────────

export type HotelAccess = {
  /** Owning agency, read off the hotel row — never from the request. */
  agencyId: string;
  hotelClientId: string;
  hotelName: string;
  principal: HotelPrincipal;
  /** Precomputed for the UI, so navigation is derived from the same source. */
  capabilities: readonly HotelCapability[];
  /** Convenience guard: `access.can("manageTeam")`. */
  can: (capability: HotelCapability) => boolean;
};

function build(
  row: { id: string; agencyId: string; name: string },
  principal: HotelPrincipal,
): HotelAccess {
  return {
    agencyId: row.agencyId,
    hotelClientId: row.id,
    hotelName: row.name,
    principal,
    capabilities: capabilitiesFor(principal),
    can: (capability) => can(principal, capability),
  };
}

/**
 * Resolve the signed-in user's access to ONE hotel, or null.
 *
 * Resolution order matters: the AGENCY branch is checked first because an agency
 * member acting on their own client hotel is the established path and carries
 * the wider capability set. A user who is somehow both keeps agency access.
 */
export async function resolveHotelAccess(
  hotelClientId: string,
): Promise<HotelAccess | null> {
  const { userId } = await auth();
  if (!userId) return null;
  if (typeof hotelClientId !== "string" || hotelClientId.length === 0) return null;

  // Resolve the hotel FIRST. agencyId comes from this row, never the request.
  const hotel = await prisma.hotelClient.findFirst({
    where: { id: hotelClientId, deletedAt: null },
    select: {
      id: true,
      agencyId: true,
      name: true,
      agency: { select: { suspendedAt: true } },
    },
  });
  if (!hotel || hotel.agency.suspendedAt) return null;

  // ── Agency branch ────────────────────────────────────────────────────────
  // The staff-domain gate is applied here for the same reason getAgencyContext
  // applies it on every scoped read: a member provisioned before the lockdown
  // whose email is not a staff address must not regain access through a new
  // surface. Hotel-side members are NOT subject to it — they are customers, not
  // staff, and the domain rule was never about them.
  const agencyMember = await prisma.agencyMember.findUnique({
    where: { clerkId: userId },
    select: { agencyId: true, role: true, email: true },
  });
  if (
    agencyMember &&
    agencyMember.agencyId === hotel.agencyId &&
    isAllowedStaffEmail(agencyMember.email)
  ) {
    return build(hotel, { kind: "agency", role: agencyMember.role });
  }

  // ── Hotel branch ─────────────────────────────────────────────────────────
  // Constrained to THIS hotel, so a membership on hotel A can never authorize a
  // request for hotel B — the composite unique key makes this a single index hit.
  const hotelMember = await prisma.hotelMember.findUnique({
    where: { hotelClientId_clerkId: { hotelClientId: hotel.id, clerkId: userId } },
    select: { role: true },
  });
  if (hotelMember) {
    return build(hotel, { kind: "hotel", role: hotelMember.role });
  }

  return null;
}

/**
 * Resolve access AND require a specific capability. The form most guards want:
 * a route that renders the booking list asks for "viewGuestDetails" and gets
 * null for a marketing user, without restating the role table.
 */
export async function requireHotelCapability(
  hotelClientId: string,
  capability: HotelCapability,
): Promise<HotelAccess | null> {
  const access = await resolveHotelAccess(hotelClientId);
  if (!access || !access.can(capability)) return null;
  return access;
}

/**
 * Every hotel the signed-in user can reach as a HOTEL-side member, newest first.
 *
 * Used to route a hotel user after sign-in and to render a switcher for someone
 * who holds more than one property. Agency members are deliberately NOT included
 * — they reach hotels through the agency surfaces, and mixing the two lists is
 * how an agency-only concept leaks into the hotel product.
 */
export async function listHotelMembershipsForCurrentUser(): Promise<
  { hotelClientId: string; hotelName: string; role: HotelPrincipal }[]
> {
  const { userId } = await auth();
  if (!userId) return [];

  const rows = await prisma.hotelMember.findMany({
    where: {
      clerkId: userId,
      hotelClient: { deletedAt: null },
      agency: { suspendedAt: null },
    },
    orderBy: { createdAt: "desc" },
    select: {
      hotelClientId: true,
      role: true,
      hotelClient: { select: { name: true } },
    },
  });

  return rows.map((r) => ({
    hotelClientId: r.hotelClientId,
    hotelName: r.hotelClient.name,
    role: { kind: "hotel", role: r.role } as const,
  }));
}
