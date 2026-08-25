import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant-scope";
import { getSpendByPlatformFor } from "@/lib/ad-spend";
import {
  computeAdsSummary,
  computeContentPerformance,
  computeInfluencerImpact,
  computeKpis,
  trueRoi,
  type AdSnapshotInput,
  type AdsSummary,
  type ContentInput,
  type ContentPerf,
  type EventInput,
  type InfluencerRow,
  type Kpis,
  type RedemptionInput,
} from "@/lib/attribution";

// Loads + computes the full attribution picture for one hotel over a date range.
// Shared by the agency dashboard logic and the public /share view so both show
// identical numbers. Always scoped by BOTH agencyId and hotelClientId, so it can
// never read another tenant's data even when called from the public, unauthed
// share page (the caller resolves agencyId from the share token, not the URL).

export type HotelReport = {
  kpis: Kpis;
  contentPerf: ContentPerf[];
  ads: AdsSummary;
  influencerRows: InfluencerRow[];
  /** Real ad-driven revenue ÷ spend (HotelTrack's "true ROI"). */
  realRoi: number | null;
  /** OTA commission saved by direct bookings this period (Part 7). */
  otaSavings: { rate: number; bookingRevenue: number; amount: number };
  /**
   * Whether ad spend (and every spend-derived figure: cost/booking, ROAS, Meta
   * ROAS, True ROI, the daily spend chart) may be shown. True for the agency and
   * PDF callers; on the public /share link it follows the hotel's
   * showAdSpendToHotel flag. When false, those figures are stripped BEFORE the
   * report leaves the server, so they never reach the browser.
   */
  showAdSpend: boolean;
};

export async function loadHotelReport(args: {
  agencyId: string;
  hotelId: string;
  since: Date;
  until: Date;
  /**
   * When true, honour the hotel's showAdSpendToHotel flag and hide spend if it's
   * off. The public /share view passes true; the agency dashboard and PDF export
   * omit it (default false) so they always see spend.
   */
  respectAdSpendFlag?: boolean;
}): Promise<HotelReport> {
  const { agencyId, hotelId, since, until, respectAdSpendFlag = false } = args;

  // agencyScopedFor injects { agencyId } into every where below. This function
  // is also called from the public /share page (which resolves agencyId from the
  // share token, NOT a session), so it takes agencyId as a param rather than
  // reading the Clerk context.
  const [content, events, snapshots, hotelMeta] = await Promise.all([
    agencyScopedFor(agencyId, prisma.contentPiece).findMany({
      where: { hotelClientId: hotelId },
      select: {
        id: true,
        title: true,
        contentType: true,
        platform: true,
        couponCode: true,
        influencerName: true,
      },
    }),
    agencyScopedFor(agencyId, prisma.trackingEvent).findMany({
      where: { hotelClientId: hotelId, createdAt: { gte: since, lte: until } },
      select: {
        eventType: true,
        // Phase 0: source/medium are needed to classify paid vs non-paid revenue.
        utmSource: true,
        utmMedium: true,
        utmContent: true,
        utmCampaign: true,
        gclid: true, gbraid: true, wbraid: true, fbclid: true,
        sessionId: true,
        conversionValue: true,
      },
    }),
    agencyScopedFor(agencyId, prisma.adSnapshot).findMany({
      where: { hotelClientId: hotelId, archived: false, date: { gte: since, lte: until } },
      orderBy: { date: "asc" },
      select: { date: true, spend: true, conversions: true, roas: true },
    }),
    agencyScopedFor(agencyId, prisma.hotelClient).findFirst({
      where: { id: hotelId },
      select: { otaCommissionRate: true, showAdSpendToHotel: true },
    }),
  ]);

  const contentIds = content.map((c) => c.id);
  const redemptions =
    contentIds.length > 0
      ? await agencyScopedFor(agencyId, prisma.couponRedemption).findMany({
          where: {
            contentPieceId: { in: contentIds },
            redemptionDate: { gte: since, lte: until },
          },
          select: { contentPieceId: true, orderValue: true },
        })
      : [];

  // Normalise Prisma Decimals -> plain numbers for the pure helpers.
  const contentInputs: ContentInput[] = content;
  const eventInputs: EventInput[] = events.map((e) => ({
    eventType: e.eventType,
    utmSource: e.utmSource,
    utmMedium: e.utmMedium,
    utmContent: e.utmContent,
    utmCampaign: e.utmCampaign,
    sessionId: e.sessionId,
    conversionValue: e.conversionValue == null ? null : Number(e.conversionValue),
    gclid: e.gclid, gbraid: e.gbraid, wbraid: e.wbraid, fbclid: e.fbclid,
  }));
  const snapshotInputs: AdSnapshotInput[] = snapshots.map((s) => ({
    date: s.date,
    spend: Number(s.spend),
    conversions: s.conversions,
    roas: s.roas,
  }));
  const redemptionInputs: RedemptionInput[] = redemptions.map((r) => ({
    contentPieceId: r.contentPieceId,
    orderValue: Number(r.orderValue),
  }));

  const ads = computeAdsSummary(snapshotInputs);
  // Phase 0: KPIs divide by CANONICAL paid spend (Meta + Google), not the Meta
  // AdSnapshot total that `ads.spend` represents. `ads` stays Meta-only — it is
  // the Meta-reported block (metaRoas, the spend chart) and must not change.
  const paidSpend = await getSpendByPlatformFor(agencyId, hotelId, since, until);
  const kpis = computeKpis(eventInputs, paidSpend);
  const contentPerf = computeContentPerformance(contentInputs, eventInputs);
  const influencerRows = computeInfluencerImpact(contentInputs, redemptionInputs);

  const realAdRevenue = contentPerf
    .filter((c) => c.contentType === "paid_ad")
    .reduce((sum, c) => sum + c.revenue, 0);
  const realRoi = trueRoi(realAdRevenue, ads.spend);

  // OTA commission saved by direct (snippet-tracked) bookings this period.
  const otaRate = hotelMeta?.otaCommissionRate == null ? 18 : Number(hotelMeta.otaCommissionRate);
  const bookingRevenue = eventInputs
    .filter((e) => e.eventType === "conversion")
    .reduce((sum, e) => sum + (e.conversionValue ?? 0), 0);
  const otaSavings = {
    rate: otaRate,
    bookingRevenue,
    amount: otaRate > 0 ? bookingRevenue * (otaRate / 100) : 0,
  };

  // Spend visibility. Agency + PDF callers always see spend (respectAdSpendFlag
  // false). The public /share link passes true, so spend is shown only when the
  // hotel's showAdSpendToHotel flag is on. When hidden, strip every spend and
  // spend-derived figure HERE — on the server — so nothing leaks to the browser.
  const showAdSpend = respectAdSpendFlag ? Boolean(hotelMeta?.showAdSpendToHotel) : true;
  if (!showAdSpend) {
    kpis.spend = 0;
    kpis.spendByPlatform = { meta: 0, google: 0, total: 0 };
    kpis.costPerBooking = null;
    kpis.roas = null;
    // blendedRoas is spend-DERIVED (all revenue ÷ paid spend) — it leaks the
    // spend figure by division if left in. Strip it with the rest.
    kpis.blendedRoas = null;
    ads.spend = 0;
    ads.metaReportedRevenue = 0;
    ads.metaRoas = null;
    ads.spendOverTime = [];
  }

  return {
    kpis,
    contentPerf,
    ads,
    influencerRows,
    realRoi: showAdSpend ? realRoi : null,
    otaSavings,
    showAdSpend,
  };
}
