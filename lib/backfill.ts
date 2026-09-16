import "server-only";

import { prisma } from "@/lib/prisma";
import { campaignSnapshotData } from "@/lib/meta-campaign-row";
import { getTokenForApiCall } from "@/lib/token-access";
import type { SecretToken } from "@/lib/encryption";
import { getDailyInsights, getDailyCampaignInsights, MetaAuthError } from "@/lib/meta";
import { refreshCampaignPerformance } from "@/lib/campaign-attribution";
import { syncInstagramConnection } from "@/lib/instagram-sync";
import { recordSyncFailure, resolveSyncFailures } from "@/lib/sync-failures";

export { recordSyncFailure } from "@/lib/sync-failures";

// Automatic backfill engine. It does two jobs, both driven by a BackfillJob
// row that the UI polls for live progress:
//
//   • FIRST CONNECT — when a Meta token is connected (or an ad account is
//     mapped to a hotel), import the trailing 12 months of ads history so a
//     new client's dashboard isn't empty.
//   • RECONNECT REPAIR — when a token died and was reconnected, refill the
//     gap the scheduled sync left while it was dead.
//
// Gaps are always recomputed from what's actually stored, so runs are
// resumable: if a serverless runner times out mid-import, the next trigger
// picks up exactly where the data stops.
//
// EFFICIENCY: insight calls fetch a whole date range in one request (ads via
// `getDailyInsights`, which paginates; Instagram via the shared IGAA engine).
// Long ad gaps are split into ≤90-day chunks with a short delay to stay well
// under Meta's ~200 calls/hour limit — a full 12-month import is 5 calls per
// hotel.
//
// RESILIENCE: a dead token never aborts the whole job — it's logged to
// BackfillLog + SyncFailure and the run continues; partial results persist via
// idempotent upserts (same unique keys the scheduled sync uses).
//
// SECURITY: tokens are resolved only via getTokenForApiCall and never logged.

const DAY_MS = 86_400_000;
const CHUNK_DAYS = 90;
// Campaign-level insights reject ranges longer than ~a month ("reduce the
// amount of data"), so they're fetched in 30-day windows (vs 90 for account).
const CAMPAIGN_CHUNK_DAYS = 30;
const CHUNK_DELAY_MS = 1500;
const MAX_GAP_DAYS = 90; // social repair cap — a 60-day token can't have left a longer real gap
const HISTORY_DAYS = 365; // ads: how far back the first-connect import reaches
// A "running" job whose runner hasn't touched it for this long is considered
// dead (serverless timeout) and may be reclaimed by the next trigger.
const STALE_RUNNING_MS = 10 * 60_000;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Midnight-UTC Date for "yesterday" — Meta's current day is always incomplete. */
function yesterday(now = new Date()): Date {
  return new Date(`${ymd(new Date(now.getTime() - DAY_MS))}T00:00:00.000Z`);
}

export type Gap = { start: Date; end: Date; days: number };

/**
 * The missing window after `lastDate`, bounded to yesterday and capped at
 * MAX_GAP_DAYS. Returns null when there's no baseline snapshot (nothing to
 * anchor a bounded range) or when the data is already current.
 *
 * Used for the social (IGAA) repair path and the "N days missing" badge — the
 * ads import path uses {@link computeAdGaps}, which also covers history.
 */
export function computeGap(lastDate: Date | null, now = new Date()): Gap | null {
  if (!lastDate) return null;
  const end = yesterday(now);
  let start = new Date(lastDate.getTime() + DAY_MS);
  // Normalise to midnight UTC.
  start = new Date(`${ymd(start)}T00:00:00.000Z`);
  if (start > end) return null;
  const earliest = new Date(end.getTime() - (MAX_GAP_DAYS - 1) * DAY_MS);
  if (start < earliest) start = earliest;
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  return { start, end, days };
}

export type AdGap = Gap & {
  /**
   * initial — no snapshots at all (first connect): the whole 12-month window.
   * head — history missing before the earliest snapshot.
   * tail — days missing after the latest snapshot (the classic reconnect gap).
   */
  kind: "initial" | "head" | "tail";
};

