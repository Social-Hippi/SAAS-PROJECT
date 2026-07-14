import "server-only";

import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { SHARE_TOKEN_HEADER, isShareTokenShape } from "@/lib/share-token";

// ACCESS LOCKDOWN: the entire hotel-login + hotel-owner-share surface is disabled.
// Hotels no longer log in and no longer use the /h/<shareToken> dashboard; they
// receive outcomes only through the public /share/<uuid> report link. All three
// gates below deny unconditionally, which closes the logged-in hotel dashboard
// (/hotel/[id]), the passwordless /h/ dashboard, and every /api/hotel/[id]/* data
// route in ONE place. Kept as a flag function (not `const true`) so the original
// logic stays reachable to the compiler and can be restored by flipping it.
function hotelAccessNeutralized(): boolean {
  return true;
}

// Authorization for the hotel-owner dashboard (/hotel/[hotelClientId]). A user may
// view a hotel only if they are its creator (hotel_client whose Clerk id matches
// HotelClient.createdByUserId) OR an agency member of the agency that owns it.
// Edits are limited to the owner. Returns null when not allowed (route → 404).

export type HotelViewerHotel = {
  id: string;
  agencyId: string;
  name: string;
  websiteUrl: string;
  siteId: string;
  snippetStatus: string;
  lastSyncedAt: Date | null;
  showAdSpendToHotel: boolean;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  address: string | null;
  whatsappNumber: string | null;
  roomCount: number | null;
  channelManager: string | null;
  otaCommissionRate: { toString(): string } | null;
  agency: {
    name: string;
    mobile: string | null;
    contactEmail: string | null;
    address: string | null;
    websiteUrl: string | null;
    whatsappNumber: string | null;
    suspendedAt: Date | null;
  };
};

export type HotelViewer = { hotel: HotelViewerHotel; userId: string; isOwner: boolean; canEdit: boolean };

export async function resolveHotelForViewer(hotelClientId: string): Promise<HotelViewer | null> {
  if (hotelAccessNeutralized()) return null; // hotel logins disabled (access lockdown)
  const { userId } = await auth();
  if (!userId) return null;

  const hotel = await prisma.hotelClient.findFirst({
    where: { id: hotelClientId, deletedAt: null },
    select: {
      id: true, agencyId: true, name: true, websiteUrl: true, siteId: true, snippetStatus: true,
      lastSyncedAt: true, showAdSpendToHotel: true, createdByUserId: true,
      contactName: true, contactEmail: true, contactPhone: true, address: true,
      whatsappNumber: true, roomCount: true, channelManager: true, otaCommissionRate: true,
      agency: {
        select: { name: true, mobile: true, contactEmail: true, address: true, websiteUrl: true, whatsappNumber: true, suspendedAt: true },
      },
    },
  });
  if (!hotel || hotel.agency.suspendedAt) return null;

  const isOwner = hotel.createdByUserId === userId;
  let allowed = isOwner;
  if (!allowed) {
    const member = await prisma.agencyMember.findUnique({ where: { clerkId: userId }, select: { agencyId: true } });
    allowed = member?.agencyId === hotel.agencyId;
  }
  if (!allowed) return null;

  return { hotel: hotel as unknown as HotelViewerHotel, userId, isOwner, canEdit: isOwner };
}

export type HotelOwnerAccess = {
  agencyId: string;
  hotelId: string;
  isOwner: boolean;
  /** True when the viewer is an agency member of the owning agency (not the hotel owner). */
  isAgencyMember: boolean;
};

/**
 * Authorization gate for the hotel-owner DATA routes (/api/hotel/[hotelClientId]/*).
 *
 * A request is authorized only when the signed-in Clerk user is EITHER the hotel's
 * own owner (HotelClient.createdByUserId, i.e. they signed up via an invite code)
 * OR an agency member of the agency that owns the hotel. Returns the owning
 * agencyId so the caller can scope reads via runWithAgencyScope(agencyId, …);
 * returns null when the user has no access (the route then answers 403/404).
 *
 * This NEVER trusts the URL for tenancy: agencyId comes from the HotelClient row,
 * and reads stay filtered by both agencyId and hotelClientId. A hotel owner can
 * therefore only ever reach their own hotel — a different hotelClientId (even in
 * the same agency) resolves to a row they don't own, so access is denied.
 */
