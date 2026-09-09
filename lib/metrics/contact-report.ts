import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { platformHealth, type DataHealth } from "@/lib/data-health";
import { ok, notTraceable, unavailable, type MetricValue } from "@/lib/metrics/metric-value";
import {
  summariseTrackerDays,
  type TrackerDay,
  type TrackerSummary,
} from "@/lib/ops-tracker/metrics";
import { zonedDayString } from "@/lib/timezone";
import type { ResolvedRange } from "@/lib/attribution";

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER CONTACT, HONESTLY ATTRIBUTED.
//
// THE CONSTRAINT THAT SHAPES ALL OF THIS: the operations trackers have no source
// or campaign column. Nothing anywhere records whether a call or a WhatsApp lead
// came from Google, Meta, organic search or a hoarding. Platform-reported
// conversions are a different thing again — each platform's own estimate, on its
// own definition, in its own attribution window.
//
// So there are THREE BLOCKS and they are never added together:
//
//   A · What actually happened      — the property's own team, not measured by
//                                     us, NOT attributable to a channel.
//   B · What the ad platforms report — their claim, their definition.
//   C · What HotelTrack measured    — ours, with its evidence grade.
//
// Summing A and B would double count by an unknown amount: a call recorded by
// the front desk may well be the same customer as a Meta "conversation started",
// and nothing in either system can tell us. There is exactly one permitted
// bridge and it is a RATIO, labelled as blended and not channel-attributable.
//
// PER-SOURCE FRESHNESS is on every block. Google Ads sync was dead for 14 days
// in production with lastSyncError null — failing silently — while Meta was
// current, and the report cheerfully rendered both side by side as though they
// described the same window. A figure whose source stopped updating before the
// period ended is not a current figure, and the block says so.
// ─────────────────────────────────────────────────────────────────────────────

export type SourceFreshness = {
  label: string;
  health: DataHealth;
  lastUpdatedAt: Date | null;
  /**
   * True when the newest data from this source predates the END of the selected
   * period — i.e. the block cannot possibly cover the window it is sitting under.
   */
  staleForPeriod: boolean;
  /** Ready-to-render sentence when stale; null when the source covers the period. */
  staleNote: string | null;
};

function freshnessOf(args: {
  label: string;
  connected: boolean;
  needsReconnect?: boolean;
  lastUpdatedAt: Date | null;
  range: ResolvedRange;
  now: Date;
}): SourceFreshness {
  const { label, connected, needsReconnect, lastUpdatedAt, range, now } = args;
  const health = platformHealth({ label, connected, needsReconnect, lastSyncedAt: lastUpdatedAt, now });

  // The period's end, or now if the period is still running — a period ending
  // tomorrow cannot make today's data stale.
  const coverageDeadline = Math.min(range.until.getTime(), now.getTime());
  const staleForPeriod = lastUpdatedAt != null && lastUpdatedAt.getTime() < coverageDeadline;

  return {
    label,
    health,
    lastUpdatedAt,
    staleForPeriod,
    staleNote: staleForPeriod
      ? `${label} last updated ${zonedDayString(lastUpdatedAt!, range.timezone)}, which is before the end of this period — figures below do not cover the whole window.`
      : null,
  };
}

// ── Block A · the property's own record ─────────────────────────────────────

export type BlockA = {
  /** Which property this covers, or null for the whole group. */
  segmentName: string | null;
  summary: TrackerSummary;
  freshness: SourceFreshness;
  /** Workbook tabs that arrived but map to no property — surfaced, not dropped. */
  unmappedTabs: string[];
  /** True when at least one property in scope recorded nothing at all. */
  propertiesMissingData: string[];
};

/** Every calendar date in the range, in the property timezone. */
export function datesInRange(range: ResolvedRange): string[] {
  const out: string[] = [];
  const DAY = 86_400_000;
  for (let t = range.since.getTime(); t <= range.until.getTime(); t += DAY) {
    const d = zonedDayString(new Date(t), range.timezone);
    if (out.at(-1) !== d) out.push(d);
  }
  return out;
}

