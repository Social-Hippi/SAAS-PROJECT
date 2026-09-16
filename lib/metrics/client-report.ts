import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import {
  ok,
  ratio,
  sum,
  notTraceable,
  unavailable,
  type MetricValue,
} from "@/lib/metrics/metric-value";
import { zonedDayString } from "@/lib/timezone";
import { whenMigrated } from "@/lib/missing-table";
import { REPORTING_CURRENCY } from "@/lib/ad-spend";
import type { ResolvedRange } from "@/lib/attribution";

// ─────────────────────────────────────────────────────────────────────────────
// THE CLIENT REPORT — nine figures, and nothing else.
//
// /share/<uuid> used to render <FullHotelDashboard>, the same ~25-panel surface
// the agency sees. That was deliberate (one component cannot drift from itself)
// but it answered the agency's question, not the hotel's. A hotel owner opens
// this link to learn four things: what came in, what it cost, how many people
// got in touch, and how many of them booked. Everything else is the agency's
// working-out.
//
// So this module returns exactly the nine figures on that report and no others.
// It is the ONLY loader the share page calls.
//
// EVERY FIELD IS A MetricValue. Not one is a bare number, and none is coerced
// with `?? 0`. The distinction this report lives or dies by is the one between
// "zero happened" and "we cannot see it":
//
//   ok(0)          We looked, and the answer is none. A finding.
//   unavailable    We normally receive this; the integration is not connected
//                  or reported no days. ACTION: connect / check it.
//   not_traceable  The signal is never collected, by design or by platform
//                  policy. ACTION: none available — say so plainly.
//
// Rendering "0" for any of the bottom two would tell a hotel its marketing
// produced nothing, when the truth is that nobody measured. That is the single
// most expensive lie this product could tell, because the hotel would act on it.
//
// MULTI-TENANCY. Every query goes through agencyScoped(), which filters by
// agencyId. The share page installs the tenant override from the ShareLink row
// before calling this, so a link can only ever read its own agency's rows.
// ─────────────────────────────────────────────────────────────────────────────

/** The nine figures, in the order the report presents them. */
export type ClientReport = {
  // RESULTS
  totalRevenue: MetricValue<number>;
  returnOnAdSpend: MetricValue<number>;
  // ADVERTISING SPEND
  googleSpend: MetricValue<number>;
  metaSpend: MetricValue<number>;
  // ENQUIRIES GENERATED
  calls: MetricValue<number>;
  whatsappMessages: MetricValue<number>;
  instagramMessages: MetricValue<number>;
  // BOOKINGS
  totalBookings: MetricValue<number>;
  totalRoomNights: MetricValue<number>;
  /** ISO code for every money figure above. */
  currency: string;
  /**
   * Per-tile coverage warning, or null when the source covers the whole window.
   *
   * Keyed by tile rather than by source so the component never has to know which
   * system feeds which figure — three tiles come from Meta and would otherwise
   * each need that mapping repeated.
   */
  staleNote: Partial<Record<keyof Omit<ClientReport, "currency" | "staleNote">, string>>;
};

// ── Copy ─────────────────────────────────────────────────────────────────────
//
// Each caption states the SOURCE and the LIMIT, because a number a hotel cannot
// place is a number it will misread. These are display strings, kept together so
// the report's voice stays one voice.

export const CAPTION = {
  totalRevenue: "Booking value recorded on the website in this period.",
  /**
   * Named honestly in its own caption. This is total revenue over total spend —
   * revenue from direct and organic visits is in the numerator, and none of it
   * was bought with the spend in the denominator.
   *
   * lib/owner-metrics.ts calls this figure `blended` and reserves "ROAS" for
   * paid-revenue-over-paid-spend, for good reason: the un-blended version of
   * this metric once divided ALL revenue by META-ONLY spend and produced
   * spectacular nonsense. The label here is the hotel's word for it; the caption
   * is what stops it being the same lie.
   */
  returnOnAdSpend:
    "Total revenue ÷ total ad spend. Includes bookings that came from direct and organic visits, not only from ads.",
  calls: "Calls connected from click-to-call ads.",
  whatsappMessages:
    "Conversations started from your ads. Meta reports WhatsApp, Messenger and Instagram together in this figure.",
  totalBookings: "Bookings completed on your website in this period.",
  totalRoomNights:
    "Room nights confirmed by the property. One booking can be several nights.",
} as const;

/**
 * Instagram DM counts are not obtainable AT ALL — not missing, not disconnected.
 * Meta's Insights API folds Instagram into the combined messaging figure and
 * exposes no Instagram-only breakdown to connected tools, so there is no
 * integration to fix and no setting to turn on. The tile exists anyway: a hotel
 * that asks "how many people DM'd us?" deserves the real answer rather than a
 * silently absent card it will read as zero.
 */
export const INSTAGRAM_DM_UNTRACEABLE =
  "Instagram does not share message counts with connected analytics tools, so we cannot report this.";

const ROOM_NIGHTS_NONE_RECORDED =
  "Room nights are recorded by the property's own reservations team. None have been recorded for this period.";

