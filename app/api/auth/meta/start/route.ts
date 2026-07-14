import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { signOauthState } from "@/lib/signed-state";
import { buildMetaAuthorizeUrl } from "@/lib/meta";

// Step 1 of the Meta (Facebook Login for Business) OAuth flow. The signed-in
// agency member clicks "Connect with Facebook" on a hotel's Integrations page;
// we mint a signed 10-minute state token and hand the browser to Facebook's
// authorize screen.
//
// The Meta token is HOTEL-scoped (one per hotel, like Instagram/GA4), so the
// hotelClientId query param is REQUIRED: we verify the hotel belongs to the
// agency, bind it into the signed state, and the callback stores the resulting
// token for exactly that hotel.

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
    return Response.json(
      { error: "hotelClientId is required to connect Meta for a hotel." },
      { status: 400 },
    );
  }

  // Multi-tenant guard: never start a flow for another agency's hotel.
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelClientId },
    select: { id: true },
  });
  if (!hotel) {
    return Response.json({ error: "Hotel not found for your agency." }, { status: 404 });
  }

  // State binds the round-trip to this agency + hotel (HMAC-signed, 10-min
  // expiry, nonce).
  const state = signOauthState({ hotelClientId, agencyId: member.agencyId });

  let authorizeUrl: string;
  try {
    authorizeUrl = buildMetaAuthorizeUrl(state);
  } catch (err) {
    console.error(
      "[META-OAUTH] start: buildMetaAuthorizeUrl FAILED:",
      err instanceof Error ? err.message : err,
    );
    return Response.json(
      { error: err instanceof Error ? err.message : "Meta Login is not configured." },
      { status: 500 },
    );
  }

  // Log the PUBLIC OAuth params (client_id, redirect_uri, scope). The redirect_uri
  // here MUST exactly match a "Valid OAuth Redirect URI" in the Meta app, or
  // Facebook rejects the authorize request and never calls our callback back.
  try {
    const au = new URL(authorizeUrl);
    console.log(
      "[META-OAUTH] start → redirecting to Facebook:",
      JSON.stringify({
        authorizeHost: au.host,
        client_id: au.searchParams.get("client_id"),
        redirect_uri: au.searchParams.get("redirect_uri"),
        scope: au.searchParams.get("scope"),
        hotelClientId: hotelClientId || "(agency-level)",
      }),
    );
  } catch {
    // logging must never block the redirect
  }

  redirect(authorizeUrl);
}