export async function requireHotelOwnerAccess(hotelClientId: string): Promise<HotelOwnerAccess | null> {
  if (hotelAccessNeutralized()) return null; // hotel logins disabled (access lockdown)
  const { userId } = await auth();
  if (!userId) return null;

  const hotel = await prisma.hotelClient.findFirst({
    where: { id: hotelClientId, deletedAt: null },
    select: { id: true, agencyId: true, createdByUserId: true, agency: { select: { suspendedAt: true } } },
  });
  if (!hotel || hotel.agency.suspendedAt) return null;

  const isOwner = hotel.createdByUserId === userId;
  if (isOwner) {
    return { agencyId: hotel.agencyId, hotelId: hotel.id, isOwner: true, isAgencyMember: false };
  }

  const member = await prisma.agencyMember.findUnique({ where: { clerkId: userId }, select: { agencyId: true } });
  if (member?.agencyId === hotel.agencyId) {
    return { agencyId: hotel.agencyId, hotelId: hotel.id, isOwner: false, isAgencyMember: true };
  }
  return null;
}

/**
 * Authorization gate for the PUBLIC share-link dashboard (/h/<shareToken>).
 *
 * The 256-bit share token IS the credential — there is no session. A request is
 * authorized only when the token resolves to an active hotel AND that hotel is the
 * exact one the URL addresses (`hotel.id === hotelClientId`). This last check is
 * what stops a valid token for hotel A from ever reading hotel B's data through a
 * URL like /api/hotel/<B>/...  with A's token in the header.
 *
 * Returns null — never throws — for an invalid, revoked, soft-deleted, or
 * suspended-agency token, OR a token/hotel mismatch. Callers answer 404 (NOT 403)
 * so we never reveal that a token's format happened to be correct.
 *
 * The returned access has isOwner=false and isAgencyMember=false: a share-link
 * viewer is a read-only stranger, never an owner. (No write route consults this
 * helper — all writes require a Clerk session via the other gates.)
 */
export async function requireShareTokenAccess(
  token: string | null | undefined,
  hotelClientId: string,
): Promise<HotelOwnerAccess | null> {
  if (hotelAccessNeutralized()) return null; // /h share dashboard disabled (access lockdown)
  const t = (token ?? "").trim();
  // Cheap shape guard avoids a DB round-trip on obviously-bogus tokens.
  if (!isShareTokenShape(t)) return null;

  const hotel = await prisma.hotelClient.findUnique({
    where: { shareToken: t },
    select: {
      id: true,
      agencyId: true,
      shareTokenRevoked: true,
      deletedAt: true,
      agency: { select: { suspendedAt: true } },
    },
  });
  if (!hotel || hotel.shareTokenRevoked || hotel.deletedAt || hotel.agency.suspendedAt) return null;
  // The token must address THIS hotel — never a sibling, even in the same agency.
  if (hotel.id !== hotelClientId) return null;

  return { agencyId: hotel.agencyId, hotelId: hotel.id, isOwner: false, isAgencyMember: false };
}

/**
 * Unified READ gate for the /api/hotel/[hotelClientId]/* data routes, accepting
 * EITHER a Clerk session (logged-in owner or agency member) OR a share token.
 *
 * Resolution order: if the request carries the share-token header we treat it as a
 * share-link request (Clerk is irrelevant); otherwise we fall back to the Clerk
 * gate. The result is discriminated so each route returns the RIGHT status:
 *   • bad/again share token  → 404 (don't confirm the token format was valid)
 *   • denied Clerk session   → 403 (the historical behaviour these routes return)
 */
export type ReadAccessResult =
  | { ok: true; access: HotelOwnerAccess }
  | { ok: false; status: 403 | 404 };

export async function requireReadAccess(req: Request, hotelClientId: string): Promise<ReadAccessResult> {
  const headerToken = req.headers.get(SHARE_TOKEN_HEADER);
  if (headerToken) {
    const access = await requireShareTokenAccess(headerToken, hotelClientId);
    return access ? { ok: true, access } : { ok: false, status: 404 };
  }
  const access = await requireHotelOwnerAccess(hotelClientId);
  return access ? { ok: true, access } : { ok: false, status: 403 };
}
