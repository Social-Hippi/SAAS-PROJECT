import { runGa4Sync } from "@/lib/ga4-sync";

// Daily GA4 (OAuth) sync cron — scheduled at 4:30am UTC (after the 3am Instagram
// sync), via vercel.json. Refreshes each connection's token if needed, then
// pulls the trailing 30 days into Ga4Snapshot rows. Same CRON_SECRET bearer
// guard as the other crons; also hittable manually for testing.
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
  const days = daysParamRaw ? Math.min(30, Math.max(1, Number.parseInt(daysParamRaw, 10) || 30)) : undefined;

  // Explicit window for BACKFILLS: ?from=2026-01-01&to=2026-01-31.
  //
  // Deliberately separate from `days`, which stays capped at 30 for the daily
  // cron. A backfill is sliced by the caller into windows that each finish
  // inside maxDuration; every write is an upsert, so a slice that fails is
  // simply re-run. Widening `days` instead would restart at "N days ago" every
  // attempt and never converge on a long history.
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !ISO.test(from)) || (to && !ISO.test(to))) {
    return Response.json({ error: "from/to must be YYYY-MM-DD." }, { status: 400 });
  }
  if (Boolean(from) !== Boolean(to)) {
    return Response.json({ error: "from and to must be given together." }, { status: 400 });
  }
  const window = from && to ? { startDate: from, endDate: to } : undefined;

  const result = await runGa4Sync({ agencyId, hotelClientId, days, window });
  return Response.json({ ok: true, ...result });
}
