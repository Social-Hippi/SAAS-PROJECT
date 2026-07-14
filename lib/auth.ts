import { cache } from "react";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import type { Role } from "@/types/globals";

/**
 * Loads the AgencyMember (with its Agency) for the currently signed-in Clerk
 * user, or null if not signed in / not yet onboarded.
 *
 * Wrapped in React `cache` so a layout and the page it wraps share one DB query
 * within the same request render.
 */
export const getCurrentMember = cache(async () => {
  const { userId } = await auth();
  if (!userId) return null;

  return prisma.agencyMember.findUnique({
    where: { clerkId: userId },
    include: { agency: true },
  });
});

/**
 * Returns the current AgencyMember (with its Agency) ONLY when they are an agency
 * ADMIN, otherwise null. This is the single source of truth for the admin rule —
 * reused by every ad-account-connect route/action and the journeys view so the
 * check is enforced SERVER-SIDE, never just hidden in the UI. Callers reject in
 * their own idiom: route handlers redirect or return 403; server actions return
 * an error object. `cache`d to share the lookup within one request render.
 */
export const requireAdmin = cache(async () => {
  const member = await getCurrentMember();
  if (!member || member.role !== "admin") return null;
  return member;
});

/**
 * Resolves the signed-in user's platform role from the Clerk session token,
 * falling back to a direct user lookup when the token doesn't carry the metadata
 * claim (mirrors the resilient logic in proxy.ts). Returns undefined when signed
 * out or role-less. `cache`d so the admin layout + page share one resolution.
 */
export const getPlatformRole = cache(async (): Promise<Role | undefined> => {
  const { userId, sessionClaims } = await auth();
  if (!userId) return undefined;

  let role = sessionClaims?.metadata?.role;
  if (!role) {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    role = user.publicMetadata?.role;
  }
  return role;
});