const NO_AD_ACTIVITY = "No advertising activity was recorded in this period.";

// ── Loader ───────────────────────────────────────────────────────────────────

export async function loadClientReport(args: {
  hotelClientId: string;
  range: ResolvedRange;
  /**
   * The hotel's showAdSpendToHotel flag. When false the two spend tiles AND the
   * return-on-ad-spend tile are withheld — the ratio is revenue ÷ spend, so
   * publishing it beside a known revenue hands back the spend by division.
   * See lib/share-spend-gate.ts for the same rule on the client-fetched routes.
   */
  showAdSpend: boolean;
}): Promise<ClientReport> {
  const { hotelClientId, range, showAdSpend } = args;

  // PLATFORM-DAY ROWS. `date` is @db.Date on every ad table — already bucketed
  // into the platform account's own day, which is not the property's timezone
  // and cannot be re-derived from a bare calendar date. Selected by the date the
  // property would name, never converted. Matches loadBlockB exactly, so the two
  // reports cannot disagree about which days are in the window.
  const dayFilter = {
    gte: new Date(`${zonedDayString(range.since, range.timezone)}T00:00:00.000Z`),
    lte: new Date(`${zonedDayString(range.until, range.timezone)}T00:00:00.000Z`),
  };

  // Site-side events are real timestamps and ARE compared in real time.
  const eventFilter = { gte: range.since, lte: range.until };

  const [conversions, anyTraffic, meta, google, googleConn, metaToken, campaigns, tracker] =
    await Promise.all([
      agencyScoped(prisma.trackingEvent).aggregate({
        where: { hotelClientId, eventType: "conversion", createdAt: eventFilter },
        _sum: { conversionValue: true },
        _count: true,
      }),
      // Distinguishes "no bookings" from "the snippet is not reporting". Without
      // this, an uninstalled snippet and a genuinely quiet month are the same
      // ₹0 — and only one of them is the hotel's problem.
      agencyScoped(prisma.trackingEvent).count({
        where: { hotelClientId, createdAt: eventFilter },
      }),
      agencyScoped(prisma.adSnapshot).aggregate({
        where: { hotelClientId, archived: false, date: dayFilter },
        _sum: { spend: true },
        _max: { date: true },
        _count: true,
      }),
      agencyScoped(prisma.googleAdsCampaignSnapshot).aggregate({
        where: { hotelClientId, date: dayFilter },
        _sum: { spend: true },
        _max: { date: true },
        _count: true,
      }),
      agencyScoped(prisma.googleAdsConnection).findFirst({
        where: { hotelClientId },
        select: { status: true },
      }),
      agencyScoped(prisma.metaToken).findFirst({
        where: { hotelClientId },
        select: { status: true },
      }),
      // Calls and messaging conversations live on the CAMPAIGN snapshot, not the
      // account-level AdSnapshot — lib/meta.ts reads them out of the Insights
      // `actions` breakdown per campaign. Both columns are nullable: null means
      // "this row predates the column", which is not zero.
      agencyScoped(prisma.adCampaignSnapshot).aggregate({
        where: { hotelClientId, archived: false, date: dayFilter },
        _sum: { calls: true, messagingStarted: true },
        _count: { calls: true, messagingStarted: true },
      }),
      whenMigrated("operations tracker", [], () =>
        agencyScoped(prisma.manualLeadDaily).findMany({
          where: { hotelClientId, date: dayFilter },
          select: { roomNightsConfirmed: true, date: true },
        }),
      ),
    ]);

  const num = (v: unknown): number => (v == null ? 0 : Number(v));

  // ── Advertising spend ──────────────────────────────────────────────────────
  //
  // "Not connected" and "connected but silent" are different sentences and get
  // different ones. A REVOKED Google connection is not connected; a live one
  // with no rows in this window genuinely ran nothing.
  const googleConnected = googleConn != null && googleConn.status !== "REVOKED";
  const metaConnected = metaToken != null && metaToken.status !== "REVOKED";

  const spendOf = (
    label: string,
    connected: boolean,
    agg: { _sum: { spend: unknown }; _count: number },
  ): MetricValue<number> =>
    !connected
      ? unavailable(`${label} is not connected.`)
      : agg._count === 0
        ? unavailable(NO_AD_ACTIVITY)
        : ok(num(agg._sum.spend));

  const googleSpend = spendOf("Google Ads", googleConnected, google);
  const metaSpend = spendOf("Meta Ads", metaConnected, meta);

  // ── Results ────────────────────────────────────────────────────────────────
  const totalRevenue: MetricValue<number> =
    anyTraffic === 0
      ? unavailable(
          "No website activity was recorded in this period, so booking value cannot be reported.",
        )
      : ok(num(conversions._sum.conversionValue));

  const totalBookings: MetricValue<number> =
    anyTraffic === 0
      ? unavailable(
          "No website activity was recorded in this period, so bookings cannot be reported.",
        )
      : ok(conversions._count);

  // Return on ad spend divides the two. Both helpers below propagate the unknown
  // rather than laundering it: an unknown denominator must never quietly become
  // a SMALLER one, because that inflates the ratio and overstates the agency's
  // own performance — the one direction of error nobody here would catch.
  //
  // A platform that was never connected contributes a real zero: an account that
  // does not exist spent nothing, and letting that make the total unknown would
  // withhold a perfectly good ratio from every single-platform hotel. A platform
  // that IS connected but reported nothing stays unknown, and `sum` then makes
  // the whole total unknown — which is the honest answer.
  const contribution = (connected: boolean, m: MetricValue<number>) =>
    connected ? m : ok(0);

  const totalSpend = sum([
    contribution(googleConnected, googleSpend),
    contribution(metaConnected, metaSpend),
  ]);

  const returnOnAdSpend = ratio(totalRevenue, totalSpend, {
    zeroDenominatorReason:
      "No advertising spend was recorded in this period, so there is nothing to divide by.",
  });

  // ── Enquiries generated ────────────────────────────────────────────────────
  //
  // _count on a nullable column counts NON-NULL rows, so zero means every row in
  // the window predates the column — the figure was never captured, rather than
  // captured as none.
  const fromCampaigns = (
    total: unknown,
    populated: number,
  ): MetricValue<number> =>
    !metaConnected
      ? unavailable("Meta Ads is not connected.")
      : populated === 0
        ? unavailable(NO_AD_ACTIVITY)
        : ok(num(total));

  const calls = fromCampaigns(campaigns._sum.calls, campaigns._count.calls);
  const whatsappMessages = fromCampaigns(
    campaigns._sum.messagingStarted,
    campaigns._count.messagingStarted,
  );

  // ── Bookings ───────────────────────────────────────────────────────────────
  //
  // Room nights come from the property's own workbook, never from tracking. A
  // period with no rows is not a period with no room nights — nobody filed.
  const recorded = tracker.filter((r) => r.roomNightsConfirmed != null);
  const totalRoomNights: MetricValue<number> =
    recorded.length === 0
      ? notTraceable(ROOM_NIGHTS_NONE_RECORDED)
      : ok(recorded.reduce((t, r) => t + (r.roomNightsConfirmed ?? 0), 0));

  // ── Coverage ───────────────────────────────────────────────────────────────
  //
  // A figure whose source stopped before the period ended is not a figure for
  // that period, and saying so is the difference between "you spent ₹92,740" and
  // "you spent ₹92,740, and a day is missing".
  //
  // WHICH TIMESTAMP. The NEWEST DAY OF DATA, never "when the sync last ran".
  // Those come apart exactly when it matters: Google Ads syncs successfully at
  // midday and still returns nothing for today, so a last-ran check calls the
  // figure fresh while it is short a day. The newest data day cannot lie about
  // coverage, because it IS the coverage.
  //
  // Compared at DAY granularity in the property's timezone — a timestamp compare
  // would flag every source on every report as stale, and a warning that is
  // always on is a warning nobody reads.
  const periodEndsOn = zonedDayString(
    new Date(Math.min(range.until.getTime(), Date.now())),
    range.timezone,
  );
  const coverageNote = (label: string, newest: Date | null): string | undefined => {
    if (newest == null) return undefined;
    const newestDay = zonedDayString(newest, range.timezone);
    return newestDay < periodEndsOn
      ? `${label} has data up to ${newestDay}, so this figure does not cover the whole period.`
      : undefined;
  };

  const metaNote = coverageNote("Meta Ads", meta._max.date);
  const googleNote = coverageNote("Google Ads", google._max.date);
  const trackerNote = coverageNote(
    "The property's operations tracker",
    recorded.length === 0
      ? null
      : tracker.reduce<Date | null>(
          (max, r) => (max == null || r.date > max ? r.date : max),
          null,
        ),
  );

  // Undefined entries are dropped, so a covered tile carries no key at all and
  // the component renders nothing rather than an empty warning.
  const staleNote = Object.fromEntries(
    Object.entries({
      metaSpend: showAdSpend ? metaNote : undefined,
      googleSpend: showAdSpend ? googleNote : undefined,
      // Return on ad spend divides revenue by BOTH platforms' spend, so either
      // one being short makes the ratio overstate the return.
      returnOnAdSpend: showAdSpend ? (googleNote ?? metaNote) : undefined,
      calls: metaNote,
      whatsappMessages: metaNote,
      totalRoomNights: trackerNote,
    }).filter(([, v]) => v != null),
  ) as ClientReport["staleNote"];

  // The spend gate applies LAST and replaces the values outright, so a withheld
  // figure cannot be reconstructed from anything that ships beside it.
  const withheld = unavailable("Ad spend is not shared on this report.");

  return {
    totalRevenue,
    returnOnAdSpend: showAdSpend ? returnOnAdSpend : withheld,
    googleSpend: showAdSpend ? googleSpend : withheld,
    metaSpend: showAdSpend ? metaSpend : withheld,
    calls,
    whatsappMessages,
    instagramMessages: notTraceable(INSTAGRAM_DM_UNTRACEABLE),
    totalBookings,
    totalRoomNights,
    currency: REPORTING_CURRENCY,
    staleNote,
  };
}
