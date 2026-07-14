import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { signOauthState } from "@/lib/signed-state";
import { buildGoogleAdsAuthUrl } from "@/lib/google-ads";

// Step 1 of the Google Ads OAuth flow (mirrors /api/auth/ga4/start). The signed-in
// agency member clicks "Connect Google Ads" on a hotel's integrations page; we
// verify the hotel belongs to their agency, mint a signed 10-minute state token
// binding (agencyId, hotelClientId), and hand the browser to Google's consent
// screen — this time requesting the `adwords` scope.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LOG = "[GADS-OAUTH]";

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

  let authUrl: string;
  try {
    authUrl = buildGoogleAdsAuthUrl(state);
  } catch (err) {
    console.error(`${LOG} start: buildGoogleAdsAuthUrl FAILED:`, err instanceof Error ? err.message : err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Google Ads OAuth is not configured." },
      { status: 500 },
    );
  }

  try {
    const au = new URL(authUrl);
    console.log(
      `${LOG} start → redirecting to Google:`,
      JSON.stringify({
        host: au.host,
        client_id: au.searchParams.get("client_id"),
        redirect_uri: au.searchParams.get("redirect_uri"),
        scope: au.searchParams.get("scope"),
        hotelClientId,
      }),
    );
  } catch {
    // logging must never block the redirect
  }

  redirect(authUrl);
}
