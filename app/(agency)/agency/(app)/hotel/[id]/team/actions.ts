"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { isHotelRole } from "@/lib/hotel-capabilities";
import { inviteHotelUser, removeHotelMember, revokeHotelInvite } from "@/lib/hotel-team";

// Agency-side management of who can see a hotel.
//
// requireAdmin() on every action: granting another person access to a client's
// data is an administrative act, and it matches the existing rule that agency
// analysts cannot change integrations or delete hotels. It is enforced HERE,
// server-side — a server action is a POST endpoint, so hiding the form would not
// be authorization.
//
// Every lookup is agencyScoped, so a hotelClientId from the request resolves to
// nothing when it belongs to another agency and the action reports "not found"
// rather than acting on it.

export type TeamActionState = { ok: boolean; error?: string; notice?: string };

/** The hotel, but only if it belongs to the caller's agency. */
async function ownedHotel(hotelClientId: string) {
  return agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelClientId },
    select: { id: true, name: true },
  });
}

export async function inviteHotelUserAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const member = await requireAdmin();
  if (!member) {
    return { ok: false, error: "Only an agency admin can invite people to a hotel." };
  }

  const hotelClientId = String(formData.get("hotelClientId") ?? "").trim();
  const rawEmail = String(formData.get("email") ?? "");
  const role = String(formData.get("role") ?? "");

  if (!isHotelRole(role)) return { ok: false, error: "Choose an access level." };

  const hotel = await ownedHotel(hotelClientId);
  if (!hotel) return { ok: false, error: "That hotel wasn't found for your agency." };

  const result = await inviteHotelUser({
    agencyId: member.agencyId,
    hotelClientId: hotel.id,
    rawEmail,
    role,
    invitedByAgencyMemberId: member.id,
    hotelName: hotel.name,
    agencyName: member.agency.name,
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/agency/hotel/${hotel.id}/team`);
  return {
    ok: true,
    notice: result.alreadyMember
      ? `${result.email} already has access to this hotel.`
      : `Invitation sent to ${result.email}.`,
  };
}

export async function revokeHotelInviteAction(formData: FormData): Promise<void> {
  const member = await requireAdmin();
  if (!member) return;
  const inviteId = String(formData.get("inviteId") ?? "").trim();
  const hotelClientId = String(formData.get("hotelClientId") ?? "").trim();
  if (!inviteId) return;
  await revokeHotelInvite({ agencyId: member.agencyId, inviteId });
  revalidatePath(`/agency/hotel/${hotelClientId}/team`);
}

export async function removeHotelMemberAction(formData: FormData): Promise<void> {
  const member = await requireAdmin();
  if (!member) return;
  const memberId = String(formData.get("memberId") ?? "").trim();
  const hotelClientId = String(formData.get("hotelClientId") ?? "").trim();
  if (!memberId) return;
  await removeHotelMember({ agencyId: member.agencyId, memberId });
  revalidatePath(`/agency/hotel/${hotelClientId}/team`);
}
