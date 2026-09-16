import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import {
  ok,
  ratio,
  sum,
  notTraceable,
  unavailable,
  isOk,
  type MetricValue,
} from "@/lib/metrics/metric-value";
import { zonedDayString } from "@/lib/timezone";
import { whenMigrated } from "@/lib/missing-table";
import { summariseTrackerDays, type TrackerDay } from "@/lib/ops-tracker/metrics";
import { datesInRange } from "@/lib/metrics/contact-report";
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
  /**
   * The workbook counts EVERY call the property took, not only the ones an ad
   * connected — so it must not be read as an advertising result. The caption
   * names the recorder, because that is what makes the number unattributable.
   */
  calls:
    "Calls logged by the property's own team. Counts every call received, not only calls from ads — so it cannot be credited to any one channel.",
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

/**
 * Says the figure was not CAPTURED, not that nothing happened.
 *
 * The first wording here was "No advertising activity was recorded in this
 * period", which was plainly false on a hotel that had spent ₹20,857 on Meta in
 * the same window — the campaign table simply had no rows carrying the column.
 * Telling a hotel its ads produced nothing, when the truth is that nobody
 * measured, is the one mistake this module exists to prevent.
 */
const NO_CAMPAIGN_REPORTING =
  "Meta has not reported campaign-level results for this period, so this figure is not available. It is not a zero.";

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
        _sum: { messagingStarted: true },
        _max: { date: true },
        _count: { messagingStarted: true },
      }),
      whenMigrated("operations tracker", [], () =>
        agencyScoped(prisma.manualLeadDaily).findMany({
          where: { hotelClientId, date: dayFilter },
          orderBy: { date: "asc" },
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
  // _count on a nullable column counts NON-NULL rows, so zero means no campaign
  // row in this window carried the figure — it was never captured, rather than
  // captured as none. Summing regardless would report a confident 0.
  const whatsappMessages: MetricValue<number> = !metaConnected
    ? unavailable("Meta Ads is not connected.")
    : campaigns._count.messagingStarted === 0
      ? unavailable(NO_CAMPAIGN_REPORTING)
      : ok(num(campaigns._sum.messagingStarted));

  // ── The property's own call log ────────────────────────────────────────────
  //
  // CALLS COME FROM THE OPERATIONS WORKBOOK, NOT FROM META. Meta's click-to-call
  // figure counts only calls its own ads connected; the workbook's "Total Calls
  // Received" column counts every call the property took. They are different
  // quantities, and the second is the one the hotel recognises as "calls".
  //
  // Run through summariseTrackerDays rather than summed here, so this figure
  // obeys the same reconciliation rules as every other tracker number: a day
  // whose disposition columns contradict its stored total is withheld rather
  // than added in, and a missing day stays missing instead of counting as zero.
  // That is also why the whole row is selected above — the checks need columns
  // this report never displays.
  //
  // NOT ATTRIBUTABLE TO ANY CHANNEL. The workbook has no source or campaign
  // column, so this number cannot be credited to Meta, to Google, or to
  // anything else, and the caption says so.
  const trackerSummary = summariseTrackerDays(
    tracker.map(
      (r): TrackerDay => ({
        date: r.date.toISOString().slice(0, 10),
        enquiries: r.enquiries,
        repeatContacts: r.repeatContacts,
        roomNightsConfirmed: r.roomNightsConfirmed,
        junkSpam: r.junkSpam,
        soldOut: r.soldOut,
        inhouse: r.inhouse,
        lowBudget: r.lowBudget,
        lessRoom: r.lessRoom,
        whatsappLeads: r.whatsappLeads,
        whatsappConfirmed: r.whatsappConfirmed,
        totalCallsReceived: r.totalCallsReceived,
        storedTotalLeads: r.storedTotalLeads,
        storedConversionRate:
          r.storedConversionRate == null ? null : Number(r.storedConversionRate),
      }),
    ),
    datesInRange(range),
  );

  const calls = trackerSummary.totalCallsReceived;

  // ── Bookings ───────────────────────────────────────────────────────────────
  //
  // Room nights come from the property's own workbook, never from tracking. A
  // period with no rows is not a period with no room nights — nobody filed.
  // Same summary, so the two tracker figures cannot disagree about which days
  // counted. summariseTrackerDays already renders an unrecorded period as an
  // unknown; ROOM_NIGHTS_NONE_RECORDED replaces its generic wording with the
  // sentence that names who records them.
  const totalRoomNights: MetricValue<number> = isOk(trackerSummary.roomNightsConfirmed)
    ? trackerSummary.roomNightsConfirmed
    : notTraceable(ROOM_NIGHTS_NONE_RECORDED);

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
  // CAMPAIGN rows are a SEPARATE table from the account-level spend rows, and
  // the two fall behind independently — in production on 2026-09-16 the account
  // table was current while the campaign table had written nothing since the
  // 10th. Reading this tile's coverage off `meta` suppressed the warning on the
  // one figure that needed it, which is why it gets its own.
  const campaignNote = coverageNote("Meta Ads campaign reporting", campaigns._max.date);
  const googleNote = coverageNote("Google Ads", google._max.date);
  // completeThrough is the tracker's own answer for "the latest day with a row",
  // already computed by the summary — deriving it a second time here is how the
  // two would drift apart.
  const trackerNote = coverageNote(
    "The property's operations tracker",
    trackerSummary.completeThrough
      ? new Date(`${trackerSummary.completeThrough}T00:00:00.000Z`)
      : null,
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
      // Calls moved to the operations workbook, so it takes the tracker's
      // coverage — not Meta's. Reading staleness off the wrong source is how a
      // figure that stops mid-period gets presented as if it covered all of it.
      calls: trackerNote,
      whatsappMessages: campaignNote,
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
