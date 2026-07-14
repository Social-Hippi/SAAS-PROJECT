// Platform-level roles, stored in Clerk publicMetadata and surfaced on the
// session token (see Clerk dashboard: Sessions → add `{"metadata":
// "{{user.public_metadata}}"}` to the session token claims).
export type Role = "super_admin" | "agency_admin" | "hotel_client";

declare global {
  // Shape of the custom claims we expose on the Clerk session JWT — read in
  // proxy.ts via `auth().sessionClaims?.metadata?.role`.
  interface CustomJwtSessionClaims {
    metadata: {
      role?: Role;
    };
    // Optional primary email on the session token. Present only if the Clerk
    // dashboard session claims include `{"email": "{{user.primary_email_address}}"}`.
    // Used ONLY for the best-effort staff-domain check in proxy.ts — never the
    // authoritative gate (that lives in createAgencyForCurrentUser).
    email?: string;
  }

  // Augments the type accepted by `clerkClient.users.updateUserMetadata`.
  interface UserPublicMetadata {
    role?: Role;
  }
}
