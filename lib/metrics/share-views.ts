import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant";
import {
  ok,
  ratio,
  sum,
  notTraceable,
  unavailable,
  isOk,
  type MetricValue,
} from "@/lib/metrics/metric-value";
import { canonicalSourceType } from "@/lib/metrics/canonical";
import { zonedDayString } from "@/lib/timezone";
import { whenMigrated } from "@/lib/missing-table";
import { summariseTrackerDays, type TrackerDay } from "@/lib/ops-tracker/metrics";
import { datesInRange } from "@/lib/metrics/contact-report";
import { REPORTING_CURRENCY } from "@/lib/ad-spend";
import type { ResolvedRange } from "@/lib/attribution";

// ─────────────────────────────────────────────────────────────────────────────
// THE HOTEL'S REPORT, IN TWO VIEWS THAT ARE NEVER MIXED.
//
// One report used to show platform figures beside the property's own record, and
// the two invite an arithmetic nobody can defend: ₹1,13,597 of ad spend next to
// 519 calls reads as ₹219 a call, and it is not — nothing anywhere records which
// channel produced those calls. Splitting them is the point.
//
//   ADS    every figure is "what advertising produced". Never a total: WhatsApp
//          bookings here is bookings traced to an ad, not every booking the
//          property confirmed.
//
//   CLIENT what the property itself recorded, carrying no attribution language
//          at all. Bigger numbers, and deliberately no ratio anywhere near them.
//
// The split is also what finally makes return on ad spend honest. Dividing ALL
// revenue by ad spend produced 0.07x on a hotel whose business runs on WhatsApp —
// a number that read as "your ads lost money" and meant nothing. Ad revenue over
// ad spend is a real ratio.
// ─────────────────────────────────────────────────────────────────────────────

export type AdsView = {
  /** Revenue from website bookings that carried an ad click id. NOT all revenue. */
  totalRevenue: MetricValue<number>;
  /**
   * Value of WhatsApp bookings counted as coming from an ad, typed in by the
   * agency because Kraya records the booking but never its amount.
   */
  whatsappAdRevenue: MetricValue<number>;
  /**
   * (website ad revenue + WhatsApp ad revenue) ÷ ad spend. Every term is ads, so
   * this one is a true ROAS — and it stays unknown while either side is, rather
   * than dividing by a total that is quietly missing a channel.
   */
  returnOnAdSpend: MetricValue<number>;
  /**
   * Meta's own revenue ÷ Meta spend. Meta's revenue is every WhatsApp ad booking
   * (traced by the ad sticker, and those the agency ticked as coming from an ad)
   * plus website bookings from a Meta ad click.
   */
  metaRoas: MetricValue<number>;
  /** Website bookings from a Google ad click ÷ Google spend. */
  googleRoas: MetricValue<number>;
  googleSpend: MetricValue<number>;
  metaSpend: MetricValue<number>;
  /** Google click-to-call + call conversions. Kept apart from Meta's. */
  /**
   * Taps on a call button in a Google ad, connected or not. Shown BESIDE
   * googleCalls and never added to it — a guest who taps and connects is in both.
   */
  googleCallClicks: MetricValue<number>;
  /** Meta messaging conversations — WhatsApp, Instagram and Messenger together. */
  messagesGenerated: MetricValue<number>;
  /** Kraya bookings traceable to an ad. Never the property's total. */
  whatsappBookings: MetricValue<number>;
};

export type ClientView = {
  whatsappMessages: MetricValue<number>;
  calls: MetricValue<number>;
  totalRoomNights: MetricValue<number>;
  totalRevenue: MetricValue<number>;
};

export type ShareViews = {
  ads: AdsView;
  client: ClientView;
  currency: string;
  /** Per-tile coverage warning, keyed by tile. */
  staleNote: Record<string, string | undefined>;
  /** The first ad-attributed WhatsApp enquiry, or null. */
  whatsappAttributionSince: Date | null;
};

