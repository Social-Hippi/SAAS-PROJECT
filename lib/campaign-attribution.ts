// Campaign↔booking attribution: joins Meta campaign-day insights
// (AdCampaignSnapshot) to real snippet-tracked bookings (TrackingEvent
// conversions) and materializes the result into CampaignPerformance.
//
// MATCHING (in priority order — every conversion lands on EXACTLY ONE bucket):
//   1. EXACT       — conversion.utmCampaign matches a campaign name
//                    case-insensitively.
//   2. UTM_CONTENT — conversion.utmContent matches a campaign name exactly
//                    (case-insensitive), or contains exactly one campaign name
//                    as a substring (campaign-identifying tag fallback).
//   3. FIRST-TOUCH — the snippet already stamps every event with the FIRST UTM
//                    set seen in 30 days (_ht_attr cookie), but as a server-side
//                    fallback a conversion with no UTMs inherits them from the
//                    earliest visit in the same session, then rules 1–2 rerun.
//   4. UNATTRIBUTED — no match → the "Direct / Unattributed" bucket. Never
//                    blamed on a campaign.
//
// Pure matching logic is exported separately so it's unit-testable; the
// refresh function does the (agencyId-scoped — see CLAUDE.md) database work.

import { prisma } from "@/lib/prisma";

const DAY_MS = 86_400_000;

/** campaignKey of the "Direct / Unattributed" bucket (sorts after real names). */
export const UNATTRIBUTED_KEY = "~unattributed";
export const UNATTRIBUTED_NAME = "Direct / Unattributed";

// ─────────────────────────────────────────────────────────────────────────────
// Pure matching layer
// ─────────────────────────────────────────────────────────────────────────────

export type CampaignDay = {
  date: string; // YYYY-MM-DD
  campaignId: string;
  campaignName: string;
  spend: number;
  conversions: number;
  purchaseValue: number;
};

export type ConversionEvent = {
  id: string;
  sessionId: string;
  utmCampaign: string | null;
  utmContent: string | null;
  pageUrl: string;
  conversionValue: number | null;
  createdAt: Date;
};

export type VisitEvent = {
  sessionId: string;
  utmCampaign: string | null;
  utmContent: string | null;
  pageUrl: string;
  createdAt: Date;
};

export type AttributionReason =
  | "exact_utm_campaign"
  | "utm_content_tag"
  | "first_touch_session"
  | "unattributed";

