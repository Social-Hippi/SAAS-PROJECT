import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { signOauthState } from "@/lib/signed-state";
import { buildAuthorizeUrl } from "@/lib/instagram";

// Step 1 of the Instagram Login (IGAA) OAuth flow. The signed-in agency member
// clicks "Log in with Instagram" on a hotel's integrations page; we verify the
// hotel belongs to their agency (multi-tenant guard), mint a signed 10-minute
// state token binding (agencyId, hotelClientId), and hand the browser to
// Instagram's authorize screen.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  // Connecting an ad account is ADMIN-only, enforced server-side (not just hidden
  // in the UI). A non-admin (analyst) or non-member is bounced to the dashboard.
  const member = await requireAdmin();
  if (!member) redirect("/agency/dashboard");

  const url = new URL(request.url);
  const hotelClientId = (url.searchParams.get("hotelClientId") ?? "").trim();
  if (!hotelClientId) {
    return Response.json({ error: "Missing hotelClientId." }, { status: 400 });
  }

  // Multi-tenant guard: never start an OAuth flow for another agency's hotel.
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelClientId },
    select: { id: true },
  });
  if (!hotel) {
    return Response.json({ error: "Hotel not found for your agency." }, { status: 404 });
  }

  const state = signOauthState({ hotelClientId: hotel.id, agencyId: member.agencyId });

  let authorizeUrl: string;
  try {
    authorizeUrl = buildAuthorizeUrl(state);
  } catch (err) {
    console.error("[IG-OAUTH] start: buildAuthorizeUrl FAILED:", err instanceof Error ? err.message : err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Instagram Login is not configured." },
      { status: 500 },
    );
  }

  // Log the OAuth params prod is actually sending (all PUBLIC — client_id,
  // redirect_uri, scope). The redirect_uri here MUST exactly match a "Valid
  // OAuth Redirect URI" in the Meta/Instagram app, or Instagram rejects the
  // authorize request on its own page and never calls our callback back.
  try {
    const au = new URL(authorizeUrl);
    console.log(
      "[IG-OAUTH] start → redirecting to Instagram:",
      JSON.stringify({
        authorizeHost: au.host,
        client_id: au.searchParams.get("client_id"),
        redirect_uri: au.searchParams.get("redirect_uri"),
        scope: au.searchParams.get("scope"),
        hotelClientId,
      }),
    );
  } catch {
    // logging must never block the redirect
  }

  redirect(authorizeUrl);
}
