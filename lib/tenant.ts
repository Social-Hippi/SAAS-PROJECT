import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";
import { getCurrentMember, getPlatformRole } from "@/lib/auth";
import { agencyScopedFor } from "@/lib/tenant-scope";
import { isAllowedStaffEmail } from "@/lib/access";

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — Centralised agency-scoped query helpers (see MULTITENANCY.md).
//
// HotelTrack is multi-tenant: the tenant is `Agency`, and every multi-tenant
// table carries an `agencyId` column. Historically every query hand-wrote
// `where: { agencyId: member.agencyId, ... }`. That works but relies on a human
// remembering the filter on EVERY query — one omission is a cross-tenant leak.
//
// These helpers move that filter into one place:
//   • getAgencyContext()      — resolve the signed-in agency context (throws)
//   • requireAgencyId()       — the agencyId, rejecting super-admin callers
//   • requireSuperAdmin()     — guard for the separate, cross-agency admin surface
//   • agencyScoped(model)     — a Prisma delegate that auto-injects the filter
//   • agencyScopedFor(id, m)  — same, with an explicit agencyId (no session)
//
// The pure injection logic lives in lib/tenant-scope.ts (no "server-only") so
// the isolation tests can import it under Node. App code imports from here.
// ─────────────────────────────────────────────────────────────────────────────

export { agencyScopedFor, MULTI_TENANT_MODELS } from "@/lib/tenant-scope";

export class TenantAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantAuthError";
  }
}

export type AgencyContext = {
  agencyId: string;
  memberId: string;
  role: "admin" | "analyst";
};

/**
 * Resolves the current request's agency context from the Clerk session.
 * Throws TenantAuthError if the user is not signed in or has no AgencyMember.
 * `cache`d so repeated calls within one request render share the lookup.
 *
 * This is also the AUTHORITATIVE staff-access read gate. The domain rule was
 * previously enforced only at agency CREATION (createAgencyForCurrentUser), so a
 * member provisioned before the lockdown whose email is not a Social Hippi staff
 * address could still read agency data. Because every agency-scoped read/write
 * funnels through here (agencyScoped → requireAgencyId → getAgencyContext), the
 * check runs on EVERY request — reusing member.email (a stored column), so no
 * extra Clerk/DB call. A valid staff member's email passes and nothing changes.
 */
export const getAgencyContext = cache(async (): Promise<AgencyContext> => {
  const member = await getCurrentMember();
  if (!member) {
    throw new TenantAuthError(
      "No agency context: the user is not signed in or has no agency membership.",
    );
  }
  if (!isAllowedStaffEmail(member.email)) {
    throw new TenantAuthError(
      "Access is restricted to Social Hippi staff accounts.",
    );
  }
  return { agencyId: member.agencyId, memberId: member.id, role: member.role };
});

/**
 * Returns the current agency's id, EXPLICITLY rejecting super-admin callers.
 * Super admins have no single-agency context — they operate platform-wide and
 * must use `requireSuperAdmin()` + un-scoped queries instead.
 */
export async function requireAgencyId(): Promise<string> {
  const platformRole = await getPlatformRole();
  if (platformRole === "super_admin") {
    throw new TenantAuthError(
      "Super admins have no single-agency context. Use requireSuperAdmin() and " +
        "the dedicated platform-admin queries for cross-agency access.",
    );
  }
  const { agencyId } = await getAgencyContext();
  return agencyId;
}

/**
 * Guard for the separate super-admin surface. Throws unless the Clerk platform
 * role is `super_admin`. Super-admin code intentionally runs UN-scoped queries
 * (cross-agency by design) — it must never use agencyScoped().
 */
export async function requireSuperAdmin(): Promise<void> {
  const role = await getPlatformRole();
  if (role !== "super_admin") {
    throw new TenantAuthError("Super-admin privileges are required for this action.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hotel-owner scope override.
//
// Hotel owners (self-signup `hotel_client` users) are NOT AgencyMembers, so the
// session-based agencyScoped() path (requireAgencyId → getCurrentMember) throws
// for them. But every dashboard data loader already filters by hotelClientId AND
// goes through agencyScoped(), so the ONLY thing they need is the right agencyId.
//
// runWithHotelOwnerScope(agencyId, fn) installs a request-scoped agencyId that
// agencyScoped() prefers over the session lookup, for the duration of `fn`. The
// caller (a hotel-owner API route) MUST have already verified that the signed-in
// user owns a hotel belonging to `agencyId` (see lib/hotel-auth requireHotelOwnerAccess).
// Reads stay filtered by both agencyId and hotelClientId, so a hotel owner can
// only ever reach their own hotel's rows. Nothing here weakens the agency path:
// when no override is set, agencyScoped() behaves exactly as before.
// ─────────────────────────────────────────────────────────────────────────────
const agencyScopeOverride = new AsyncLocalStorage<string>();

export function runWithAgencyScope<T>(agencyId: string, fn: () => Promise<T>): Promise<T> {
  return agencyScopeOverride.run(agencyId, fn);
}

/**
 * The ergonomic form: resolves the agency context from the Clerk session on
 * each call, so it reads as `await agencyScoped(prisma.hotelClient).findMany(…)`.
 * Rejects super-admin callers (via requireAgencyId). Use this in authenticated
 * server components, server actions, and route handlers.
 *
 * Do NOT use this in code that may run without a session (the public /share
 * pages, the tracking endpoints, cron jobs) — there, pass the agencyId you
 * resolved from the token/siteId into `agencyScopedFor()` instead.
 *
 * When invoked inside runWithAgencyScope(agencyId, …), that explicit agencyId is
 * used instead of the session lookup (the hotel-owner read path).
 */
export function agencyScoped<D>(model: D): D {
  const target = model as Record<string, unknown>;

  return new Proxy(target, {
    get(t, prop: string) {
      const orig = t[prop];
      if (typeof orig !== "function") return orig;

      return async (args: unknown = {}) => {
        const override = agencyScopeOverride.getStore();
        const agencyId = override ?? (await requireAgencyId());
        const scoped = agencyScopedFor(agencyId, t) as Record<
          string,
          (a?: unknown) => unknown
        >;
        return scoped[prop](args);
      };
    },
  }) as D;
}