// ── Copy ─────────────────────────────────────────────────────────────────────

export const ADS_CAPTION = {
  totalRevenue:
    "Booking value from website bookings we could trace back to one of your ads. Bookings that arrived another way are in the client view.",
  whatsappAdRevenue:
    "Value of the WhatsApp bookings your agency counted as coming from an ad, entered from the reservations record. Kraya logs the booking but not the amount, so this figure is keyed in rather than measured.",
  returnOnAdSpend:
    "Website booking value plus WhatsApp booking value, divided by money spent on ads. Every part counts only advertising, so this is what the advertising returned.",
  metaRoas:
    "Revenue from WhatsApp ad bookings plus website bookings from a Meta ad, divided by money spent on Meta ads. WhatsApp bookings your agency counted as coming from an ad are credited to Meta.",
  googleRoas:
    "Website bookings from a Google ad click, divided by money spent on Google ads. WhatsApp bookings are credited to Meta, not Google, so no revenue is counted in both.",
  googleSpend: "Spend as Google Ads reports it.",
  metaSpend: "Spend as Meta reports it.",
  googleCallClicks:
    "Taps on the call button in your Google ads. A tap counts whether or not the call went through, so this is not the same as calls connected — the two are never added together.",
  messagesGenerated:
    "Conversations started from your Meta ads. Meta reports WhatsApp, Instagram and Messenger together in this one figure.",
  whatsappBookings:
    "Bookings the reservations team confirmed whose conversation began at one of your ads. Not every WhatsApp booking — those are in the client view.",
} as const;

export const CLIENT_CAPTION = {
  whatsappMessages: "WhatsApp enquiries logged by the property's own team.",
  calls:
    "Calls logged by the property's own team. Every call received, not only calls from ads — so it cannot be credited to any one channel.",
  totalRoomNights:
    "Room nights confirmed by the property. One booking can be several nights.",
  totalRevenue: "Booking value recorded by the property.",
} as const;

/**
 * Google does not break its conversions down by action type for us.
 *
 * The sync asks for a single `conversions` total and never segments by
 * `segments.conversion_action_name`, so a call, a form fill and a booking arrive
 * as one undifferentiated number. It cannot be split after the fact, and
 * substituting the total would report every conversion as a call.
 */
export const NO_GOOGLE_AD_BOOKING_YET =
  "No website booking has been traced to a Google ad in this period. Tracing needs the ad click to reach the booking engine, so this cannot be read as Google producing nothing.";

export const WHATSAPP_REVENUE_NOT_ENTERED =
  "No amount has been entered yet for the WhatsApp bookings counted as coming from an ad, so their value is not available. It is not a zero.";

export const GOOGLE_CALL_CLICKS_NOT_RETRIEVED =
  "Clicks to call have not been retrieved from Google for this period yet, so this figure is not available. It is not a zero.";

/**
 * The property records no booking value anywhere we can read.
 *
 * Its operations sheet has enquiries, room nights and dispositions but no money
 * column, and website revenue belongs to the ads view. Until a value is recorded
 * this is unknowable rather than zero.
 */
export const CLIENT_REVENUE_NOT_RECORDED =
  "The property's own records do not include a booking value, so this cannot be shown. Revenue traced to advertising is in the ads view.";

const NO_AD_ACTIVITY = "No advertising activity was recorded in this period.";
const NO_CAMPAIGN_REPORTING =
  "Meta has not reported campaign-level results for this period, so this figure is not available. It is not a zero.";
const WHATSAPP_NOT_CONNECTED =
  "The property's WhatsApp system is not connected, so enquiries and bookings from it cannot be shown.";

// ── Loader ───────────────────────────────────────────────────────────────────

