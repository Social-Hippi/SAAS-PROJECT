import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant-scope";
import { renderEmail, sendEmail, lead, p, esc } from "@/lib/email";
import {
  evaluateHotelInvite,
  hashHotelInviteToken,
  hotelInviteExpiry,
  isHotelInviteTokenShape,
  mintHotelInviteToken,
  normalizeInviteEmail,
  HOTEL_INVITE_REJECTION_MESSAGE,
  type HotelInviteRejection,
} from "@/lib/hotel-user-invite";
import { HOTEL_ROLE_LABEL, type HotelRole } from "@/lib/hotel-capabilities";

// ─────────────────────────────────────────────────────────────────────────────
// Hotel team management — the DB half of per-person hotel invitations.
//
// The pure half (tokens, the state machine, the rejection reasons) lives in
// lib/hotel-user-invite.ts so it is testable without a database; this file does
// the writes and the email.
//
// EVERY read and write here goes through agencyScopedFor, so the existing
// tenancy layer is what enforces isolation — there is no second mechanism. The
// caller has already resolved the agency from the session; this module never
// takes an agencyId from a request.
// ─────────────────────────────────────────────────────────────────────────────

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export type InviteResult =
  | { ok: true; inviteId: string; email: string; alreadyMember: false }
  | { ok: true; inviteId: null; email: string; alreadyMember: true }
  | { ok: false; error: string };

/**
 * Invite one person to one hotel.
 *
 * Duplicate handling is deliberate rather than a unique-constraint bounce:
 *   • already a MEMBER of this hotel → reported as such, no invite created. The
 *     caller shows "they already have access", which is not an error.
 *   • an outstanding PENDING invite → it is REVOKED and a fresh one issued, so
 *     re-inviting always produces a working link. Leaving the old one live would
 *     mean two valid tokens for one seat.
 */
export async function inviteHotelUser(args: {
  agencyId: string;
  hotelClientId: string;
  rawEmail: string;
  role: HotelRole;
  /**
   * Which AGENCY member issued this, or null when the hotel invited its own
   * person. Nullable rather than a fabricated id: an owner adding their GM is
   * not an agency action, and recording it as one would put a false name on the
   * audit trail. The column has always been optional; this is the case it was
   * optional for.
   */
  invitedByAgencyMemberId: string | null;
  hotelName: string;
  /**
   * The name the invitation is signed with — the agency when the agency sends
   * it, the hotel when the hotel sends its own. Required rather than defaulted
   * to the agency: an email apparently from an agency that did not send it is a
   * small dishonesty, and a default is how one gets shipped by accident.
   */
  invitedByLabel: string;
}): Promise<InviteResult> {
  const scoped = <D>(m: D) => agencyScopedFor(args.agencyId, m);

  const email = normalizeInviteEmail(args.rawEmail);
  if (!email) return { ok: false, error: "Enter a valid email address." };

  // The hotel must belong to the caller's agency. agencyScopedFor makes a
  // foreign hotel simply yield no row, so this doubles as the tenancy check.
  const hotel = await scoped(prisma.hotelClient).findFirst({
    where: { id: args.hotelClientId },
    select: { id: true },
  });
  if (!hotel) return { ok: false, error: "That hotel wasn't found for your agency." };

  const existingMember = await scoped(prisma.hotelMember).findFirst({
    where: { hotelClientId: hotel.id, email },
    select: { id: true },
  });
  if (existingMember) {
    return { ok: true, inviteId: null, email, alreadyMember: true };
  }

  // Supersede any outstanding invitation for this address at this hotel.
  await scoped(prisma.hotelUserInvite).updateMany({
    where: { hotelClientId: hotel.id, email, status: "PENDING" },
    data: { status: "REVOKED", revokedAt: new Date() },
  });

  const { token, tokenHash } = mintHotelInviteToken();
  const invite = await scoped(prisma.hotelUserInvite).create({
    data: {
      // Explicit per MULTITENANCY.md: Prisma's static types require agencyId in
      // create.data. agencyScopedFor also injects it at runtime, so the wrapper
      // remains the guarantee — this satisfies the compiler with the same value.
      agencyId: args.agencyId,
      hotelClientId: hotel.id,
      email,
      role: args.role,
      tokenHash,
      expiresAt: hotelInviteExpiry(),
      invitedByAgencyMemberId: args.invitedByAgencyMemberId,
    },
    select: { id: true },
  });

  // The raw token exists only here and in the email — never in the database.
  await sendHotelInviteEmail({
    to: email,
    token,
    hotelName: args.hotelName,
    invitedByLabel: args.invitedByLabel,
    role: args.role,
  });

  return { ok: true, inviteId: invite.id, email, alreadyMember: false };
}

