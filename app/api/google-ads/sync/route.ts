import { runGoogleAdsSync } from "@/lib/google-ads-sync";

// Daily Google Ads sync cron — scheduled at 5:15am UTC (after GA4's 4:30am), via
// vercel.json. Refreshes each connection's token if needed, then pulls the
// trailing 30 days of per-campaign metrics into GoogleAdsCampaignSnapshot rows.
// Same CRON_SECRET bearer guard as the other crons; also hittable manually.
//
// Query params (optional): ?agencyId, ?hotelClientId, ?days

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "CRON_SECRET is not configured on the server." }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const agencyId = url.searchParams.get("agencyId") ?? undefined;
  const hotelClientId = url.searchParams.get("hotelClientId") ?? undefined;
  const daysParamRaw = url.searchParams.get("days");
  const days = daysParamRaw ? Math.min(90, Math.max(1, Number.parseInt(daysParamRaw, 10) || 30)) : undefined;

  const result = await runGoogleAdsSync({ agencyId, hotelClientId, days });
  return Response.json({ ok: true, ...result });
}
