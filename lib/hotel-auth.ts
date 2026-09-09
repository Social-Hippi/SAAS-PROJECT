import "server-only";

import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { SHARE_TOKEN_HEADER, isShareTokenShape } from "@/lib/share-token";
import { resolveHotelAccess } from "@/lib/hotel-access";
import { resolveShareLink } from "@/lib/share-link-access";
import type { HotelCapability } from "@/lib/hotel-capabilities";

// The blanket hotel-access lockdown has been LIFTED for logged-in hotel users.
//
// It existed because there was no user->hotel grant model: the only link was
// HotelClient.createdByUserId, a single nullable column that could not express a
// second person, carry a role, or be revoked. Access was therefore
// all-or-nothing, and "nothing" was the only safe setting.
//
// HotelMember + lib/hotel-access.ts now provide that model, so the two
// session-based gates below delegate to it: a hotel user reaches a hotel only
// via a grant on THAT hotel, with a role that decides what they can do.
//
// The PASSWORDLESS /h/<shareToken> dashboard stays retired — that is a product
// decision, not a missing model. It exposed journeys, funnel data and ad spend
// to anyone holding a URL, regardless of showAdSpendToHotel. Hotels receive
// results either by logging in (now possible) or through the /share/<uuid>
// report link, which is spend-gated server-side.
//
// NOTE — the /share/<uuid> link is a DIFFERENT credential and is NOT covered by
// this retirement. Its token is a ShareLink row, so it carries the three things
// the raw HotelClient.shareToken never had: an expiry, a revocation switch, and
// an optional password. That is what makes it safe to serve the full dashboard
// from, which requireShareLinkAccess() below does. The 64-hex /h token still
// grants nothing.
function shareTokenDashboardRetired(): boolean {
  return true;
}

/**
 * What a /share/<uuid> holder may do.
 *
 * READ capabilities only, and deliberately enumerated rather than inherited from
 * a hotel role: a link-holder is an anonymous stranger who happens to have been
 * sent a URL, so every capability they get is one somebody chose to give them.
 * No management capability appears here, and no write route consults this gate.
 *
 * viewGuestDetails is included because the share report renders the same
 * visitor-journey preview the agency sees — the reviewed, deliberate scope of
 * this surface. Removing it here is all it would take to withhold those rows.
 */
const SHARE_LINK_CAPABILITIES: readonly HotelCapability[] = [
  "viewPerformance",
  "viewGuestDetails",
  "viewDataHealth",
];

// Authorization for the hotel dashboard (/hotel/[hotelClientId]). A user reaches a
// hotel only via a HotelMember grant on THAT hotel, or as an agency member of the
// agency that owns it. Returns null when not allowed (route → 404).
//
// What they can then SEE is not uniform, which is why `can` travels with the
// viewer: a marketing user has no viewGuestDetails, so the visitor-journey list
// must not render for them. Handing surfaces the same predicate the guards use
// keeps the invite form's promise ("Marketing: can't see guest details") and the
// dashboard from drifting apart.

