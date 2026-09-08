import "server-only";

import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { unlockCookieName, verifyUnlock } from "@/lib/share";
import type { AgencyContact } from "@/lib/agency-contact";

// ─────────────────────────────────────────────────────────────────────────────
// THE /share/<uuid> gate.
//
// One function answers "is this link live, and which hotel does it address?" for
// BOTH surfaces that trust the token:
//
//   • app/share/[uuid]/page.tsx  — renders the report
//   • lib/hotel-auth.ts          — authorizes the /api/hotel/[id]/* read routes
//     that the report's client components call
//
// They must never disagree. A page that renders while its data routes 404 (or
// worse, the reverse) is the failure mode this module exists to make impossible:
// revocation, expiry, a soft-deleted hotel, a suspended agency and the password
// gate are all evaluated HERE, once.
//
// TENANCY. The token is the only credential — there is no session — so agencyId
// and hotelClientId are read OFF THE ShareLink ROW, never from the URL or a
// header. Callers pass the resolved agencyId to runWithAgencyScope()/
// agencyScopedFor(), so every downstream query stays filtered by agency AND
// hotel. A caller who presents link A's token while asking for hotel B is
// rejected by the explicit hotel comparison in lib/hotel-auth.ts.
//
// FAILS CLOSED. Every unresolvable case returns ok:false. The distinct reasons
// exist for the PAGE's copy (an expired link and a revoked one need different
// wording); the API gate collapses them all to a 404 so it never confirms that a
// token was well-formed, or that a hotel exists.
// ─────────────────────────────────────────────────────────────────────────────

/** ShareLink.token is a Prisma `@default(uuid())` — v4, 8-4-4-4-12 hex. */
export function isShareLinkTokenShape(token: string | null | undefined): boolean {
  return (
    typeof token === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
  );
}

/** The parts of a live share link its two consumers need. */
export type ShareLinkRecord = {
  linkId: string;
  token: string;
  agencyId: string;
  hotelClientId: string;
  hotelName: string;
  websiteUrl: string;
  agencyName: string;
  agencyPlan: string;
  /** For the report's read-only "Contact your agency" card. */
  agencyContact: AgencyContact;
  /**
   * The hotel's showAdSpendToHotel flag, carried here so the report and the data
   * routes gate spend on the SAME value. This is the one place the flag is read
   * for the share surface.
   */
  showAdSpend: boolean;
};

export type ShareLinkResolution =
  /** Live, unlocked, and addressing an active hotel. */
  | { ok: true; link: ShareLinkRecord }
  /**
   * Password-protected and this browser has not unlocked it. The record travels
   * with the refusal so the page can name the hotel on the password screen —
   * that is not a leak: the person was handed the link.
   */
  | { ok: false; reason: "locked"; link: ShareLinkRecord }
  /** Unknown token, revoked link, or a suspended agency — deliberately merged. */
  | { ok: false; reason: "unavailable" }
  /** The hotel itself was soft-deleted; its data is intentionally gone. */
  | { ok: false; reason: "gone" }
  | { ok: false; reason: "expired" };

/**
 * Resolve a /share/<uuid> token.
 *
 * @param token       the uuid from the URL or the share-token header
 * @param now         injectable clock, so expiry is testable without sleeping
 */
export async function resolveShareLink(
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<ShareLinkResolution> {
  const t = (token ?? "").trim();
  // Cheap shape guard: avoids a DB round-trip on obviously-bogus tokens, and
  // keeps the legacy 64-hex /h token (a DIFFERENT credential, still retired)
  // from ever being looked up here.
  if (!isShareLinkTokenShape(t)) return { ok: false, reason: "unavailable" };

  const link = await prisma.shareLink.findUnique({
    where: { token: t },
    select: {
      id: true,
      agencyId: true,
      hotelClientId: true,
      passwordHash: true,
      expiresAt: true,
      revokedAt: true,
      hotelClient: {
        select: { name: true, websiteUrl: true, deletedAt: true, showAdSpendToHotel: true },
      },
      agency: {
        select: {
          name: true, plan: true, suspendedAt: true,
          mobile: true, contactEmail: true, address: true,
          websiteUrl: true, whatsappNumber: true,
        },
      },
    },
  });

  // Unknown / revoked / suspended agency all answer the same way — which of the
  // three it was is not the holder's business.
  if (!link || link.revokedAt || link.agency.suspendedAt) {
    return { ok: false, reason: "unavailable" };
  }
  if (link.hotelClient.deletedAt) return { ok: false, reason: "gone" };
  if (link.expiresAt < now) return { ok: false, reason: "expired" };

  const record: ShareLinkRecord = {
    linkId: link.id,
    token: t,
    agencyId: link.agencyId,
    hotelClientId: link.hotelClientId,
    hotelName: link.hotelClient.name,
    websiteUrl: link.hotelClient.websiteUrl,
    agencyName: link.agency.name,
    agencyPlan: link.agency.plan,
    agencyContact: {
      mobile: link.agency.mobile,
      contactEmail: link.agency.contactEmail,
      address: link.agency.address,
      websiteUrl: link.agency.websiteUrl,
      whatsappNumber: link.agency.whatsappNumber,
    },
    showAdSpend: link.hotelClient.showAdSpendToHotel,
  };

  // The password gate is enforced here rather than only on the page, so the data
  // routes cannot be read straight past a lock screen with a copied token.
  if (link.passwordHash) {
    const jar = await cookies();
    if (!verifyUnlock(t, jar.get(unlockCookieName(t))?.value)) {
      return { ok: false, reason: "locked", link: record };
    }
  }

  return { ok: true, link: record };
}