/** A Gap normalised to midnight-UTC bounds with an inclusive day count. */
function mkGap(start: Date, end: Date, kind: AdGap["kind"]): AdGap {
  const s = new Date(`${ymd(start)}T00:00:00.000Z`);
  const e = new Date(`${ymd(end)}T00:00:00.000Z`);
  const days = Math.round((e.getTime() - s.getTime()) / DAY_MS) + 1;
  return { start: s, end: e, days, kind };
}

/**
 * Missing AdSnapshot windows inside the trailing HISTORY_DAYS (12 months),
 * given the earliest/latest stored snapshot dates for a hotel. A hotel with no
 * snapshots gets the full year (the first-connect import); one with data gets
 * a head gap (history before its first row) and/or a tail gap (days since its
 * last row). Interior holes between first and last are not repaired here — the
 * daily sync's trailing window plus idempotent upserts handle those.
 */
export function computeAdGaps(
  first: Date | null,
  last: Date | null,
  now = new Date(),
): AdGap[] {
  const end = yesterday(now);
  const horizon = new Date(end.getTime() - (HISTORY_DAYS - 1) * DAY_MS);
  if (!first || !last) return [mkGap(horizon, end, "initial")];

  const gaps: AdGap[] = [];
  const headEnd = new Date(first.getTime() - DAY_MS);
  if (horizon <= headEnd) gaps.push(mkGap(horizon, headEnd, "head"));

  // Clamp to the horizon so stored data older than the window can't stretch
  // the tail beyond 12 months.
  const tailStart = new Date(Math.max(last.getTime() + DAY_MS, horizon.getTime()));
  if (tailStart <= end) gaps.push(mkGap(tailStart, end, "tail"));

  return gaps;
}

/**
 * Split a gap into ≤CHUNK_DAYS ranges of "YYYY-MM-DD" strings. With
 * `newestFirst` the chunks anchor at the gap's END and walk backwards — used
 * for head/initial gaps so an interrupted run leaves the stored history
 * contiguous (the next run's recomputed head gap then resumes cleanly instead
 * of skipping over an interior hole). Tail gaps fill oldest-first for the
 * mirrored reason. Exported for tests.
 */
export function chunkRanges(gap: Gap, newestFirst = false): { since: string; until: string }[] {
  const out: { since: string; until: string }[] = [];
  if (newestFirst) {
    let cursor = gap.end;
    while (cursor >= gap.start) {
      const chunkStart = new Date(
        Math.max(cursor.getTime() - (CHUNK_DAYS - 1) * DAY_MS, gap.start.getTime()),
      );
      out.push({ since: ymd(chunkStart), until: ymd(cursor) });
      cursor = new Date(chunkStart.getTime() - DAY_MS);
    }
    return out;
  }
  let cursor = gap.start;
  while (cursor <= gap.end) {
    const chunkEnd = new Date(
      Math.min(cursor.getTime() + (CHUNK_DAYS - 1) * DAY_MS, gap.end.getTime()),
    );
    out.push({ since: ymd(cursor), until: ymd(chunkEnd) });
    cursor = new Date(chunkEnd.getTime() + DAY_MS);
  }
  return out;
}