export type HotelViewerHotel = {
  id: string;
  agencyId: string;
  name: string;
  websiteUrl: string;
  siteId: string;
  snippetStatus: string;
  /** IANA zone the property operates in; every day boundary is cut in it. */
  timezone: string;
  lastEventAt: Date | null;
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

export type HotelViewer = {
  hotel: HotelViewerHotel;
  userId: string;
  isOwner: boolean;
  canEdit: boolean;
  /** The shared capability predicate — the same one the guards call. */
  can: (capability: HotelCapability) => boolean;
};

export async function resolveHotelForViewer(hotelClientId: string): Promise<HotelViewer | null> {
  // Authorization is delegated to the single gate (lib/hotel-access.ts) so this
  // loader cannot drift from it. hotelClientId is never trusted for tenancy
  // there: the hotel row is resolved first and agencyId read off it, then the
  // membership is looked up by the composite (hotelClientId, clerkId) key.
  const access = await resolveHotelAccess(hotelClientId);
  if (!access) return null;
  const { userId } = await auth();
  if (!userId) return null;

  const hotel = await prisma.hotelClient.findFirst({
    where: { id: hotelClientId, deletedAt: null },
    select: {
      id: true, agencyId: true, name: true, websiteUrl: true, siteId: true, snippetStatus: true,
      timezone: true,
      lastEventAt: true, lastSyncedAt: true, showAdSpendToHotel: true, createdByUserId: true,
      contactName: true, contactEmail: true, contactPhone: true, address: true,
      whatsappNumber: true, roomCount: true, channelManager: true, otaCommissionRate: true,
      agency: {
        select: { name: true, mobile: true, contactEmail: true, address: true, websiteUrl: true, whatsappNumber: true, suspendedAt: true },
      },
    },
  });
  if (!hotel || hotel.agency.suspendedAt) return null;

  // "Owner" now means the hotel-side owner ROLE, not "the row that happens to
  // record who signed up". Edit rights follow the capability, so the rule lives
  // in one table rather than being re-derived here.
  const isOwner = access.principal.kind === "hotel" && access.principal.role === "hotel_owner";
  return {
    hotel: hotel as unknown as HotelViewerHotel,
    userId,
    isOwner,
    canEdit: access.can("manageHotelSettings"),
    can: access.can,
  };
}

export type HotelOwnerAccess = {
  agencyId: string;
  hotelId: string;
  isOwner: boolean;
  /** True when the viewer is an agency member of the owning agency (not the hotel owner). */
  isAgencyMember: boolean;
  /** The shared capability predicate, so a data route can gate on what it returns. */
  can: (capability: HotelCapability) => boolean;
  /**
   * Whether ad spend and every spend-derived figure may reach this caller.
   *
   * ALWAYS true for a Clerk session — the agency obviously sees its own spend,
   * and a signed-in hotel user sees their own hotel's (a deliberate, documented
   * decision: showAdSpendToHotel has never gated the logged-in dashboard).
   *
   * On a /share/<uuid> link it carries the hotel's showAdSpendToHotel flag, so
   * the read routes strip spend for exactly the hotels whose agency chose to
   * hide it. Without this the report's server-rendered half would honour the
   * toggle while its client-fetched half quietly ignored it.
   */
  spendVisible: boolean;
};

/**
 * Authorization gate for the hotel-owner DATA routes (/api/hotel/[hotelClientId]/*).
 *
 * A request is authorized only when the signed-in Clerk user holds a HotelMember
 * grant on THIS hotel, or is an agency member of the agency that owns it. Returns
 * the owning
 * agencyId so the caller can scope reads via runWithAgencyScope(agencyId, …);
 * returns null when the user has no access (the route then answers 403/404).
 *
 * This NEVER trusts the URL for tenancy: agencyId comes from the HotelClient row,
 * and reads stay filtered by both agencyId and hotelClientId. A hotel owner can
 * therefore only ever reach their own hotel — a different hotelClientId (even in
 * the same agency) resolves to a row they don't own, so access is denied.
 */
export async function requireHotelOwnerAccess(hotelClientId: string): Promise<HotelOwnerAccess | null> {
  // Delegates to the single gate. Returns the owning agencyId so the caller can
  // run the existing agency-scoped loaders via runWithAgencyScope — hotel
  // surfaces reuse the SAME tenancy layer rather than introducing a second one.
  const access = await resolveHotelAccess(hotelClientId);
  if (!access) return null;
  return {
    agencyId: access.agencyId,
    hotelId: access.hotelClientId,
    isOwner: access.principal.kind === "hotel" && access.principal.role === "hotel_owner",
    isAgencyMember: access.principal.kind === "agency",
    can: access.can,
    // A session — agency member or granted hotel user — always sees spend.
    spendVisible: true,
  };
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
  if (shareTokenDashboardRetired()) return null; // /h dashboard retired by product decision
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

  // A share-token holder is an anonymous stranger, so it holds NO capability —
  // not even viewPerformance. The /h/ dashboard is retired above; any future
  // token surface must therefore opt into each capability deliberately rather
  // than inherit a hotel user's.
  return {
    agencyId: hotel.agencyId,
    hotelId: hotel.id,
    isOwner: false,
    isAgencyMember: false,
    can: () => false,
    spendVisible: false,
  };
}

/**
 * Authorization gate for the PUBLIC /share/<uuid> report link.
 *
 * The ShareLink token IS the credential — there is no session. Everything about
 * whether the link is live (revoked, expired, hotel soft-deleted, agency
 * suspended, password not yet entered in this browser) is decided by
 * resolveShareLink(), the SAME function the page itself calls, so the report and
 * the routes feeding it can never disagree about whether the link still works.
 *
 * Two things are checked here and nowhere else:
 *
 *   1. The link must address THIS hotel. A valid token for hotel A asking for
 *      hotel B — `/api/hotel/<B>/...` with A's token in the header — is refused,
 *      even when both hotels belong to the same agency.
 *   2. agencyId comes off the ShareLink row, never the request, so the caller's
 *      runWithAgencyScope() stays pinned to the owning tenant.
 *
 * Returns null — never throws — for every failure, so callers answer 404 and we
 * never confirm that a token happened to be well-formed.
 */
export async function requireShareLinkAccess(
  token: string | null | undefined,
  hotelClientId: string,
): Promise<HotelOwnerAccess | null> {
  const resolution = await resolveShareLink(token);
  if (!resolution.ok) return null;
  const { link } = resolution;
  // The token must address THIS hotel — never a sibling, even in the same agency.
  if (link.hotelClientId !== hotelClientId) return null;

  return {
    agencyId: link.agencyId,
    hotelId: link.hotelClientId,
    // A link-holder is a read-only stranger: never an owner, never the agency.
    // Any route that gates on either of these keeps refusing them.
    isOwner: false,
    isAgencyMember: false,
    can: (capability) => SHARE_LINK_CAPABILITIES.includes(capability),
    // The one place the hotel's showAdSpendToHotel flag enters the data routes.
    spendVisible: link.showAdSpend,
  };
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
 *
 * Two token shapes can arrive in that header, and they are NOT equivalent:
 *   • a /share/<uuid> ShareLink token → authorized (expiry + revocation +
 *     optional password all enforced by resolveShareLink)
 *   • the legacy 64-hex HotelClient.shareToken → still retired, grants nothing
 * The uuid gate is tried first; the legacy gate is kept so the retirement stays
 * an explicit, tested refusal rather than an accident of shape-matching.
 */
export type ReadAccessResult =
  | { ok: true; access: HotelOwnerAccess }
  | { ok: false; status: 403 | 404 };

export async function requireReadAccess(req: Request, hotelClientId: string): Promise<ReadAccessResult> {
  const headerToken = req.headers.get(SHARE_TOKEN_HEADER);
  if (headerToken) {
    const shareLink = await requireShareLinkAccess(headerToken, hotelClientId);
    if (shareLink) return { ok: true, access: shareLink };
    const access = await requireShareTokenAccess(headerToken, hotelClientId);
    return access ? { ok: true, access } : { ok: false, status: 404 };
  }
  const access = await requireHotelOwnerAccess(hotelClientId);
  return access ? { ok: true, access } : { ok: false, status: 403 };
}
