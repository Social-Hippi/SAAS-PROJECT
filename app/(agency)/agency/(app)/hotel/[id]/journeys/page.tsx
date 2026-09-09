import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { resolveRange } from "@/lib/attribution";
import { computeFunnel, stageRank, STAGES, type FunnelStage } from "@/lib/funnel";
import { JourneyFilters } from "./JourneyFilters";
import { JourneyList, type JourneySession } from "./JourneyList";
import { FunnelAnalysis, type FunnelView } from "./FunnelAnalysis";
import { ClicksAnalytics } from "./ClicksAnalytics";
import { FormAbandonment } from "./FormAbandonment";
import { CustomerJourneyLookup } from "./CustomerJourneyLookup";
import { computeClickAnalytics, computeFormAbandonment } from "@/lib/interaction-analytics";

// Per-hotel "Recent Visitor Journeys" — the full page-by-page journey for each
// session (snippet v2 Session/PageView). Every read is agency-scoped (auto
// agencyId via agencyScoped) AND filtered by hotelClientId (multi-tenant safe).

const PAGE_SIZE = 20;

function relativeAgo(d: Date, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const days = Math.floor(h / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export default async function HotelJourneysPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  // Viewing customer-level journeys (session/page/click/form history + visitor
  // identities) is ADMIN-only, enforced server-side — not just hidden in the UI.
  // A non-admin (analyst) is bounced back to the hotel overview.
  const member = await requireAdmin();
  if (!member) redirect(`/agency/hotel/${id}`);

  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id },
    select: { id: true, name: true, websiteUrl: true, timezone: true },
  });
  if (!hotel) notFound();

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  // Default range for journeys is the last 7 days.
  const range = resolveRange(
    { range: one(sp.range) ?? "7", from: one(sp.from), to: one(sp.to) },
    { timezone: hotel.timezone },
  );
  const convertedOnly = one(sp.converted) === "1";
  const identifiedOnly = one(sp.identified) === "1";
  const utmSource = one(sp.utmSource) || null;
  const landing = one(sp.landing) || null;
  const pageNum = Math.max(1, Number(one(sp.page)) || 1);
  const now = new Date();

  // VisitorIdentity map (Part 6) — name per visitorId + the set of identified
  // visitors (drives the name badge and the "Identified only" filter). Scoped.
  const identityRows = await agencyScoped(prisma.visitorIdentity).findMany({
    where: { hotelClientId: hotel.id },
    select: { visitorId: true, name: true },
  });
  const nameByVisitor = new Map<string, string | null>();
  const identifiedVisitorIds: string[] = [];
  for (const r of identityRows) {
    nameByVisitor.set(r.visitorId, r.name);
    identifiedVisitorIds.push(r.visitorId);
  }

  // Conversion session ids in range (for the "Converted" badge + the filter).
  const convRows = await agencyScoped(prisma.trackingEvent).findMany({
    where: {
      hotelClientId: hotel.id,
      eventType: "conversion",
      createdAt: { gte: range.since, lte: range.until },
      NOT: { sessionId: "" },
    },
    select: { sessionId: true },
  });
  const convertedIds = new Set(convRows.map((r) => r.sessionId));

  const where = {
    hotelClientId: hotel.id,
    startedAt: { gte: range.since, lte: range.until },
    ...(utmSource ? { utmSource } : {}),
    ...(landing ? { landingPath: landing } : {}),
    ...(convertedOnly ? { id: { in: [...convertedIds] } } : {}),
    ...(identifiedOnly ? { visitorId: { in: identifiedVisitorIds } } : {}),
  };

  const [total, sessions, utmGroups, landingGroups] = await Promise.all([
    agencyScoped(prisma.session).count({ where }),
    agencyScoped(prisma.session).findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: (pageNum - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        visitorId: true,
        startedAt: true,
        endedAt: true,
        totalTimeMs: true,
        pageViewCount: true,
        landingPath: true,
        exitPath: true,
        utmSource: true,
        utmMedium: true,
        utmCampaign: true,
      },
    }),
    // Distinct UTM sources + landing paths for the filter dropdowns (this hotel).
    agencyScoped(prisma.session).groupBy({
      by: ["utmSource"],
      where: { hotelClientId: hotel.id, NOT: { utmSource: null } },
    }),
    agencyScoped(prisma.session).groupBy({
      by: ["landingPath"],
      where: { hotelClientId: hotel.id },
    }),
  ]);

  // Pages for the visible sessions, in one scoped query, grouped for the modal.
  const ids = sessions.map((s) => s.id);
  const pageRows =
    ids.length > 0
      ? await agencyScoped(prisma.pageView).findMany({
          where: { hotelClientId: hotel.id, sessionId: { in: ids } },
          orderBy: { enteredAt: "asc" },
          select: {
            sessionId: true,
            pagePath: true,
            pageTitle: true,
            enteredAt: true,
            exitedAt: true,
            timeOnPageMs: true,
            exitReason: true,
          },
        })
      : [];
  const pagesBySession = new Map<string, JourneySession["pages"]>();
  for (const p of pageRows) {
    const list = pagesBySession.get(p.sessionId) ?? [];
    list.push({
      pagePath: p.pagePath,
      pageTitle: p.pageTitle,
      enteredAt: p.enteredAt.toISOString(),
      timeOnPageMs: p.timeOnPageMs,
      exitReason: p.exitReason,
    });
    pagesBySession.set(p.sessionId, list);
  }

  // Returning-visitor badge (Part 6): a visitorId with >1 session at this hotel
  // (all-time, scoped). Computed only for the visible page's visitors.
  const visibleVisitorIds = [...new Set(sessions.map((s) => s.visitorId))];
  const sessionCountByVisitor = new Map<string, number>();
  if (visibleVisitorIds.length > 0) {
    const counts = await agencyScoped(prisma.session).groupBy({
      by: ["visitorId"],
      where: { hotelClientId: hotel.id, visitorId: { in: visibleVisitorIds } },
      _count: { _all: true },
    });
    for (const c of counts) sessionCountByVisitor.set(c.visitorId, c._count._all);
  }

  const items: JourneySession[] = sessions.map((s) => ({
    id: s.id,
    visitorId: s.visitorId,
    identityName: nameByVisitor.get(s.visitorId) ?? null,
    returning: (sessionCountByVisitor.get(s.visitorId) ?? 0) > 1,
    startedAtLabel: relativeAgo(s.startedAt, now),
    startedAtISO: s.startedAt.toISOString(),
    durationMs: s.totalTimeMs,
    pageViewCount: s.pageViewCount,
    landingPath: s.landingPath,
    exitPath: s.exitPath,
    utmSource: s.utmSource,
    utmMedium: s.utmMedium,
    utmCampaign: s.utmCampaign,
    converted: convertedIds.has(s.id),
    pages: pagesBySession.get(s.id) ?? [],
  }));

  // ── Clicks Analytics (Part 4) + Form Abandonment (Part 5) — range-scoped for
  //    this hotel. Conversion rate per click target reuses convertedIds. ──
  const [clickEventRows, formEventRows] = await Promise.all([
    agencyScoped(prisma.clickEvent).findMany({
      where: { hotelClientId: hotel.id, occurredAt: { gte: range.since, lte: range.until } },
      select: { clickTarget: true, sessionId: true },
    }),
    agencyScoped(prisma.formFieldEvent).findMany({
      where: { hotelClientId: hotel.id, occurredAt: { gte: range.since, lte: range.until } },
      select: { fieldName: true, sessionId: true, action: true, hasValue: true },
    }),
  ]);
  const clickAnalytics = computeClickAnalytics(clickEventRows, convertedIds);
  const formAbandonment = computeFormAbandonment(formEventRows);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const utmOptions = utmGroups.map((g) => g.utmSource).filter((v): v is string => !!v).sort();
  const landingOptions = landingGroups.map((g) => g.landingPath).sort().slice(0, 100);

  // ── Funnel Analysis — respects the date/UTM/landing filters (not converted-only). ──
  const funnelWhere = {
    hotelClientId: hotel.id,
    startedAt: { gte: range.since, lte: range.until },
    ...(utmSource ? { utmSource } : {}),
    ...(landing ? { landingPath: landing } : {}),
  };
  const [stageGroups, revenueAgg, dropoffGroups, stageRows] = await Promise.all([
    agencyScoped(prisma.session).groupBy({
      by: ["highestStageReached"],
      where: funnelWhere,
      _count: { _all: true },
    }),
    agencyScoped(prisma.trackingEvent).aggregate({
      where: {
        hotelClientId: hotel.id,
        eventType: "conversion",
        createdAt: { gte: range.since, lte: range.until },
      },
      _sum: { conversionValue: true },
    }),
    agencyScoped(prisma.session).groupBy({
      by: ["highestStageReached", "exitPath"],
      where: funnelWhere,
      _count: { _all: true },
    }),
    agencyScoped(prisma.stageReached).findMany({
      where: { hotelClientId: hotel.id, reachedAt: { gte: range.since, lte: range.until } },
      select: { sessionId: true, stage: true, reachedAt: true },
    }),
  ]);

  // Sessions whose HIGHEST stage is exactly rank r (computeFunnel makes it cumulative).
  const reachedByRank: Record<number, number> = {};
  for (const g of stageGroups) {
    const r = stageRank(g.highestStageReached);
    if (r > 0) reachedByRank[r] = (reachedByRank[r] ?? 0) + g._count._all;
  }

  // Avg time from each stage to the next, from StageReached timestamps.
  const stageDeltas: Record<string, number[]> = {};
  {
    const bySession = new Map<string, Map<number, number>>(); // sessionId → rank → ms
    for (const sr of stageRows) {
      const r = stageRank(sr.stage);
      if (r <= 0) continue;
      const m = bySession.get(sr.sessionId) ?? new Map<number, number>();
      m.set(r, sr.reachedAt.getTime());
      bySession.set(sr.sessionId, m);
    }
    for (const m of bySession.values()) {
      for (let r = 1; r < STAGES.length; r++) {
        const a = m.get(r);
        const b = m.get(r + 1);
        if (a != null && b != null && b >= a) (stageDeltas[STAGES[r - 1]] ??= []).push(b - a);
      }
    }
  }
  const avgTimeToNextMs: Partial<Record<FunnelStage, number | null>> = {};
  for (const stage of STAGES) {
    const arr = stageDeltas[stage];
    avgTimeToNextMs[stage] = arr?.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;
  }

  // Top drop-off pages: exitPath grouped by the stage sessions got stuck at
  // (booking = success, so it's excluded — those visitors didn't drop off).
  const dropOffPages: Record<string, { path: string; count: number }[]> = {};
  {
    const byStage: Record<string, Map<string, number>> = {};
    for (const g of dropoffGroups) {
      const stage = g.highestStageReached;
      if (!stage || stage === "booking") continue;
      const path = g.exitPath ?? "—";
      (byStage[stage] ??= new Map<string, number>()).set(
        path,
        (byStage[stage].get(path) ?? 0) + g._count._all,
      );
    }
    for (const stage of STAGES) {
      const m = byStage[stage];
      if (m) {
        dropOffPages[stage] = [...m.entries()]
          .map(([path, count]) => ({ path, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5);
      }
    }
  }

  const funnelView: FunnelView = {
    ...computeFunnel({
      reachedByRank,
      revenue: Number(revenueAgg._sum.conversionValue ?? 0),
      avgTimeToNextMs,
    }),
    dropOffPages,
  };

  // Build a query string for pagination links, preserving the active filters.
  const baseParams = new URLSearchParams();
  if (range.key === "custom") {
    baseParams.set("from", range.fromInput);
    baseParams.set("to", range.toInput);
  } else {
    baseParams.set("range", range.key);
  }
  if (convertedOnly) baseParams.set("converted", "1");
  if (identifiedOnly) baseParams.set("identified", "1");
  if (utmSource) baseParams.set("utmSource", utmSource);
  if (landing) baseParams.set("landing", landing);
  const pageHref = (p: number) => {
    const q = new URLSearchParams(baseParams);
    q.set("page", String(p));
    return `?${q.toString()}`;
  };

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/agency/hotel/${hotel.id}`} className="text-sm text-ink-tertiary hover:underline">
          ← {hotel.name}
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Recent Visitor Journeys</h1>
            <p className="text-ink-tertiary">
              Page-by-page paths, time on page, and where visitors dropped off.
            </p>
          </div>
          <p className="text-sm text-ink-tertiary">
            <span className="font-medium text-ink-secondary">{total}</span> session
            {total === 1 ? "" : "s"} · {range.label.toLowerCase()}
          </p>
        </div>
      </div>

      <JourneyFilters
        rangeKey={range.key}
        convertedOnly={convertedOnly}
        identifiedOnly={identifiedOnly}
        utmSource={utmSource}
        landing={landing}
        utmOptions={utmOptions}
        landingOptions={landingOptions}
      />

      {/* Funnel Analysis — aggregate stage funnel + drop-off (Phase 2) */}
      <section className="overflow-hidden rounded-xl border border-line">
        <div className="border-b border-line px-4 py-3">
          <h2 className="font-medium">Funnel Analysis</h2>
          <p className="mt-0.5 text-sm text-ink-tertiary">
            How many visitors reached each funnel stage, where they dropped off, and the
            bottleneck pages.
          </p>
        </div>
        <div className="p-4">
          <FunnelAnalysis funnel={funnelView} />
        </div>
      </section>

      {/* Clicks Analytics (Phase 3, Part 4) */}
      <section className="overflow-hidden rounded-xl border border-line">
        <div className="border-b border-line px-4 py-3">
          <h2 className="font-medium">Clicks Analytics</h2>
          <p className="mt-0.5 text-sm text-ink-tertiary">
            Which tagged buttons &amp; links visitors click, and how often those clicks lead
            to a booking.
          </p>
        </div>
        <ClicksAnalytics rows={clickAnalytics} />
      </section>

      {/* Form Abandonment (Phase 3, Part 5) */}
      <section className="overflow-hidden rounded-xl border border-line">
        <div className="border-b border-line px-4 py-3">
          <h2 className="font-medium">Form Abandonment</h2>
          <p className="mt-0.5 text-sm text-ink-tertiary">
            Where visitors drop off inside your booking form — which fields they enter and
            which they leave empty.
          </p>
        </div>
        <div className="p-4">
          <FormAbandonment rows={formAbandonment} />
        </div>
      </section>

      <JourneyList sessions={items} />

      {/* Customer Journey Lookup (Phase 3, Part 6) — the "VIP customer view". */}
      <section className="overflow-hidden rounded-xl border border-line">
        <div className="border-b border-line px-4 py-3">
          <h2 className="font-medium">Customer Journey Lookup</h2>
          <p className="mt-0.5 text-sm text-ink-tertiary">
            Look up a specific visitor by name, email, or phone to see their complete history
            with the hotel — every visit, page, click, and form interaction.
          </p>
        </div>
        <div className="p-4">
          <CustomerJourneyLookup hotelId={hotel.id} />
        </div>
      </section>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          {pageNum > 1 ? (
            <Link href={pageHref(pageNum - 1)} className="rounded-lg border border-line-strong bg-elevated px-3 py-1.5 font-medium text-ink-secondary hover:bg-line-strong">
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-ink-tertiary">
            Page {pageNum} of {totalPages}
          </span>
          {pageNum < totalPages ? (
            <Link href={pageHref(pageNum + 1)} className="rounded-lg border border-line-strong bg-elevated px-3 py-1.5 font-medium text-ink-secondary hover:bg-line-strong">
              Next →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}