async function lastAdDate(agencyId: string, hotelClientId: string): Promise<Date | null> {
  const row = await prisma.adSnapshot.findFirst({
    // Only the current account's (non-archived) data defines what's already
    // synced — after an account change we must backfill the new account's history.
    where: { agencyId, hotelClientId, archived: false },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  return row?.date ?? null;
}

/** Earliest + latest stored (non-archived) AdSnapshot dates for a hotel. */
async function adDateBounds(
  agencyId: string,
  hotelClientId: string,
): Promise<{ first: Date | null; last: Date | null }> {
  const agg = await prisma.adSnapshot.aggregate({
    where: { agencyId, hotelClientId, archived: false },
    _min: { date: true },
    _max: { date: true },
  });
  return { first: agg._min.date, last: agg._max.date };
}

async function lastSocialDate(agencyId: string, hotelClientId: string): Promise<Date | null> {
  const row = await prisma.socialSnapshot.findFirst({
    where: { agencyId, hotelClientId },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  return row?.date ?? null;
}

/**
 * Days of missing ad data for a hotel (last AdSnapshot → yesterday), or 0 when
 * current. Used for the dashboard "N days of data missing" badge.
 */
export async function missingAdDays(agencyId: string, hotelClientId: string): Promise<number> {
  const gap = computeGap(await lastAdDate(agencyId, hotelClientId));
  return gap?.days ?? 0;
}

/**
 * Earliest gap start across an agency's hotels (ad + social), bounded to
 * yesterday — used to seed a BackfillJob's range on connect/reconnect. Ads
 * cover the trailing 12 months (history import + repair) and only count when
 * the agency has a connected Meta token; social is repair-only. Null when
 * there's nothing to backfill.
 */
export async function computeAgencyBackfillRange(
  agencyId: string,
): Promise<{ start: Date; end: Date } | null> {
  const now = new Date();
  const [adHotels, igAccounts] = await Promise.all([
    // Only hotels whose OWN Meta token is connected contribute ad gaps now that
    // tokens are hotel-scoped (the relation filter excludes hotels with no token).
    prisma.hotelClient.findMany({
      where: {
        agencyId,
        metaAdAccountId: { not: null },
        deletedAt: null,
        metaToken: { is: { status: "connected" } },
      },
      select: { id: true },
    }),
    prisma.instagramConnection.findMany({
      where: { agencyId, status: "active", tokenType: "igaa_direct" },
      select: { hotelClientId: true },
    }),
  ]);

  let earliest: Date | null = null;
  const consider = (gap: Gap | null) => {
    if (gap && (!earliest || gap.start < earliest)) earliest = gap.start;
  };
  for (const h of adHotels) {
    const bounds = await adDateBounds(agencyId, h.id);
    for (const gap of computeAdGaps(bounds.first, bounds.last, now)) consider(gap);
  }
  for (const a of igAccounts)
    consider(computeGap(await lastSocialDate(agencyId, a.hotelClientId), now));

  return earliest ? { start: earliest, end: yesterday(now) } : null;
}

/**
 * Queues a pending BackfillJob covering the agency's current missing windows,
 * or returns the already-active job's id (never stacks duplicate jobs). Called
 * after a token connect or an ad-account mapping; the BackfillProgress banner
 * triggers and polls it. Null when there's nothing to backfill.
 */
export async function queueBackfillJob(agencyId: string): Promise<string | null> {
  const active = await prisma.backfillJob.findFirst({
    where: { agencyId, status: { in: ["pending", "running"] } },
    select: { id: true },
  });
  if (active) return active.id;

  const range = await computeAgencyBackfillRange(agencyId);
  if (!range) return null;

  const job = await prisma.backfillJob.create({
    data: {
      agencyId,
      status: "pending",
      rangeStart: range.start,
      rangeEnd: range.end,
    },
    select: { id: true },
  });
  return job.id;
}

// ── Backfill writers ──────────────────────────────────────────────────────────

/** Splits [start, end] (inclusive, UTC dates) into <= `days`-long windows. */
function splitWindows(start: Date, end: Date, days: number): { since: string; until: string }[] {
  const out: { since: string; until: string }[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += days * DAY_MS) {
    const wEnd = Math.min(t + (days - 1) * DAY_MS, end.getTime());
    out.push({ since: ymd(new Date(t)), until: ymd(new Date(wEnd)) });
  }
  return out;
}

/**
 * Campaign-level companion to the account-level ad import. For the same gaps,
 * fills AdCampaignSnapshot (30-day windows — Meta rejects longer campaign-insight
 * ranges) then recomputes CampaignPerformance for the spanned dates, so the
 * "Meta Campaign Breakdown" and "Campaign performance" sections populate as soon
 * as an account is mapped. Self-contained: never throws; signals a dead token so
 * the caller can stop. NEVER logs the token.
 */
async function backfillCampaigns(
  agencyId: string,
  hotelClientId: string,
  accountId: string,
  reveal: string,
  gaps: AdGap[],
): Promise<{ tokenDead: boolean }> {
  let minStart: Date | null = null;
  let maxEnd: Date | null = null;

  for (const gap of gaps) {
    for (const window of splitWindows(gap.start, gap.end, CAMPAIGN_CHUNK_DAYS)) {
      try {
        const rows = await getDailyCampaignInsights(reveal, accountId, window);
        for (const row of rows) {
          if (!row.date) continue;
          const date = new Date(`${row.date}T00:00:00.000Z`);
          // Same full column set as the cron and the live sync — a restored day
          // that is missing six columns is not a restored day.
          const data = campaignSnapshotData(row, accountId);
          await prisma.adCampaignSnapshot.upsert({
            where: {
              hotelClientId_metaCampaignId_date: {
                hotelClientId,
                metaCampaignId: row.campaignId,
                date,
              },
            },
            create: { agencyId, hotelClientId, metaCampaignId: row.campaignId, date, ...data },
            update: data,
          });
        }
        await sleep(CHUNK_DELAY_MS);
      } catch (err) {
        if (err instanceof MetaAuthError) return { tokenDead: true };
        // Non-auth (rate limit / transient) — skip this window, keep going.
      }
    }
    if (minStart === null || gap.start < minStart) minStart = gap.start;
    if (maxEnd === null || gap.end > maxEnd) maxEnd = gap.end;
  }

  if (minStart && maxEnd) {
    try {
      await refreshCampaignPerformance(agencyId, hotelClientId, minStart, maxEnd);
    } catch {
      // Attribution recompute is best-effort; the daily cron retries it.
    }
  }
  return { tokenDead: false };
}

async function backfillAds(
  agencyId: string,
  accumulate: (days: number) => void,
): Promise<{ anySuccess: boolean; tokenDead: boolean; failedDays: number; sampleError: string | null }> {
  let anySuccess = false;
  let tokenDead = false;
  let failedDays = 0;
  let sampleError: string | null = null;

  // Hotels whose OWN Meta token is connected — tokens are hotel-scoped now, so
  // each hotel decrypts its own (they may live in separate Meta accounts). The
  // 1-1 relation filter excludes hotels with no/non-connected token.
  const hotels = await prisma.hotelClient.findMany({
    where: {
      agencyId,
      metaAdAccountId: { not: null },
      deletedAt: null,
      metaToken: { is: { status: "connected" } },
    },
    select: { id: true, metaAdAccountId: true, metaToken: { select: { id: true } } },
  });

  for (const hotel of hotels) {
    const tokenId = hotel.metaToken!.id;
    let secret: SecretToken;
    try {
      secret = await getTokenForApiCall("meta_ads", tokenId, {
        agencyId,
        hotelClientId: hotel.id,
        source: "backfill:ads",
      });
    } catch {
      // Can't decrypt this hotel's token — skip it, keep going with the others.
      continue;
    }

    const bounds = await adDateBounds(agencyId, hotel.id);
    // Tail gap first: it lands the most recent days (what the dashboard opens
    // on) before the longer history import starts.
    const gaps = computeAdGaps(bounds.first, bounds.last).sort((a, b) =>
      a.kind === "tail" ? -1 : b.kind === "tail" ? 1 : 0,
    );
    if (gaps.length === 0) continue;
    const accountId = hotel.metaAdAccountId!;
    let hotelOk = false;
    let hotelTokenDead = false;

    for (const gap of gaps) {
      try {
        let written = 0;
        // Head/initial gaps fill newest-first, tail gaps oldest-first — both
        // keep stored data contiguous if the runner dies mid-gap, so a resumed
        // job's recomputed gaps pick up exactly where the data stops.
        const chunks = chunkRanges(gap, gap.kind !== "tail");
        for (let i = 0; i < chunks.length; i++) {
          if (i > 0) await sleep(CHUNK_DELAY_MS);
          const rows = await getDailyInsights(secret.reveal(), accountId, chunks[i]);
          for (const row of rows) {
            if (!row.date) continue;
            const date = new Date(`${row.date}T00:00:00.000Z`);
            const data = {
              metaAccountId: accountId,
              spend: row.spend.toFixed(2),
              impressions: row.impressions,
              reach: row.reach,
              clicks: row.clicks,
              ctr: row.ctr,
              cpc: row.cpc.toFixed(4),
              cpm: row.cpm.toFixed(4),
              conversions: row.conversions,
              roas: row.roas,
              pixelPurchases: row.pixelPurchases,
              pixelLeads: row.pixelLeads,
              pixelPageViews: row.pixelPageViews,
            };
            await prisma.adSnapshot.upsert({
              where: {
                hotelClientId_metaAccountId_date: {
                  hotelClientId: hotel.id,
                  metaAccountId: accountId,
                  date,
                },
              },
              create: { agencyId, hotelClientId: hotel.id, date, ...data },
              update: data,
            });
            written += 1;
          }
        }
        accumulate(written);
        hotelOk = true;
        anySuccess = true;
        await logBackfill(agencyId, hotel.id, "ad", gap, "success");
      } catch (err) {
        failedDays += gap.days;
        const message = err instanceof Error ? err.message : "Unknown ad backfill error.";
        sampleError ??= message;
        if (err instanceof MetaAuthError) {
          // Only THIS hotel's token is dead — mark it expired and record the
          // failure, then stop this hotel's gaps but continue with other hotels.
          tokenDead = true;
          hotelTokenDead = true;
          await prisma.metaToken.update({
            where: { id: tokenId },
            data: { status: "expired" },
          });
          await recordSyncFailure(agencyId, hotel.id, "meta_ads", err.message);
          await logBackfill(agencyId, hotel.id, "ad", gap, "failed", err.message);
          break; // token is dead for this hotel only
        }
        await logBackfill(agencyId, hotel.id, "ad", gap, "failed", message);
      }
    }

    // Campaign-level import for the same gaps (powers the campaign sections).
    // Runs unless this hotel's account-level pass already found the token dead.
    if (!hotelTokenDead && gaps.length > 0) {
      const camp = await backfillCampaigns(agencyId, hotel.id, accountId, secret.reveal(), gaps);
      if (camp.tokenDead) {
        tokenDead = true;
        await prisma.metaToken.update({
          where: { id: tokenId },
          data: { status: "expired" },
        });
        await recordSyncFailure(
          agencyId,
          hotel.id,
          "meta_ads",
          "Meta token expired/revoked during campaign backfill.",
        );
      }
    }

    if (hotelOk) {
      await prisma.hotelClient.update({
        where: { id: hotel.id },
        data: { lastSyncedAt: new Date() },
      });
    }
    // A dead token affects only this hotel now — do NOT break; continue with the
    // rest so one bad token can't stall every hotel's backfill.
  }

  return { anySuccess, tokenDead, failedDays, sampleError };
}

async function backfillSocial(
  agencyId: string,
  accumulate: (days: number) => void,
): Promise<{ anySuccess: boolean; failedDays: number; sampleError: string | null }> {
  let anySuccess = false;
  let failedDays = 0;
  let sampleError: string | null = null;

  // IGAA connections only — the EAA-via-Page flow is retired and its rows sit
  // at status "deprecated_eaa", never synced.
  const connections = await prisma.instagramConnection.findMany({
    where: { agencyId, status: "active", tokenType: "igaa_direct" },
    select: { id: true, hotelClientId: true, igUserId: true },
  });

  for (const conn of connections) {
    const gap = computeGap(await lastSocialDate(agencyId, conn.hotelClientId));
    if (!gap) continue;

    // The shared IGAA engine fetches the whole gap in one date-ranged insights
    // call (plus recent media) and handles its own failure bookkeeping
    // (status="error", SyncFailure, agency email).
    const res = await syncInstagramConnection(
      { id: conn.id, agencyId, hotelClientId: conn.hotelClientId, igUserId: conn.igUserId },
      { days: gap.days },
    );

    if (res.ok) {
      accumulate(res.daysSynced ?? gap.days);
      anySuccess = true;
      await logBackfill(agencyId, conn.hotelClientId, "social", gap, "success");
      await logBackfill(agencyId, conn.hotelClientId, "post", gap, "success");
    } else {
      failedDays += gap.days;
      const message = res.error ?? "Unknown Instagram backfill error.";
      sampleError ??= message;
      await logBackfill(agencyId, conn.hotelClientId, "social", gap, "failed", message);
    }

    await sleep(CHUNK_DELAY_MS);
  }

  return { anySuccess, failedDays, sampleError };
}

// ── Logging helpers ───────────────────────────────────────────────────────────

async function logBackfill(
  agencyId: string,
  hotelClientId: string,
  dataType: "ad" | "social" | "post",
  gap: Gap,
  status: "success" | "failed",
  errorMessage?: string,
) {
  await prisma.backfillLog.create({
    data: {
      agencyId,
      hotelClientId,
      dataType,
      dateRange: `${ymd(gap.start)}..${ymd(gap.end)}`,
      status,
      errorMessage: errorMessage ?? null,
    },
  });
}

// recordSyncFailure / resolveSyncFailures live in lib/sync-failures.ts (shared
// with the Instagram sync engine; re-exported above for existing importers).

// ── Job runner ────────────────────────────────────────────────────────────────

/**
 * Runs a BackfillJob to completion, updating its row as it goes so the UI poll
 * shows progress. Never throws — failures are captured in the job + BackfillLog.
 *
 * Safe to call repeatedly: the claim below is atomic, so concurrent triggers
 * (two open tabs, a re-POST) can't double-run a job, and a "running" job whose
 * runner died (serverless timeout mid-import) becomes reclaimable after
 * STALE_RUNNING_MS — the resumed run recomputes gaps from what's stored and
 * continues where the data stops.
 */
export async function runBackfillJob(jobId: string): Promise<void> {
  const job = await prisma.backfillJob.findUnique({ where: { id: jobId } });
  if (!job) return;

  const claimed = await prisma.backfillJob.updateMany({
    where: {
      id: jobId,
      OR: [
        { status: "pending" },
        { status: "running", startedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
        { status: "running", startedAt: null },
      ],
    },
    data: { status: "running", startedAt: new Date() },
  });
  if (claimed.count === 0) return;

  const agencyId = job.agencyId;
  // A resumed job keeps the days its previous runner already restored.
  let daysRestored = job.daysRestored;
  let daysFailed = 0;
  // Bump the job's counter after each hotel so polling reflects live progress.
  const bumpRestored = async (days: number) => {
    if (days <= 0) return;
    daysRestored += days;
    await prisma.backfillJob.update({
      where: { id: jobId },
      data: { daysRestored },
    });
  };

  const ads = await backfillAds(agencyId, (d) => void bumpRestored(d));
  const social = await backfillSocial(agencyId, (d) => void bumpRestored(d));
  daysFailed = ads.failedDays + social.failedDays;

  if (ads.anySuccess && !ads.tokenDead) await resolveSyncFailures(agencyId, "meta_ads");
  if (social.anySuccess) await resolveSyncFailures(agencyId, "instagram");

  const status =
    daysRestored > 0 && daysFailed > 0
      ? "partial"
      : daysFailed > 0 && daysRestored === 0
        ? "failed"
        : "completed";
  // Surface the first real API error so the user sees WHY it failed (e.g. a
  // permission error on the mapped ad account) instead of a generic hint.
  const cause = ads.sampleError ?? social.sampleError;
  const message =
    status === "completed"
      ? `Backfill complete — ${daysRestored} day${daysRestored === 1 ? "" : "s"} of data restored.`
      : status === "partial"
        ? `Successfully backfilled ${daysRestored} day${daysRestored === 1 ? "" : "s"}. ${daysFailed} day${daysFailed === 1 ? "" : "s"} failed due to API errors — these will retry on the next scheduled sync.`
        : `Backfill failed — ${daysFailed} day${daysFailed === 1 ? "" : "s"} could not be restored.${cause ? ` Meta said: "${cause}"` : " Check the token and try again."}`;

  await prisma.backfillJob.update({
    where: { id: jobId },
    data: { status, daysRestored, daysFailed, message, finishedAt: new Date() },
  });
}