export async function loadBlockA(args: {
  hotelClientId: string;
  range: ResolvedRange;
  /** Null = all properties (group view). */
  segmentId: string | null;
  now?: Date;
}): Promise<BlockA> {
  const { hotelClientId, range, segmentId } = args;
  const now = args.now ?? new Date();

  const [rows, segments] = await Promise.all([
    agencyScoped(prisma.manualLeadDaily).findMany({
      where: {
        hotelClientId,
        ...(segmentId ? { propertySegmentId: segmentId } : {}),
        date: {
          gte: new Date(`${zonedDayString(range.since, range.timezone)}T00:00:00.000Z`),
          lte: new Date(`${zonedDayString(range.until, range.timezone)}T00:00:00.000Z`),
        },
      },
      orderBy: { date: "asc" },
    }),
    agencyScoped(prisma.propertySegment).findMany({
      where: { hotelClientId, isActive: true },
      select: { id: true, name: true },
      orderBy: { displayOrder: "asc" },
    }),
  ]);

  const days: TrackerDay[] = rows.map((r) => ({
    date: r.date.toISOString().slice(0, 10),
    enquiries: r.enquiries,
    repeatContacts: r.repeatContacts,
    roomNightsConfirmed: r.roomNightsConfirmed,
    junkSpam: r.junkSpam,
    soldOut: r.soldOut,
    inhouse: r.inhouse,
    lowBudget: r.lowBudget,
    lessRoom: r.lessRoom,
    lowBudgetLessRoom: r.lowBudgetLessRoom,
    whatsappLeads: r.whatsappLeads,
    whatsappConfirmed: r.whatsappConfirmed,
    totalCallsReceived: r.totalCallsReceived,
    storedTotalLeads: r.storedTotalLeads,
    storedConversionRate: r.storedConversionRate == null ? null : Number(r.storedConversionRate),
  }));

  // A tab that arrived but maps to nothing is a configuration gap. It is
  // reported rather than silently dropped, because a property whose data is
  // quietly absent looks identical to a property with no business.
  const unmapped = await agencyScoped(prisma.manualLeadDaily).findMany({
    where: { hotelClientId, propertySegmentId: null },
    select: { sourceTabName: true },
    distinct: ["sourceTabName"],
  });

  const withData = new Set(rows.map((r) => r.propertySegmentId).filter(Boolean) as string[]);
  const propertiesMissingData = segmentId
    ? []
    : segments.filter((s) => !withData.has(s.id)).map((s) => s.name);

  const lastImport = rows.reduce<Date | null>(
    (max, r) => (max == null || r.importedAt > max ? r.importedAt : max),
    null,
  );

  return {
    segmentName: segmentId ? (segments.find((s) => s.id === segmentId)?.name ?? null) : null,
    summary: summariseTrackerDays(days, datesInRange(range)),
    freshness: freshnessOf({
      label: "Operations tracker",
      connected: segments.some((s) => s.id != null),
      lastUpdatedAt: lastImport,
      range,
      now,
    }),
    unmappedTabs: unmapped.map((u) => u.sourceTabName),
    propertiesMissingData,
  };
}

// ── Block B · what the platforms report ─────────────────────────────────────

/** Why a platform metric is missing, naming the field rather than shrugging. */
export const MISSING_MESSAGING =
  "Messaging conversations are not stored. The Meta sync does not request the Insights " +
  "`actions` breakdown, so `onsite_conversion.messaging_conversation_started_7d` never " +
  "reaches the database. It cannot be substituted with another metric.";

export const MISSING_CALL_CONVERSIONS =
  "Call conversions are not stored. The Google Ads sync does not segment by " +
  "`segments.conversion_action_name`, so conversions arrive as one undifferentiated " +
  "total with no action type. It cannot be substituted with another metric.";

export const CONVERSIONS_UNTYPED =
  "Platform-reported conversions, action type not recorded. This is the platform's own " +
  "count on its own definition and attribution window — not a booking measured by HotelTrack, " +
  "and not comparable with the other blocks.";

export type PlatformBlock = {
  platform: "meta" | "google";
  label: string;
  impressions: MetricValue<number>;
  clicks: MetricValue<number>;
  spend: MetricValue<number>;
  /** The platform's own conversion count. Action type is NOT recorded. */
  conversions: MetricValue<number>;
  /** Never available today; the reason names the missing field. */
  messagingConversations: MetricValue<number>;
  callConversions: MetricValue<number>;
  freshness: SourceFreshness;
};