async function sendHotelInviteEmail(opts: {
  to: string;
  token: string;
  hotelName: string;
  /** The name the recipient will recognise — their agency, or their own hotel. */
  invitedByLabel: string;
  role: HotelRole;
}): Promise<void> {
  const url = `${APP_URL}/hotel-invite/${opts.token}`;
  const html = renderEmail({
    heading: `You've been given access to ${opts.hotelName}`,
    preheader: `${opts.invitedByLabel} has invited you to view ${opts.hotelName} on HotelTrack.`,
    bodyHtml:
      lead(`<strong>${esc(opts.invitedByLabel)}</strong> has invited you to HotelTrack.`) +
      p(
        `You'll be able to see how ${esc(opts.hotelName)} is performing — where guests are coming from, which marketing is working, and what it's producing.`,
      ) +
      p(`Your access level: <strong>${esc(HOTEL_ROLE_LABEL[opts.role])}</strong>.`) +
      p(`This link works once and expires in 14 days.`),
    cta: { label: "Accept invitation", url },
  });

  await sendEmail({
    to: opts.to,
    subject: `${opts.invitedByLabel} invited you to view ${opts.hotelName}`,
    html,
  });
}

/** Revoke an outstanding invitation. Idempotent; only PENDING rows change. */
export async function revokeHotelInvite(args: {
  agencyId: string;
  inviteId: string;
}): Promise<{ ok: boolean }> {
  const res = await agencyScopedFor(args.agencyId, prisma.hotelUserInvite).updateMany({
    where: { id: args.inviteId, status: "PENDING" },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
  return { ok: res.count > 0 };
}

/**
 * A refusal is a CODE, not a sentence.
 *
 * The hotel surface has to get this across a redirect to re-render the page, and
 * a message carried in a query string is a message an attacker can write: a
 * crafted link would put arbitrary text on our page in our voice. The code is
 * from a closed set and the wording lives on the page.
 */
export type RemoveRefusal = "last_owner" | "not_found";

export type RemoveResult = { ok: true } | { ok: false; reason: RemoveRefusal };

/**
 * Remove a person's access to a hotel.
 *
 * `requireRemainingOwner` exists because the two callers are in genuinely
 * different positions, and collapsing them would be wrong in one direction or
 * the other:
 *
 *   • A HOTEL owner managing their own team passes true. Removing the last owner
 *     from the hotel side is a door that locks from the inside — the person
 *     doing it is the only one who could undo it, and afterwards nobody at the
 *     hotel can invite anyone. They are told to add another owner first.
 *
 *   • The AGENCY passes false. An agency revoking every hotel login is a
 *     legitimate thing to do (an account closes, a contract ends), it does not
 *     lock the agency out of anything, and the agency can re-invite at will.
 *     Blocking it would be protecting them from a decision that is theirs.
 */
export async function removeHotelMember(args: {
  agencyId: string;
  memberId: string;
  requireRemainingOwner: boolean;
}): Promise<RemoveResult> {
  const scoped = <D>(m: D) => agencyScopedFor(args.agencyId, m);

  if (args.requireRemainingOwner) {
    const target = await scoped(prisma.hotelMember).findFirst({
      where: { id: args.memberId },
      select: { hotelClientId: true, role: true },
    });
    if (!target) return { ok: false, reason: "not_found" };

    if (target.role === "hotel_owner") {
      const owners = await scoped(prisma.hotelMember).count({
        where: { hotelClientId: target.hotelClientId, role: "hotel_owner" },
      });
      if (owners <= 1) return { ok: false, reason: "last_owner" };
    }
  }

  const res = await scoped(prisma.hotelMember).deleteMany({
    where: { id: args.memberId },
  });
  return res.count > 0 ? { ok: true } : { ok: false, reason: "not_found" };
}

export type AcceptOutcome =
  | { ok: true; hotelClientId: string; hotelName: string; role: HotelRole }
  | { ok: false; reason: HotelInviteRejection; message: string };

/**
 * Accept an invitation for the signed-in Clerk user.
 *
 * Not agency-scoped, and it cannot be: the accepting user has no agency context
 * yet — resolving one from the TOKEN is the whole point. Tenancy comes from the
 * invitation row, which was itself written under an agency scope.
 *
 * Idempotent by construction: the membership is an upsert on
 * (hotelClientId, clerkId), so a double-submitted accept updates the role rather
 * than creating a second grant, and the invite transition is guarded on PENDING
 * so a replayed request cannot re-accept a consumed token.
 */
export async function acceptHotelInvite(args: {
  token: string;
  clerkId: string;
  userEmail: string;
  userName: string;
}): Promise<AcceptOutcome> {
  if (!isHotelInviteTokenShape(args.token)) {
    return { ok: false, reason: "malformed", message: HOTEL_INVITE_REJECTION_MESSAGE.malformed };
  }

  const invite = await prisma.hotelUserInvite.findUnique({
    where: { tokenHash: hashHotelInviteToken(args.token) },
    select: {
      id: true,
      agencyId: true,
      hotelClientId: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
      hotelClient: { select: { name: true, deletedAt: true } },
      agency: { select: { suspendedAt: true } },
    },
  });

  const verdict = evaluateHotelInvite(
    invite
      ? {
          status: invite.status,
          expiresAt: invite.expiresAt,
          hotelDeletedAt: invite.hotelClient.deletedAt,
          agencySuspendedAt: invite.agency.suspendedAt,
        }
      : null,
  );
  if (!verdict.ok) {
    return {
      ok: false,
      reason: verdict.reason,
      message: HOTEL_INVITE_REJECTION_MESSAGE[verdict.reason],
    };
  }
  // evaluateHotelInvite returning ok implies the row exists.
  const row = invite!;

  await prisma.$transaction(async (tx) => {
    await tx.hotelMember.upsert({
      where: {
        hotelClientId_clerkId: { hotelClientId: row.hotelClientId, clerkId: args.clerkId },
      },
      create: {
        agencyId: row.agencyId,
        hotelClientId: row.hotelClientId,
        clerkId: args.clerkId,
        email: args.userEmail.trim().toLowerCase(),
        name: args.userName,
        role: row.role,
      },
      update: { role: row.role },
    });

    // Guarded on PENDING so a replayed accept cannot consume it twice.
    await tx.hotelUserInvite.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedByClerkId: args.clerkId },
    });
  });

  return {
    ok: true,
    hotelClientId: row.hotelClientId,
    hotelName: row.hotelClient.name,
    role: row.role,
  };
}

