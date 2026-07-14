// Single source of truth for the Social Hippi staff email-domain allowlist that
// decides who may hold agency/admin access. This is enforced SERVER-SIDE at the
// agency provisioning point (createAgencyForCurrentUser) and on the onboarding
// page, with best-effort defense-in-depth in proxy.ts. It is the real gate — the
// Clerk dashboard allowlist is a perimeter, never trusted on its own.
//
// No "server-only" import here on purpose: proxy.ts (the Clerk middleware) also
// imports this. It reads only process.env + a plain string, no secrets.

const DEFAULT_ALLOWED_DOMAIN = "socialhippi.com";

/** The configured staff email domain, lower-cased, without a leading "@". */
export function allowedAdminEmailDomain(): string {
  const raw = process.env.ALLOWED_ADMIN_EMAIL_DOMAIN?.trim().toLowerCase();
  return (raw ? raw.replace(/^@/, "") : "") || DEFAULT_ALLOWED_DOMAIN;
}

/**
 * True only when `email`'s domain exactly matches the configured staff domain.
 * Used as the authoritative gate for agency/admin provisioning: any other email
 * gets no membership and no `agency_admin` role. Exact-domain (not a loose
 * suffix) match, so look-alikes like "x@socialhippi.com.evil.com" never pass.
 */
export function isAllowedStaffEmail(email: string | null | undefined): boolean {
  const e = email?.trim().toLowerCase();
  if (!e) return false;
  const at = e.lastIndexOf("@");
  if (at === -1) return false;
  return e.slice(at + 1) === allowedAdminEmailDomain();
}