export type AttributedConversion = {
  conversion: ConversionEvent;
  /** Lowercased campaign name, or UNATTRIBUTED_KEY. */
  campaignKey: string;
  campaignName: string;
  metaCampaignId: string | null;
  reason: AttributionReason;
  /** The first-touch visit used (rule 3), when one informed the match. */
  firstTouch: VisitEvent | null;
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Matches one UTM pair against the known campaign names.
 * Returns the campaignKey or null.
 */
function matchUtms(
  utmCampaign: string | null,
  utmContent: string | null,
  names: Map<string, { name: string; id: string }>, // key = lowercased name
): { key: string; reason: AttributionReason } | null {
  // Rule 1 — exact utm_campaign match (case-insensitive).
  const campaign = norm(utmCampaign);
  if (campaign && names.has(campaign)) {
    return { key: campaign, reason: "exact_utm_campaign" };
  }

  // Rule 2 — utm_content as a campaign-identifying tag: exact match first,
  // then "tag contains exactly one campaign name" (ambiguous → no match,
  // never guess between two campaigns).
  const content = norm(utmContent);
  if (content) {
    if (names.has(content)) return { key: content, reason: "utm_content_tag" };
    const containing = [...names.keys()].filter(
      (k) => k.length >= 3 && content.includes(k),
    );
    if (containing.length === 1) {
      return { key: containing[0], reason: "utm_content_tag" };
    }
  }

  return null;
}

/**
 * Attributes every conversion to exactly one campaign (or the unattributed
 * bucket). `visits` are only needed for the rule-3 session fallback and the
 * journey drill-down; pass the same range the conversions came from plus up to
 * 30 days before it.
 */
/**
 * One campaign's aggregated performance over a period, as the dashboard shapes
 * it for display.
 *
 * Lived in components/dashboard/CampaignPerformanceTable.tsx until that
 * component was deleted — it rendered nowhere, and a dead component that
 * computes client-facing revenue is a liability: someone remounts it in six
 * months, unreviewed, carrying whatever formula it had. The TYPE is still used,
 * so it moves here, next to the code that produces the numbers.
 */
export type CampaignRow = {
  campaignKey: string;
  campaignName: string;
  /** True for the "Direct / Unattributed" bucket (pinned last, no share shown). */
  unattributed: boolean;
  spend: number;
  realBookings: number;
  realRevenue: number;
  /** realRevenue / spend; null when spend is 0. */
  realRoas: number | null;
  metaConversions: number;
};

/**
 * The share of platform-reported conversions NOT confirmed in the property's own
 * records, as a percentage.
 *
 *     (metaReportedConversions − realBookings) / metaReportedConversions × 100
 *
 * Positive means the platform claims more than the property can confirm — which
 * is the question a client actually asks: "how much of what Meta says is real?"
 * The denominator is therefore the PLATFORM'S CLAIM, not our own count.
 *
 * THE ONLY DEFINITION. There were two, with different denominators AND opposite
 * signs: this file divided by the platform's claim, while FullHotelDashboard
 * divided by realBookings, so the same named field meant different things on the
 * same page. Both call sites now come here.
 *
 * NULL when the platform reported nothing. There is no share of zero, and the
 * previous shape returned −100% for every campaign with no confirmed booking —
 * a definite-looking figure asserting a measurement nobody took.
 */
export function unconfirmedSharePct(
  metaReportedConversions: number,
  realBookings: number,
): number | null {
  if (!(metaReportedConversions > 0)) return null;
  return ((metaReportedConversions - realBookings) / metaReportedConversions) * 100;
}

export function attributeConversions(
  conversions: ConversionEvent[],
  visits: VisitEvent[],
  campaignDays: CampaignDay[],
): AttributedConversion[] {
  // Campaign name lookup (lowercased). Last write wins on case-duplicates —
  // they aggregate under the same key anyway.
  const names = new Map<string, { name: string; id: string }>();
  for (const c of campaignDays) {
    names.set(norm(c.campaignName), { name: c.campaignName, id: c.campaignId });
  }

  // Earliest visit per session, for first-touch fallback (rule 3).
  const firstVisitBySession = new Map<string, VisitEvent>();
  for (const v of visits) {
    const prev = firstVisitBySession.get(v.sessionId);
    if (!prev || v.createdAt < prev.createdAt) firstVisitBySession.set(v.sessionId, v);
  }

  return conversions.map((conv) => {
    // Rules 1–2 on the conversion's own (already first-touch) UTMs.
    let match = matchUtms(conv.utmCampaign, conv.utmContent, names);
    let reason: AttributionReason | null = match?.reason ?? null;
    let firstTouch: VisitEvent | null = null;

    // Rule 3 — session fallback: only when the conversion carries no UTMs at
    // all (e.g. cookie blocked between pages). Re-run rules 1–2 on the
    // session's FIRST visit. 30-day cap matches the snippet cookie.
    if (!match && !conv.utmCampaign && !conv.utmContent) {
      const fv = firstVisitBySession.get(conv.sessionId);
      if (fv && conv.createdAt.getTime() - fv.createdAt.getTime() <= 30 * DAY_MS) {
        const fvMatch = matchUtms(fv.utmCampaign, fv.utmContent, names);
        if (fvMatch) {
          match = fvMatch;
          reason = "first_touch_session";
          firstTouch = fv;
        }
      }
    }

    if (match) {
      const c = names.get(match.key)!;
      return {
        conversion: conv,
        campaignKey: match.key,
        campaignName: c.name,
        metaCampaignId: c.id,
        reason: reason!,
        firstTouch,
      };
    }
    // Rule 4 — Direct / Unattributed (includes fbclid-only visits: a click id
    // without utm_campaign can't name a campaign, so it stays unblamed here).
    return {
      conversion: conv,
      campaignKey: UNATTRIBUTED_KEY,
      campaignName: UNATTRIBUTED_NAME,
      metaCampaignId: null,
      reason: "unattributed",
      firstTouch: null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation: campaign-days × attributed conversions → CampaignPerformance rows
// ─────────────────────────────────────────────────────────────────────────────

export type PerformanceRow = {
  date: string; // YYYY-MM-DD
  campaignKey: string;
  campaignName: string;
  metaCampaignId: string | null;
  metaSpend: number;
  metaReportedConversions: number;
  metaReportedRevenue: number;
  realBookings: number;
  realBookingValue: number;
  realRoas: number | null;
  variancePct: number | null;
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function aggregatePerformance(
  campaignDays: CampaignDay[],
  attributed: AttributedConversion[],
): PerformanceRow[] {
  // Union of (campaignKey, date) from BOTH sides: spend without bookings and
  // bookings without spend both produce a row.
  const rows = new Map<string, PerformanceRow>();
  const keyOf = (campaignKey: string, date: string) => `${date}|${campaignKey}`;

  for (const c of campaignDays) {
    const ck = norm(c.campaignName);
    const k = keyOf(ck, c.date);
    const row =
      rows.get(k) ??
      ({
        date: c.date,
        campaignKey: ck,
        campaignName: c.campaignName,
        metaCampaignId: c.campaignId,
        metaSpend: 0,
        metaReportedConversions: 0,
        metaReportedRevenue: 0,
        realBookings: 0,
        realBookingValue: 0,
        realRoas: null,
        variancePct: null,
      } satisfies PerformanceRow);
    row.metaSpend += c.spend;
    row.metaReportedConversions += c.conversions;
    row.metaReportedRevenue += c.purchaseValue;
    rows.set(k, row);
  }

  for (const a of attributed) {
    const date = ymd(a.conversion.createdAt);
    const k = keyOf(a.campaignKey, date);
    const row =
      rows.get(k) ??
      ({
        date,
        campaignKey: a.campaignKey,
        campaignName: a.campaignName,
        metaCampaignId: a.metaCampaignId,
        metaSpend: 0,
        metaReportedConversions: 0,
        metaReportedRevenue: 0,
        realBookings: 0,
        realBookingValue: 0,
        realRoas: null,
        variancePct: null,
      } satisfies PerformanceRow);
    row.realBookings += 1;
    row.realBookingValue += a.conversion.conversionValue ?? 0;
    rows.set(k, row);
  }

  for (const row of rows.values()) {
    row.realRoas = row.metaSpend > 0 ? row.realBookingValue / row.metaSpend : null;
    row.variancePct = unconfirmedSharePct(row.metaReportedConversions, row.realBookings);
  }

  return [...rows.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh: recompute the window and replace the stored rows (idempotent)
// ─────────────────────────────────────────────────────────────────────────────

export type RefreshResult = {
  rowsWritten: number;
  conversionsAttributed: number;
  conversionsUnattributed: number;
};

/**
 * Recomputes CampaignPerformance for one hotel over [since, until] (UTC dates).
 * Reads AdCampaignSnapshot + TrackingEvent, replaces the window's rows in one
 * transaction. Every query is scoped by agencyId + hotelClientId (CLAUDE.md).
 */
export async function refreshCampaignPerformance(
  agencyId: string,
  hotelClientId: string,
  since: Date,
  until: Date,
): Promise<RefreshResult> {
  const dayStart = new Date(`${ymd(since)}T00:00:00.000Z`);
  const dayEnd = new Date(`${ymd(until)}T23:59:59.999Z`);

  // The ad account currently mapped to this hotel — stamped onto the rows we
  // write so the materialized attribution can be archived/restored by account.
  const hotel = await prisma.hotelClient.findUnique({
    where: { id: hotelClientId },
    select: { metaAdAccountId: true },
  });
  const metaAccountId = hotel?.metaAdAccountId ?? null;

  const [snapRows, conversionRows, visitRows] = await Promise.all([
    prisma.adCampaignSnapshot.findMany({
      // Only the CURRENT account's (non-archived) campaign-days feed attribution.
      where: { agencyId, hotelClientId, archived: false, date: { gte: dayStart, lte: dayEnd } },
      select: {
        date: true,
        metaCampaignId: true,
        campaignName: true,
        spend: true,
        conversions: true,
        purchaseValue: true,
      },
    }),
    prisma.trackingEvent.findMany({
      where: {
        agencyId,
        hotelClientId,
        eventType: "conversion",
        createdAt: { gte: dayStart, lte: dayEnd },
      },
      select: {
        id: true,
        sessionId: true,
        utmCampaign: true,
        utmContent: true,
        pageUrl: true,
        conversionValue: true,
        createdAt: true,
      },
    }),
    // Visits reach back 30 extra days so rule-3 first-touch can see them.
    prisma.trackingEvent.findMany({
      where: {
        agencyId,
        hotelClientId,
        eventType: "visit",
        createdAt: { gte: new Date(dayStart.getTime() - 30 * DAY_MS), lte: dayEnd },
      },
      select: {
        sessionId: true,
        utmCampaign: true,
        utmContent: true,
        pageUrl: true,
        createdAt: true,
      },
    }),
  ]);

  const campaignDays: CampaignDay[] = snapRows.map((s) => ({
    date: ymd(s.date),
    campaignId: s.metaCampaignId,
    campaignName: s.campaignName,
    spend: Number(s.spend),
    conversions: s.conversions,
    purchaseValue: Number(s.purchaseValue),
  }));
  const conversions: ConversionEvent[] = conversionRows.map((e) => ({
    id: e.id,
    sessionId: e.sessionId,
    utmCampaign: e.utmCampaign,
    utmContent: e.utmContent,
    pageUrl: e.pageUrl,
    conversionValue: e.conversionValue == null ? null : Number(e.conversionValue),
    createdAt: e.createdAt,
  }));

  const attributed = attributeConversions(conversions, visitRows, campaignDays);
  const rows = aggregatePerformance(campaignDays, attributed);

  // Year-long backfills replace thousands of rows — Prisma's default 5s
  // transaction timeout is too tight for that, so give it room explicitly.
  await prisma.$transaction([
    // Replace only the ACTIVE rows in the window — archived old-account rows are
    // left untouched (they're hidden from the dashboard and recoverable).
    prisma.campaignPerformance.deleteMany({
      where: { agencyId, hotelClientId, archived: false, date: { gte: dayStart, lte: dayEnd } },
    }),
    prisma.campaignPerformance.createMany({
      data: rows.map((r) => ({
        agencyId,
        hotelClientId,
        metaAccountId,
        date: new Date(`${r.date}T00:00:00.000Z`),
        campaignKey: r.campaignKey,
        campaignName: r.campaignName,
        metaCampaignId: r.metaCampaignId,
        metaSpend: r.metaSpend.toFixed(2),
        metaReportedConversions: r.metaReportedConversions,
        metaReportedRevenue: r.metaReportedRevenue.toFixed(2),
        realBookings: r.realBookings,
        realBookingValue: r.realBookingValue.toFixed(2),
        realRoas: r.realRoas,
        variancePct: r.variancePct,
      })),
    }),
  ], { timeout: 120_000, maxWait: 10_000 });

  const unattributed = attributed.filter((a) => a.campaignKey === UNATTRIBUTED_KEY);
  return {
    rowsWritten: rows.length,
    conversionsAttributed: attributed.length - unattributed.length,
    conversionsUnattributed: unattributed.length,
  };
}