export async function loadShareViews(args: {
  agencyId: string;
  hotelClientId: string;
  range: ResolvedRange;
  /** The hotel's showAdSpendToHotel flag. */
  showAdSpend: boolean;
}): Promise<ShareViews> {
  const { agencyId, hotelClientId, range, showAdSpend } = args;

  const dayFilter = {
    gte: new Date(`${zonedDayString(range.since, range.timezone)}T00:00:00.000Z`),
    lte: new Date(`${zonedDayString(range.until, range.timezone)}T00:00:00.000Z`),
  };
  const eventFilter = { gte: range.since, lte: range.until };
  const scoped = <D>(m: D) => agencyScopedFor(agencyId, m);

  const [
    conversions,
    anyTraffic,
    meta,
    metaCoverage,
    google,
    googleConn,
    metaToken,
    campaigns,
    messagingCoverage,
    krayaConn,
    tracker,
  ] = await Promise.all([
    // Every conversion in the window, classified individually below — the ads
    // view counts only those an ad click id can be traced to.
    scoped(prisma.trackingEvent).findMany({
      where: { hotelClientId, eventType: "conversion", createdAt: eventFilter },
      select: {
        conversionValue: true,
        utmSource: true,
        utmMedium: true,
        utmContent: true,
        gclid: true,
        gbraid: true,
        wbraid: true,
        fbclid: true,
      },
    }),
    scoped(prisma.trackingEvent).count({ where: { hotelClientId, createdAt: eventFilter } }),
    scoped(prisma.adSnapshot).aggregate({
      where: { hotelClientId, archived: false, date: dayFilter },
      _sum: { spend: true },
      _max: { date: true },
      _count: true,
    }),
    scoped(prisma.adSnapshot).aggregate({
      where: { hotelClientId, archived: false, date: dayFilter, spend: { gt: 0 } },
      _max: { date: true },
    }),
    scoped(prisma.googleAdsCampaignSnapshot).aggregate({
      where: { hotelClientId, date: dayFilter },
      _sum: { spend: true, callConversions: true, phoneCalls: true, callClicks: true },
      _max: { date: true },
      // Counted per field, not `_all`. Prisma's per-field count skips nulls, so
      // these say how many campaign-days actually CARRY a call figure — which is
      // what separates "Google reported no calls" from "we never retrieved it".
      // `_all` cannot make that distinction: it counts rows with spend too.
      _count: { _all: true, callConversions: true, phoneCalls: true, callClicks: true },
    }),
    scoped(prisma.googleAdsConnection).findFirst({
      where: { hotelClientId },
      select: { status: true },
    }),
    scoped(prisma.metaToken).findFirst({ where: { hotelClientId }, select: { status: true } }),
    scoped(prisma.adCampaignSnapshot).aggregate({
      where: { hotelClientId, archived: false, date: dayFilter },
      _sum: { messagingStarted: true },
      _count: { messagingStarted: true },
    }),
    // Coverage measured on rows that CARRY the figure, not the newest row: a
    // campaign row can arrive with a null messaging figure.
    scoped(prisma.adCampaignSnapshot).aggregate({
      where: {
        hotelClientId,
        archived: false,
        date: dayFilter,
        messagingStarted: { not: null },
      },
      _max: { date: true },
    }),
    scoped(prisma.krayaConnection).findFirst({ where: { hotelClientId }, select: { id: true } }),
    whenMigrated("operations tracker", [], () =>
      scoped(prisma.manualLeadDaily).findMany({
        where: { hotelClientId, date: dayFilter },
        orderBy: { date: "asc" },
      }),
    ),
  ]);

  const num = (v: unknown): number => (v == null ? 0 : Number(v));

  // ── Spend ──────────────────────────────────────────────────────────────────
  const googleConnected = googleConn != null && googleConn.status !== "REVOKED";
  const metaConnected = metaToken != null && metaToken.status !== "REVOKED";

  const spendOf = (
    label: string,
    connected: boolean,
    rows: number,
    total: unknown,
  ): MetricValue<number> =>
    !connected
      ? unavailable(`${label} is not connected.`)
      : rows === 0
        ? unavailable(NO_AD_ACTIVITY)
        : ok(num(total));

  const googleSpend = spendOf("Google Ads", googleConnected, google._count._all, google._sum.spend);
  const metaSpend = spendOf("Meta Ads", metaConnected, meta._count, meta._sum.spend);

  // ── Ad-attributed revenue ──────────────────────────────────────────────────
  //
  // Classified per conversion through the canonical layer, so a Google Hotel Ads
  // free booking link is NOT counted as paid — it is organic revenue that happens
  // to come from Google, and crediting it to ad spend is exactly the error the
  // split exists to remove.
  let adRevenue = 0;
  let adBookings = 0;
  // The same revenue, split by the platform whose click brought the guest — for
  // the per-platform ROAS tiles. Every website ad booking lands in exactly one
  // of these, so together they are adRevenue, never more.
  let googleWebRevenue = 0;
  let googleWebBookings = 0;
  let metaWebRevenue = 0;
  for (const c of conversions) {
    const value = num(c.conversionValue);
    const type = canonicalSourceType({ ...c, value });
    if (type === "meta_ads" || type === "google_ads") {
      adRevenue += value;
      adBookings += 1;
    }
    if (type === "google_ads") {
      googleWebRevenue += value;
      googleWebBookings += 1;
    }
    if (type === "meta_ads") metaWebRevenue += value;
  }

  const totalRevenue: MetricValue<number> =
    anyTraffic === 0
      ? unavailable(
          "No website activity was recorded in this period, so booking value cannot be reported.",
        )
      : ok(adRevenue);

  // WHY A ZERO HERE NEEDS EXPLAINING, when the doctrine everywhere else is that
  // ok(0) is a finding and must not be dressed up as a gap.
  //
  // It is a finding only if the measurement was capable of producing a non-zero.
  // Tracing a website booking to an ad needs the click id to survive the hop to
  // the booking engine, and that only began working once the hotel's booking
  // domains were configured — before which 4,057 ad clicks reached the site and
  // none reached the booking engine. So a zero in a window that predates the fix
  // means "we could not see it", not "the ads produced nothing", and the two read
  // identically on a tile.
  //
  // The note does not change the figure. It says what the figure can and cannot
  // be taken to mean, which is the only honest way to show a zero here.
  const noAdBookingsYet = adBookings === 0;

  // A platform that was never connected contributes a real zero: an account that
  // does not exist spent nothing. One that IS connected but reported nothing
  // stays unknown, and `sum` makes the whole total unknown — the honest answer.
  const contribution = (connected: boolean, m: MetricValue<number>) =>
    connected ? m : ok(0);
  const totalSpend = sum([
    contribution(googleConnected, googleSpend),
    contribution(metaConnected, metaSpend),
  ]);

  // ── Calls: Google only ─────────────────────────────────────────────────────
  // Meta's calls were removed from the hotel's report at the agency's request.
  // They are still synced (AdCampaignSnapshot.calls); only the report stopped
  // showing them.

  // Calls connected (metrics.phone_calls, with call conversions as a fallback)
  // were removed from this report at the agency's request. The figures are
  // still synced — GoogleAdsCampaignSnapshot.phoneCalls and .callConversions —
  // so restoring the tile needs no backfill.

  // Taps on a call button. Separate from googleCalls above and never summed with
  // it: a tap may not connect, and a connected call may have been dialled by
  // hand — the two measure different things and overlap where they meet.
  //
  // Here, unlike the calls figure, a zero IS a finding. The sync writes 0 for
  // every campaign-day when Google answered and recorded no call taps, and null
  // only when the query failed — so a non-null row is a real measurement.
  const googleCallClicks: MetricValue<number> = !googleConnected
    ? unavailable("Google Ads is not connected.")
    : google._count.callClicks > 0
      ? ok(num(google._sum.callClicks))
      : notTraceable<number>(GOOGLE_CALL_CLICKS_NOT_RETRIEVED);

  // The sync reaches back 30 days, so on a longer window the older campaign-days
  // carry no figure. Say how much of the period the number covers, rather than
  // present part of it as the whole.
  const callClicksNote =
    googleConnected &&
    google._count.callClicks > 0 &&
    google._count.callClicks < google._count._all
      ? `Clicks to call were retrieved for ${google._count.callClicks} of ${google._count._all} ` +
        "campaign-days in this period, so this figure covers only part of it."
      : undefined;

  const messagesGenerated: MetricValue<number> = !metaConnected
    ? unavailable("Meta Ads is not connected.")
    : campaigns._count.messagingStarted === 0
      ? unavailable(NO_CAMPAIGN_REPORTING)
      : ok(num(campaigns._sum.messagingStarted));

  // ── WhatsApp, from the property's own system ───────────────────────────────
  // "Enquiries from ads" was removed from this report at the agency's request.
  // The same figure is on the agency's Integrations page, split by property,
  // under Leads by property.

  // Bookings whose enquiry began at an ad. COUNT(DISTINCT) because one guest can
  // hold several conversations, and an enquiry starting AFTER the booking cannot
  // have caused it.
  let whatsappBookings: MetricValue<number> = unavailable(WHATSAPP_NOT_CONNECTED);
  if (krayaConn) {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(DISTINCT b.id) AS n
      FROM "Booking" b
      JOIN "WhatsAppConversation" c
        ON c."agencyId" = b."agencyId"
       AND c."hotelClientId" = b."hotelClientId"
       AND c."phoneHash" = b."guestPhoneHash"
      WHERE b."agencyId" = ${agencyId}
        AND b."hotelClientId" = ${hotelClientId}
        AND b.provider = 'kraya'
        AND b."bookedAt" >= ${range.since}
        AND b."bookedAt" <= ${range.until}
        AND c."sourceId" IS NOT NULL
        AND c."firstMessageAt" <= b."bookedAt"`;
    whatsappBookings = ok(Number(rows[0]?.n ?? 0));
  }

  // ── Value of those bookings, as the agency entered it ──────────────────────
  //
  // Kraya records that a booking happened, never what it was worth, so this is
  // the one figure on the report a person types. It is counted for two kinds of
  // booking and the difference matters:
  //
  //   TRACED    the conversation carries a real sourceId — the record proves the
  //             ad; and
  //   MARKED    the agency ticked `agencyAdAttributed` — an opinion, needed
  //             because ad tracing only began part-way through, so an earlier
  //             booking carries no ad even where one plainly caused it.
  //
  // Both are in, because the hotel asked for every booking believed to come from
  // an ad. The caption says so rather than passing judgement off as record.
  //
  // `valued` and `countable` are returned separately so a half-filled list
  // cannot masquerade as a complete total: a sum over 3 of 11 bookings is not
  // "the revenue", it is a third of it, and ROAS built on it would understate
  // without a word on the page.
  let whatsappAdRevenue: MetricValue<number> = unavailable(WHATSAPP_NOT_CONNECTED);
  let whatsappRevenueNote: string | undefined;
  if (krayaConn) {
    const rows = await prisma.$queryRaw<
      { total: Prisma.Decimal | null; valued: bigint; countable: bigint }[]
    >`
      SELECT COALESCE(SUM(v."agencyRevenue"), 0) AS total,
             COUNT(v."agencyRevenue")            AS valued,
             COUNT(*)                            AS countable
      FROM (
        SELECT DISTINCT b.id, b."agencyRevenue"
        FROM "Booking" b
        LEFT JOIN "WhatsAppConversation" c
          ON c."agencyId" = b."agencyId"
         AND c."hotelClientId" = b."hotelClientId"
         AND c."phoneHash" = b."guestPhoneHash"
         AND c."sourceId" IS NOT NULL
         AND c."firstMessageAt" <= b."bookedAt"
        WHERE b."agencyId" = ${agencyId}
          AND b."hotelClientId" = ${hotelClientId}
          AND b.provider = 'kraya'
          AND b."bookedAt" >= ${range.since}
          AND b."bookedAt" <= ${range.until}
          AND (c.id IS NOT NULL OR b."agencyAdAttributed" = TRUE)
      ) v`;
    const countable = Number(rows[0]?.countable ?? 0);
    const valued = Number(rows[0]?.valued ?? 0);
    const total = num(rows[0]?.total);

    whatsappAdRevenue =
      countable === 0
        ? // No booking here is claimed to come from an ad at all. A real zero:
          // nothing was counted, so nothing is missing.
          ok(0)
        : valued === 0
          ? notTraceable<number>(WHATSAPP_REVENUE_NOT_ENTERED)
          : ok(total);

    if (countable > 0 && valued < countable) {
      const missing = countable - valued;
      whatsappRevenueNote =
        `${missing} of ${countable} WhatsApp booking${countable === 1 ? "" : "s"} ` +
        `counted as coming from an ad ${missing === 1 ? "has" : "have"} no amount entered yet, ` +
        "so this figure is lower than the true total.";
    }
  }

  // Both revenue lines, never one. `sum` propagates an unknown instead of
  // treating it as zero, so while the WhatsApp side is unentered the ratio reads
  // "not available" rather than a confident 0.00x — which is what it used to
  // show on a property whose business runs on WhatsApp, and which was a
  // measurement gap being presented as a business result.
  const adRevenueAllChannels = sum([totalRevenue, whatsappAdRevenue]);

  const returnOnAdSpend = ratio(adRevenueAllChannels, totalSpend, {
    zeroDenominatorReason:
      "No advertising spend was recorded in this period, so there is nothing to divide by.",
  });

  // ── ROAS per platform ─────────────────────────────────────────────────────
  //
  // EACH PLATFORM GETS ONLY ITS OWN REVENUE, and no rupee is in both. Website
  // bookings go to whichever platform's click brought the guest; every WhatsApp
  // ad booking goes to Meta — the ad sticker is a Meta click-to-WhatsApp ad, and
  // bookings the agency ticked as ad-driven are credited to Meta by the agency's
  // decision. So the two numerators add up to exactly the overall ROAS
  // numerator.
  //
  // The obvious alternative — the same WhatsApp revenue over each platform's
  // spend — was rejected: it credits Google with bookings Meta produced, and a
  // reader adding "3x Meta" and "2x Google" would believe the ads returned 5x.
  //
  // `sum` and `ratio` propagate unknowns, so while the WhatsApp amounts are not
  // entered Meta ROAS reads "not available" rather than a confident low figure.
  const websiteRevenueOf = (v: number): MetricValue<number> =>
    anyTraffic === 0
      ? unavailable(
          "No website activity was recorded in this period, so booking value cannot be reported.",
        )
      : ok(v);
  const noSpendReason = (label: string) =>
    `No ${label} spend was recorded in this period, so there is nothing to divide by.`;

  const metaRoas = ratio(sum([websiteRevenueOf(metaWebRevenue), whatsappAdRevenue]), metaSpend, {
    zeroDenominatorReason: noSpendReason("Meta Ads"),
  });
  const googleRoas = ratio(websiteRevenueOf(googleWebRevenue), googleSpend, {
    zeroDenominatorReason: noSpendReason("Google Ads"),
  });

  const firstAdEnquiry = krayaConn
    ? await scoped(prisma.whatsAppConversation).findFirst({
        where: { hotelClientId, sourceId: { not: null } },
        orderBy: { firstMessageAt: "asc" },
        select: { firstMessageAt: true },
      })
    : null;

  // ── The property's own record ──────────────────────────────────────────────
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

  const client: ClientView = {
    whatsappMessages: trackerSummary.whatsappLeads,
    calls: trackerSummary.totalCallsReceived,
    totalRoomNights: isOk(trackerSummary.roomNightsConfirmed)
      ? trackerSummary.roomNightsConfirmed
      : notTraceable(
          "Room nights are recorded by the property's own reservations team. None have been recorded for this period.",
        ),
    totalRevenue: notTraceable(CLIENT_REVENUE_NOT_RECORDED),
  };

  // ── Coverage ───────────────────────────────────────────────────────────────
  const periodEndsOn = zonedDayString(
    new Date(Math.min(range.until.getTime(), Date.now())),
    range.timezone,
  );
  const coverageNote = (label: string, newest: Date | null): string | undefined => {
    if (newest == null) return undefined;
    const day = zonedDayString(newest, range.timezone);
    return day < periodEndsOn
      ? `${label} has data up to ${day}, so this figure does not cover the whole period.`
      : undefined;
  };

  const metaNote = coverageNote("Meta Ads", metaCoverage._max.date ?? meta._max.date);
  const googleNote = coverageNote("Google Ads", google._max.date);
  const campaignNote = coverageNote("Meta Ads campaign reporting", messagingCoverage._max.date);
  const trackerNote = coverageNote(
    "The property's operations tracker",
    trackerSummary.completeThrough
      ? new Date(`${trackerSummary.completeThrough}T00:00:00.000Z`)
      : null,
  );

  const withheld = unavailable<number>("Ad spend is not shared on this report.");

  const NO_AD_BOOKING_YET =
    "No website booking has been traced to an ad in this period. Tracing needs the " +
    "ad click to reach the booking engine, so this cannot be read as the ads " +
    "producing nothing — bookings taken on WhatsApp or by phone are counted separately.";

  return {
    ads: {
      totalRevenue,
      whatsappAdRevenue,
      returnOnAdSpend: showAdSpend ? returnOnAdSpend : withheld,
      // A platform ROAS reveals that platform's spend to anyone holding the
      // revenue figure, so it is withheld exactly when spend is.
      metaRoas: showAdSpend ? metaRoas : withheld,
      googleRoas: showAdSpend ? googleRoas : withheld,
      googleSpend: showAdSpend ? googleSpend : withheld,
      metaSpend: showAdSpend ? metaSpend : withheld,
      googleCallClicks,
      messagesGenerated,
      whatsappBookings,
    },
    client,
    currency: REPORTING_CURRENCY,
    staleNote: Object.fromEntries(
      Object.entries({
        // Revenue and ROAS both depend on ad spend being complete.
        // A zero that has not been explained is the misleading one.
        totalRevenue: noAdBookingsYet ? NO_AD_BOOKING_YET : undefined,
        whatsappAdRevenue: whatsappRevenueNote,
        // ROAS now spans both revenue lines, so it inherits whichever gap is
        // actually depressing it. A half-filled WhatsApp list understates the
        // ratio just as surely as an untraced website booking, and the reader
        // is owed the reason on the tile that carries the number.
        returnOnAdSpend: showAdSpend
          ? (whatsappRevenueNote ??
            (noAdBookingsYet ? NO_AD_BOOKING_YET : (googleNote ?? metaNote)))
          : undefined,
        googleSpend: showAdSpend ? googleNote : undefined,
        metaRoas: showAdSpend ? (whatsappRevenueNote ?? metaNote) : undefined,
        googleRoas: showAdSpend
          ? googleWebBookings === 0
            ? NO_GOOGLE_AD_BOOKING_YET
            : googleNote
          : undefined,
        metaSpend: showAdSpend ? metaNote : undefined,
        googleCallClicks: callClicksNote ?? googleNote,
        messagesGenerated: campaignNote,
        clientCalls: trackerNote,
        clientWhatsappMessages: trackerNote,
        clientTotalRoomNights: trackerNote,
      }).filter(([, v]) => v != null),
    ) as Record<string, string | undefined>,
    whatsappAttributionSince: firstAdEnquiry?.firstMessageAt ?? null,
  };
}
