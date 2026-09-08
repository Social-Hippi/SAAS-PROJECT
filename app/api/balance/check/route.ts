import { runBalanceAlerts } from "@/lib/balance-alerts";

// Daily advertising-funds refresh + low-balance reminder cron. Scheduled at
// 3:30am UTC via vercel.json — after the 2am Meta sync, and offset from the 3am
// budget cron so the two never contend for the same Meta rate limit.
//
// Same CRON_SECRET bearer guard as every other cron here, and public in proxy.ts
// for the same reason: Vercel Cron carries no Clerk session.
//
// Query params (optional):
//   ?agencyId=<id>   limit to one agency
//   ?force=1         re-send even if the reminder already fired (testing)

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

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
  const force = url.searchParams.get("force") === "1";

  const result = await runBalanceAlerts({ agencyId, force });
  return Response.json({ ok: true, ...result });
}
