import {
  clerkClient,
  clerkMiddleware,
  createRouteMatcher,
} from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isAllowedStaffEmail } from "@/lib/access";

// Next.js 16 renamed Middleware -> Proxy. Clerk's clerkMiddleware() works here
// unchanged. This guards every non-public route and enforces the three platform
// roles by URL prefix.

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  // Public setup guide for hotels & agencies (no login needed to read it) and
  // the PDF download route. The /api/guide route resolves the agency from the
  // session itself and simply skips analytics when there's no session.
  "/setup-guide(.*)",
  "/api/guide(.*)",
  // Public, UUID-addressed hotel report links. No login: access is gated by the
  // unguessable token (and an optional password) inside the route itself.
  "/share(.*)",
  // Public, token-addressed hotel-owner dashboard (/h/<shareToken>). No login:
  // access is gated entirely by the unguessable 256-bit token inside the route,
  // which also enforces hotel-level data isolation.
  "/h(.*)",
  // Public hotel self-signup page (/join/<inviteCode>). No login to view; the
  // route resolves the agency from the code and the signup uses Clerk directly.
  "/join(.*)",
  // The tracking endpoints are called cross-origin by the snippet on hotel
  // websites with no auth — they must stay public (scoped by the public siteId).
  "/api/track(.*)",
  // The scheduled Meta sync is called by Vercel Cron (no Clerk session); it
  // enforces its own CRON_SECRET bearer-token check.
  "/api/meta/sync(.*)",
  // Daily Meta OAuth token-refresh cron (Vercel Cron, no Clerk session); gated
  // by its own CRON_SECRET bearer check. Without this entry Clerk redirects the
  // session-less cron to sign-in and the refresh never runs.
  "/api/meta/refresh-tokens(.*)",
  // Same pattern: cron-style trigger, gated by CRON_SECRET inside the route.
  "/api/alerts/run(.*)",
  "/api/instagram/sync(.*)",
  "/api/instagram/detect-tags(.*)",
  "/api/instagram/refresh-tokens(.*)",
  "/api/ga/sync(.*)",
  // Instagram OAuth callback: the browser arrives from instagram.com; the
  // signed 10-minute state token (bound to agency + hotel) is the auth.
  "/api/auth/instagram/callback(.*)",
  // Razorpay posts webhooks with no Clerk session; the route verifies the
  // Razorpay HMAC-SHA256 signature instead.
  "/api/webhooks/razorpay(.*)",
  // Renewal-reminder cron, gated by CRON_SECRET inside the route.
  "/api/billing/renewal-reminders(.*)",
  // Daily budget-threshold alert cron, gated by CRON_SECRET inside the route.
  "/api/budget/check(.*)",
  // Daily GA4 (OAuth) sync cron, gated by CRON_SECRET inside the route.
  "/api/ga4/sync(.*)",
  // GA4 OAuth callback: the browser arrives from accounts.google.com; the signed
  // 10-minute state token (bound to agency + hotel) is the auth.
  "/api/auth/ga4/callback(.*)",
  // Google Ads OAuth routes
  "/api/auth/google-ads/start(.*)",
  "/api/auth/google-ads/callback(.*)",
  // Daily visitor-journey 90-day retention cron, gated by CRON_SECRET in-route.
  "/api/cron/cleanup-journey(.*)",
]);
const isAgencyRoute = createRouteMatcher(["/agency(.*)"]);
const isOnboardingRoute = createRouteMatcher(["/agency/onboarding(.*)"]);
const isAdminRoute = createRouteMatcher(["/admin(.*)"]);
const isHotelRoute = createRouteMatcher(["/hotel(.*)"]);

// When the session token doesn't carry the metadata claim (Clerk dashboard
// not configured — see types/globals.d.ts), the role falls back to a Clerk
// API call costing ~400ms PER REQUEST and counting against Clerk's rate
// limit; on a dev instance the limit makes the whole app hang. Cache the
// fallback per user for a few minutes — proxy runs on the Node runtime, so
// this Map survives across warm requests. A stale entry only delays a role
// CHANGE (rare: set-super-admin); sign-in/out stays instant because Clerk
// resolves the session itself. Cold starts simply refetch.
type Role = "super_admin" | "agency_admin" | "hotel_client";
const ROLE_TTL_MS = 5 * 60_000;
const roleCache = new Map<string, { role: Role | undefined; exp: number }>();

async function lookupRoleUncached(userId: string): Promise<Role | undefined> {
  const cached = roleCache.get(userId);
  if (cached && cached.exp > Date.now()) return cached.role;

  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const role = user.publicMetadata?.role;

  // Crude size bound — clearing is fine, the cache is just an optimization.
  if (roleCache.size > 5000) roleCache.clear();
  roleCache.set(userId, { role, exp: Date.now() + ROLE_TTL_MS });
  return role;
}

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return NextResponse.next();

  const { userId, sessionClaims, redirectToSignIn } = await auth();

  // Unauthenticated users hitting a protected route -> sign in.
  if (!userId) {
    return redirectToSignIn({ returnBackUrl: req.url });
  }

  // Prefer the role from the session token. This requires the Clerk dashboard
  // session token to carry `{"metadata": "{{user.public_metadata}}"}` (see
  // types/globals.d.ts). If that claim isn't configured, the token won't have
  // it and `role` would be undefined — which would bounce an onboarded
  // agency_admin between /agency/dashboard and /agency/onboarding forever. To be
  // resilient, fall back to reading publicMetadata directly from Clerk.
  let role = sessionClaims?.metadata?.role;
  if (!role) {
    role = await lookupRoleUncached(userId);
  }
  const home = new URL("/", req.url);

  if (isAgencyRoute(req)) {
    // A freshly signed-up user has no role yet; let them reach onboarding to
    // provision their Agency (which then sets role = agency_admin).
    if (isOnboardingRoute(req)) {
      // Best-effort staff-domain gate: if the session token carries the email
      // claim and it isn't a Social Hippi staff address, don't even show
      // onboarding. This is defense-in-depth only — the AUTHORITATIVE gate is
      // createAgencyForCurrentUser (which re-checks the email server-side), so
      // correctness never depends on this claim being configured/present.
      const email = sessionClaims?.email;
      if (email && !isAllowedStaffEmail(email)) {
        return NextResponse.redirect(new URL("/?notice=restricted", req.url));
      }
      return NextResponse.next();
    }
    if (role !== "agency_admin") {
      // No agency role → send an already-onboarded-but-wrong-role user home, and a
      // brand-new (role-less) user to onboarding to provision their agency. (Hotel
      // logins are retired under the access lockdown, so there is no hotel_client
      // special case anymore.)
      return NextResponse.redirect(
        role ? home : new URL("/agency/onboarding", req.url),
      );
    }
    // Pass the pathname through so the agency app layout can allow the billing +
    // settings pages even when the subscription is inactive (see its gate).
    const headers = new Headers(req.headers);
    headers.set("x-pathname", req.nextUrl.pathname);
    return NextResponse.next({ request: { headers } });
  }

  if (isAdminRoute(req)) {
    if (role !== "super_admin") return NextResponse.redirect(home);
    return NextResponse.next();
  }

  if (isHotelRoute(req)) {
    // ACCESS LOCKDOWN: hotels no longer log in. The /hotel owner dashboard is
    // retired — the route itself now 404s via lib/hotel-auth. Only agency staff
    // may resolve here at all; any other role (incl. a legacy hotel_client) → home.
    if (role !== "agency_admin") return NextResponse.redirect(home);
    return NextResponse.next();
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files, unless found in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|pdf)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