export async function loadBlockB(args: {
  hotelClientId: string;
  range: ResolvedRange;
  metaConnected: boolean;
  metaNeedsReconnect?: boolean;
  now?: Date;
}): Promise<PlatformBlock[]> {
  const { hotelClientId, range, metaConnected, metaNeedsReconnect } = args;
  const now = args.now ?? new Date();

  // PLATFORM-DAY ROWS. `date` is @db.Date — already bucketed into the platform
  // account's own day, which is not the property's timezone and cannot be
  // re-derived from a bare calendar date. Selected by the date the property
  // would name, never converted. Platform days and site days may differ by up to
  // one day at each boundary; the methodology note says so.
  const dayFilter = {
    gte: new Date(`${zonedDayString(range.since, range.timezone)}T00:00:00.000Z`),
    lte: new Date(`${zonedDayString(range.until, range.timezone)}T00:00:00.000Z`),
  };

  const [meta, google, googleConn] = await Promise.all([
    agencyScoped(prisma.adSnapshot).aggregate({
      where: { hotelClientId, archived: false, date: dayFilter },
      _sum: { impressions: true, clicks: true, spend: true, conversions: true },
      _max: { date: true },
      _count: true,
    }),
    agencyScoped(prisma.googleAdsCampaignSnapshot).aggregate({
      where: { hotelClientId, date: dayFilter },
      _sum: { impressions: true, clicks: true, spend: true, conversions: true },
      _max: { date: true },
      _count: true,
    }),
    agencyScoped(prisma.googleAdsConnection).findFirst({
      where: { hotelClientId },
      select: { status: true, lastSyncedAt: true },
    }),
  ]);

  const num = (v: unknown): number => (v == null ? 0 : Number(v));

  const block = (
    platform: "meta" | "google",
    label: string,
    agg: { _sum: Record<string, unknown>; _max: { date: Date | null }; _count: number },
    connected: boolean,
    lastSyncedAt: Date | null,
    needsReconnect: boolean,
  ): PlatformBlock => {
    // No rows is NOT zero impressions — it is no data for this window.
    const none = agg._count === 0;
    const m = (v: unknown): MetricValue<number> =>
      none
        ? unavailable(`${label} reported no days inside this period.`)
        : ok(num(v));

    return {
      platform,
      label,
      impressions: connected ? m(agg._sum.impressions) : unavailable(`${label} is not connected.`),
      clicks: connected ? m(agg._sum.clicks) : unavailable(`${label} is not connected.`),
      spend: connected ? m(agg._sum.spend) : unavailable(`${label} is not connected.`),
      conversions: connected ? m(agg._sum.conversions) : unavailable(`${label} is not connected.`),
      // notTraceable rather than unavailable: the distinction is that we know
      // exactly which field is absent and why, not that the number is unknowable.
      messagingConversations: notTraceable(
        platform === "meta" ? MISSING_MESSAGING : MISSING_CALL_CONVERSIONS,
      ),
      callConversions: notTraceable(
        platform === "google" ? MISSING_CALL_CONVERSIONS : MISSING_MESSAGING,
      ),
      freshness: freshnessOf({ label, connected, needsReconnect, lastUpdatedAt: lastSyncedAt, range, now }),
    };
  };

  return [
    block("meta", "Meta Ads", meta, metaConnected, meta._max.date, Boolean(metaNeedsReconnect)),
    block(
      "google",
      "Google Ads",
      google,
      // A GoogleAdsConnection row existing at all means an account was linked;
      // REVOKED means it no longer is. TOKEN_EXPIRED and ERROR are connected but
      // broken, which platformHealth renders differently from not-connected —
      // "reconnect this" is a different instruction from "connect this".
      googleConn != null && googleConn.status !== "REVOKED",
      googleConn?.lastSyncedAt ?? google._max.date,
      googleConn?.status === "TOKEN_EXPIRED" || googleConn?.status === "ERROR",
    ),
  ];
}

// ── The one permitted bridge ────────────────────────────────────────────────

export const BLENDED_COST_NOTE =
  "Total advertising spend divided by every customer contact recorded in the period, across " +
  "both properties and every source. It is NOT a cost per lead for any channel: nothing " +
  "records which channel produced a call or a WhatsApp message, so this figure cannot be " +
  "credited to Google, to Meta, or to anything else.";

/**
 * Spend ÷ recorded contacts. Deliberately not called cost per lead, never
 * broken down by channel, and never turned into a ROAS.
 *
 * Both sides must cover the same period or the ratio is meaningless, so a
 * missing side yields unavailable rather than a partial-period figure.
 */
export function blendedCostPerContact(
  spend: MetricValue<number>,
  contacts: MetricValue<number>,
): MetricValue<number> {
  if (spend.state !== "ok") {
    return unavailable("Advertising spend for this period is not available, so this cannot be computed.");
  }
  if (contacts.state !== "ok") {
    return unavailable("Recorded contacts for this period are not available, so this cannot be computed.");
  }
  if (contacts.value === 0) {
    return unavailable("No customer contacts were recorded in this period, so there is nothing to divide by.");
  }
  return ok(spend.value / contacts.value);
}
