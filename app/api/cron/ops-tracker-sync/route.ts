import { reconcileOpsTrackers } from "@/lib/ops-tracker/reconcile";

// GET /api/cron/ops-tracker-sync — scheduled reconciliation of the operations
// trackers. Same CRON_SECRET bearer guard as every other scheduled route here,
// and public in proxy.ts so Clerk cannot 307 the session-less cron to /sign-in
// before that guard runs (see tests/cron-public-routes.test.ts).
//
// DAILY, not hourly. The Vercel API reports this team's billing plan as `hobby`,
// where crons are capped at two per day; all twelve existing crons are daily and
// none is sub-daily, so an hourly schedule here could be silently dropped. The
// webhook is the fast path anyway — this is only the self-heal. If the plan is
// confirmed as Pro, the schedule in vercel.json is a one-line change.

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

  try {
    const result = await reconcileOpsTrackers();
    return Response.json(result);
  } catch {
    return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
  }
}
