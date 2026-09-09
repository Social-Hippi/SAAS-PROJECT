"use server";

import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { ensureInviteCode } from "@/lib/hotel-invite";
import { isAllowedStaffEmail } from "@/lib/access";
import { validateAgencyName } from "@/lib/agency-validation";

/**
 * Provisions an Agency for a freshly signed-up user: creates the Agency and an
 * admin AgencyMember linked to their Clerk ID, then marks their platform role
 * as `agency_admin` in Clerk publicMetadata so Proxy (middleware) can gate
 * routes. Idempotent — safe to call twice.
 */
export async function createAgencyForCurrentUser(formData: FormData) {
  const { userId } = await auth();
  if (!userId) return { error: "You must be signed in." };

  // Same validator Agency Settings uses (saveAgencyName), so the two write
  // paths for this one organisation-level value cannot diverge.
  const parsed = validateAgencyName(String(formData.get("agencyName") ?? ""));
  if (!parsed.ok) return { error: parsed.error };
  const name = parsed.name;

  const user = await currentUser();
  // L1: a hotel-owner (hotel_client) must not self-promote into an agency_admin
  // by calling onboarding directly — they're a view-only login for their own
  // hotel. Block before any agency is created or the role is overwritten below.
  // (Role-less new signups and existing agency_admins re-running this pass.)
  if (user?.publicMetadata?.role === "hotel_client") {
    return { error: "This account is a hotel login and can't create an agency." };
  }
  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress ??
    "";

  // AUTHORITATIVE staff-access gate: only a Social Hippi staff email may ever
  // provision an agency or be granted the agency_admin role. Enforced here at the
  // single provisioning choke point — before any Agency/AgencyMember is created
  // or the Clerk role is stamped — so a non-staff account can never obtain access
  // even if it reaches this action directly. (The Clerk allowlist + proxy check
  // are perimeters on top of this; correctness does not depend on them.)
  if (!isAllowedStaffEmail(email)) {
    return { error: "Access is restricted to Social Hippi staff accounts." };
  }

  const fullName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    email ||
    "Agency owner";

  // Only create if this Clerk user isn't already attached to an agency.
  const existing = await prisma.agencyMember.findUnique({
    where: { clerkId: userId },
  });
  if (!existing) {
    const agency = await prisma.agency.create({
      data: {
        name,
        email,
        members: {
          create: {
            clerkId: userId,
            email,
            name: fullName,
            role: "admin", // MemberRole within the agency
          },
        },
      },
      select: { id: true },
    });
    // Auto-generate the hotel self-signup invite code for the new agency.
    await ensureInviteCode(agency.id);
  }

  const client = await clerkClient();
  await client.users.updateUserMetadata(userId, {
    publicMetadata: { role: "agency_admin" },
  });

  return { ok: true };
}