/** What each refusal means to the person who clicked. Rendered by the page. */
export const REMOVE_REFUSAL_MESSAGE: Record<RemoveRefusal, string> = {
  last_owner:
    "This is the hotel's only owner. Invite another owner first, then remove this one.",
  not_found: "That person no longer has access — the list may have been out of date.",
};

export type HotelTeamRow = {
  kind: "member" | "invite";
  id: string;
  email: string;
  name: string | null;
  role: HotelRole;
  since: Date;
  expiresAt: Date | null;
};

/** The people on a hotel — current members plus outstanding invitations. */
export async function loadHotelTeam(args: {
  agencyId: string;
  hotelClientId: string;
}): Promise<HotelTeamRow[]> {
  const scoped = <D>(m: D) => agencyScopedFor(args.agencyId, m);
  const [members, invites] = await Promise.all([
    scoped(prisma.hotelMember).findMany({
      where: { hotelClientId: args.hotelClientId },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    }),
    scoped(prisma.hotelUserInvite).findMany({
      where: { hotelClientId: args.hotelClientId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, role: true, createdAt: true, expiresAt: true },
    }),
  ]);

  return [
    ...members.map((m): HotelTeamRow => ({
      kind: "member",
      id: m.id,
      email: m.email,
      name: m.name,
      role: m.role,
      since: m.createdAt,
      expiresAt: null,
    })),
    ...invites.map((i): HotelTeamRow => ({
      kind: "invite",
      id: i.id,
      email: i.email,
      name: null,
      role: i.role,
      since: i.createdAt,
      expiresAt: i.expiresAt,
    })),
  ];
}
