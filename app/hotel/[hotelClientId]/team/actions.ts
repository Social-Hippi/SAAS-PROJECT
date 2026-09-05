"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireHotelCapability } from "@/lib/hotel-access";
import { isHotelRole } from "@/lib/hotel-capabilities";
import { inviteHotelUser, removeHotelMember, revokeHotelInvite } from "@/lib/hotel-team";
import type { TeamActionState } from "@/lib/hotel-team-result";

// The hotel's OWN team actions.
//
// Every one of these re-resolves access from the session and the hotelClientId
// in the form, then demands "manageTeam". That is the whole authorization
// argument, and it is deliberately identical in shape to the agency actions
// next door: a server action is a POST endpoint, so the page having been gated
// proves nothing about the request.
//
// requireHotelCapability resolves the hotel row first and reads agencyId off it
// — the id in the form is a lookup key, never a claim. A hotelClientId the
// caller holds no grant on resolves to null and the action does nothing, so
// posting another hotel's id is indistinguishable from posting a typo.
//
// The agencyId used for every write comes from that resolved row, so these
// writes go through exactly the same tenancy layer as the agency's.

async function gate(formData: FormData) {
  const hotelClientId = String(formData.get("hotelClientId") ?? "").trim();
  if (!hotelClientId) return null;
  return requireHotelCapability(hotelClientId, "manageTeam");
}

export async function inviteToMyHotelAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const access = await gate(formData);
  if (!access) {
    return { ok: false, error: "You don't have permission to invite people to this hotel." };
  }

  const role = String(formData.get("role") ?? "");
  if (!isHotelRole(role)) return { ok: false, error: "Choose an access level." };

  const result = await inviteHotelUser({
    agencyId: access.agencyId,
    hotelClientId: access.hotelClientId,
    rawEmail: String(formData.get("email") ?? ""),
    role,
    // Not an agency action. Recording an agency member here would put a name on
    // the audit trail that had nothing to do with it.
    invitedByAgencyMemberId: null,
    hotelName: access.hotelName,
    // The recipient is being invited by their own hotel, and the email says so —
    // an invitation apparently from the agency, that the agency did not send, is
    // the kind of small dishonesty that gets a product distrusted.
    invitedByLabel: access.hotelName,
  });

  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/hotel/${access.hotelClientId}/team`);
  return {
    ok: true,
    notice: result.alreadyMember
      ? `${result.email} already has access.`
      : `Invitation sent to ${result.email}.`,
  };
}

export async function revokeMyHotelInviteAction(formData: FormData): Promise<void> {
  const access = await gate(formData);
  if (!access) return;
  const inviteId = String(formData.get("inviteId") ?? "").trim();
  if (!inviteId) return;
  await revokeHotelInvite({ agencyId: access.agencyId, inviteId });
  revalidatePath(`/hotel/${access.hotelClientId}/team`);
}

export async function removeMyHotelMemberAction(formData: FormData): Promise<void> {
  const access = await gate(formData);
  if (!access) return;
  const memberId = String(formData.get("memberId") ?? "").trim();
  if (!memberId) return;

  // requireRemainingOwner: from inside the hotel, removing the last owner locks
  // the door behind you — nobody left can invite anyone. See removeHotelMember.
  const result = await removeHotelMember({
    agencyId: access.agencyId,
    memberId,
    requireRemainingOwner: true,
  });

  const base = `/hotel/${access.hotelClientId}/team`;
  revalidatePath(base);
  if (!result.ok) {
    // A refusal has to be VISIBLE. This form posts and re-renders, so returning
    // quietly would leave the person looking at an unchanged list with no idea
    // whether the click registered — and they would try again.
    //
    // A code, not the message: the query string is attacker-writable, and a link
    // that prints arbitrary text on our own page in our own voice is worth more
    // to someone than the redirect is worth to us.
    redirect(`${base}?refused=${result.reason}`);
  }
}
