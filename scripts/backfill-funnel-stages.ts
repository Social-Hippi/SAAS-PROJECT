import "./load-env";
import { prisma } from "@/lib/prisma";
import {
  parseFunnelRules,
  resolveStageFromRules,
  stageRank,
  type FunnelStage,
} from "@/lib/funnel";

// One-time backfill: apply each hotel's funnelStageRules to its existing (Phase 1)
// PageViews that have no funnelStage yet, then derive StageReached rows +
// Session.highestStageReached for those historical sessions — so Funnel Analysis
// has data immediately, not only from new visitors.
//
// Idempotent: only PageViews with funnelStage IS NULL are touched, and
// StageReached uses skipDuplicates. Safe to re-run.

export async function backfillHotel(hotel: {
  id: string;
  name: string;
  agencyId: string;
  funnelStageRules: unknown;
}): Promise<{ pageViews: number; stageReached: number; sessions: number }> {
  const rules = parseFunnelRules(hotel.funnelStageRules);
  if (rules.length === 0) return { pageViews: 0, stageReached: 0, sessions: 0 };

  const pvs = await prisma.pageView.findMany({
    where: { hotelClientId: hotel.id, funnelStage: null },
    select: { id: true, sessionId: true, visitorId: true, pagePath: true, enteredAt: true },
  });
  if (pvs.length === 0) return { pageViews: 0, stageReached: 0, sessions: 0 };

  // Resolve a stage for each PageView; collect updates + per-session stage timing.
  const idsByStage = new Map<FunnelStage, string[]>();
  // sessionId → stage → { reachedAt, visitorId }
  const sessionStages = new Map<string, Map<FunnelStage, { at: Date; visitorId: string }>>();

  for (const pv of pvs) {
    const stage = resolveStageFromRules(rules, pv.pagePath);
    if (!stage) continue;
    let ids = idsByStage.get(stage);
    if (!ids) { ids = []; idsByStage.set(stage, ids); }
    ids.push(pv.id);
    const m =
      sessionStages.get(pv.sessionId) ??
      new Map<FunnelStage, { at: Date; visitorId: string }>();
    const existing = m.get(stage);
    if (!existing || pv.enteredAt < existing.at) m.set(stage, { at: pv.enteredAt, visitorId: pv.visitorId });
    sessionStages.set(pv.sessionId, m);
  }

  // 1. Set PageView.funnelStage in bulk, grouped by stage.
  let pageViews = 0;
  for (const [stage, ids] of idsByStage) {
    const res = await prisma.pageView.updateMany({
      where: { id: { in: ids } },
      data: { funnelStage: stage },
    });
    pageViews += res.count;
  }

  // 2. Create StageReached rows (idempotent) for every (session, stage) reached.
  const stageRows: {
    sessionId: string;
    visitorId: string;
    hotelClientId: string;
    agencyId: string;
    stage: string;
    reachedAt: Date;
  }[] = [];
  for (const [sessionId, stages] of sessionStages) {
    for (const [stage, { at, visitorId }] of stages) {
      stageRows.push({
        sessionId,
        visitorId,
        hotelClientId: hotel.id,
        agencyId: hotel.agencyId,
        stage,
        reachedAt: at,
      });
    }
  }
  const created = await prisma.stageReached.createMany({ data: stageRows, skipDuplicates: true });

  // 3. Set Session.highestStageReached to each session's max stage.
  let sessions = 0;
  for (const [sessionId, stages] of sessionStages) {
    let best: FunnelStage | null = null;
    for (const stage of stages.keys()) if (stageRank(stage) > stageRank(best)) best = stage;
    if (best) {
      await prisma.session.update({
        where: { id: sessionId },
        data: { highestStageReached: best },
      });
      sessions += 1;
    }
  }

  return { pageViews, stageReached: created.count, sessions };
}

async function main() {
  // All active hotels; backfillHotel no-ops for those without funnel rules.
  const hotels = await prisma.hotelClient.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, agencyId: true, funnelStageRules: true },
  });
  const withRules = hotels.filter((h) => parseFunnelRules(h.funnelStageRules).length > 0);
  console.log(`Backfilling funnel stages for ${withRules.length} hotel(s) with rules…`);

  let totals = { pageViews: 0, stageReached: 0, sessions: 0 };
  for (const hotel of withRules) {
    const r = await backfillHotel(hotel);
    totals = {
      pageViews: totals.pageViews + r.pageViews,
      stageReached: totals.stageReached + r.stageReached,
      sessions: totals.sessions + r.sessions,
    };
    console.log(
      `  • ${hotel.name}: ${r.pageViews} pageviews tagged, ${r.stageReached} StageReached, ${r.sessions} sessions updated`,
    );
  }
  console.log(
    `Done. ${totals.pageViews} pageviews tagged · ${totals.stageReached} StageReached · ${totals.sessions} sessions.`,
  );
  await prisma.$disconnect();
}

// Run only when invoked as a script (not when imported by the tests).
if (!process.env.VITEST) {
  main().catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
}
