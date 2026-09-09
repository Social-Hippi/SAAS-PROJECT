import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { aggregateRevenueBySource, type ConversionRow } from "@/lib/revenue-by-source";
import { calculateSavings, DEFAULT_OTA_RATE } from "@/lib/savings";
import { canonicalSourceType, paidRevenueOf } from "@/lib/metrics/canonical";
import { getSpendByPlatform, safeRoas } from "@/lib/ad-spend";
import { formatCurrency, formatNumber } from "@/lib/format";
import { templateFor, renderTemplate, type Pattern, type Period } from "@/lib/summary-templates";

// Owner Summary (Part 2) — a 3–4 line plain-English read of a hotel's recent
// performance, computed from existing TrackingEvent / InfluencerRedemption /
// AdSnapshot data. Read-only + multi-tenant (agency-scoped). Honest tone driven
// by the `pattern` (no-data / strong / slight-decline / significant-decline).

export type { Period, Pattern };

export const PERIOD_LABEL: Record<Period, string> = {
  "1d": "yesterday",
  "7d": "last 7 days",
  "30d": "last 30 days",
};

export type SummaryMetrics = {
  revenue: number;
  bookings: number;
  avgBookingValue: number;
  revenueChangePct: number | null;
  bookingsChangePct: number | null;
  avgValueChangePct: number | null;
  topSource: { name: string; revenue: number; bookings: number } | null;
  topInfluencer: { name: string; revenue: number; bookings: number } | null;
  adSpend: number;
  roas: number | null;
  savings: number;
};

export type SummaryResult = {
  hotelId: string;
  period: Period;
  periodLabel: string;
  summary: string;
  // 4–5 channel highlight bullets (Meta / Google / Instagram reach / overall …).
  highlights: string[];
  metrics: SummaryMetrics;
  pattern: Pattern;
  generatedAt: string;
};

const IST_MS = 5.5 * 3600 * 1000; // India is the audience → IST date boundaries.
const PERIOD_DAYS: Record<Period, number> = { "1d": 1, "7d": 7, "30d": 30 };

const SOURCE_LABEL: Record<string, string> = {
  instagram: "Instagram", facebook: "Facebook", google: "Google", youtube: "YouTube",
  whatsapp: "WhatsApp", email: "Email", direct: "Direct", influencer: "Influencer", newsletter: "Newsletter",
};
function sourceLabel(key: string): string {
  return SOURCE_LABEL[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** Midnight IST of (today − daysAgo), as a UTC instant. */
function istMidnight(daysAgo: number): Date {
  const ist = new Date(Date.now() + IST_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - daysAgo) - IST_MS);
}

/**
 * The period windows. Periods count only COMPLETED days (ending at the end of
 * yesterday IST), with the same-length immediately-preceding period.
 */
export function periodWindows(period: Period): { start: Date; end: Date; prevStart: Date; prevEnd: Date } {
  const n = PERIOD_DAYS[period];
  const todayStart = istMidnight(0); // start of today IST
  return {
    start: istMidnight(n), // n complete days ago … yesterday
    end: new Date(todayStart.getTime() - 1),
    prevStart: istMidnight(2 * n),
    prevEnd: new Date(istMidnight(n).getTime() - 1),
  };
}

function pct(cur: number, prev: number): number | null {
  if (prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}
function fmt(n: number): string {
  return formatCurrency(n, { compact: true });
}

/**
 * Generate a summary for a hotel + period. Returns null when the hotel is not the
 * caller's agency's (so the route can 404 without leaking existence).
 */
/**
 * @param opts.audience   Who is reading. "agency" keeps the connect-an-account
 *   calls to action; "hotel" (the logged-in hotel dashboard AND the public
 *   /share report) replaces them, because neither of those readers can connect
 *   an ad account and telling them to is a dead end.
 * @param opts.hideSpend  Strip ad spend and ROAS from BOTH the structured metrics
 *   and the prose. Set for a /share/<uuid> viewer whose hotel has
 *   showAdSpendToHotel off. It has to happen in here rather than on the way out:
 *   the summary and the channel highlights are rendered STRINGS, so a caller
 *   zeroing `metrics.adSpend` afterwards would leave "spent \u20b972,000 at 3.1x
 *   ROAS" sitting in the text it already generated.
 */
export async function generateSummary(
  hotelClientId: string,
  period: Period,
  opts: { hideSpend?: boolean; audience?: "agency" | "hotel" } = {},
): Promise<SummaryResult | null> {
  const hideSpend = opts.hideSpend ?? false;
  const forAgency = (opts.audience ?? "agency") === "agency";
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelClientId },
    select: { otaCommissionRate: true },
  });
  if (!hotel) return null;
  const otaRate = hotel.otaCommissionRate == null ? DEFAULT_OTA_RATE : Number(hotel.otaCommissionRate);

  const { start, end, prevStart, prevEnd } = periodWindows(period);

  const [events, visitsCur, visitsPrev, paidSpend, infGroups, socialSnaps, googleAdsConnections] = await Promise.all([
    agencyScoped(prisma.trackingEvent).findMany({
      where: { hotelClientId, eventType: "conversion", createdAt: { gte: prevStart, lte: end } },
      select: { utmSource: true, utmMedium: true, utmCampaign: true, utmContent: true, conversionValue: true, couponCodeUsed: true, createdAt: true, gclid: true, gbraid: true, wbraid: true, fbclid: true, },
    }),
    agencyScoped(prisma.trackingEvent).count({ where: { hotelClientId, eventType: "visit", createdAt: { gte: start, lte: end } } }),
    agencyScoped(prisma.trackingEvent).count({ where: { hotelClientId, eventType: "visit", createdAt: { gte: prevStart, lte: prevEnd } } }),
    // Phase 0: canonical paid spend (Meta + Google) instead of a Meta-only
    // AdSnapshot sum — the narrative's "₹x back per ₹1 spent" divided by it.
    getSpendByPlatform(hotelClientId, start, end),
    agencyScoped(prisma.influencerRedemption).groupBy({
      by: ["influencerId"],
      where: { hotelClientId, redeemedAt: { gte: start, lte: end } },
      _sum: { bookingValue: true },
      _count: { _all: true },
    }),
    agencyScoped(prisma.socialSnapshot).findMany({
      where: { hotelClientId, date: { gte: start, lte: end } },
      orderBy: { date: "asc" },
      select: { reach: true, views: true, followers: true },
    }),
    // Phase 0: is Google Ads actually connected? The highlight bullet below used
    // to say "coming soon" unconditionally, while Google Ads was syncing daily.
    agencyScoped(prisma.googleAdsConnection).count({
      where: { hotelClientId, customerId: { not: "" } },
    }),
  ]);

  const toRow = (e: (typeof events)[number]): ConversionRow => ({
    utmSource: e.utmSource, utmMedium: e.utmMedium, utmCampaign: e.utmCampaign, utmContent: e.utmContent,
    value: e.conversionValue == null ? 0 : Number(e.conversionValue), occurredAt: e.createdAt, couponCode: e.couponCodeUsed,
    gclid: e.gclid, gbraid: e.gbraid, wbraid: e.wbraid, fbclid: e.fbclid,
  });
  const curRows = events.filter((e) => e.createdAt >= start && e.createdAt <= end).map(toRow);
  const prevRows = events.filter((e) => e.createdAt >= prevStart && e.createdAt <= prevEnd).map(toRow);

  const revenue = curRows.reduce((s, r) => s + r.value, 0);
  const bookings = curRows.length;
  const avgBookingValue = bookings > 0 ? revenue / bookings : 0;
  const prevRevenue = prevRows.reduce((s, r) => s + r.value, 0);
  const prevBookings = prevRows.length;
  const prevAvg = prevBookings > 0 ? prevRevenue / prevBookings : 0;
  const hasPrevious = prevBookings > 0;

  const revenueChangePct = pct(revenue, prevRevenue);
  const bookingsChangePct = pct(bookings, prevBookings);
  const avgValueChangePct = prevAvg > 0 ? pct(avgBookingValue, prevAvg) : null;

  // Top source via the shared aggregation (coupon-aware).
  const agg = aggregateRevenueBySource(curRows, "source", { start, end });
  const top = agg.groups[0];
  const topSource = top ? { name: sourceLabel(top.key), revenue: top.revenue, bookings: top.bookings } : null;

  // Top influencer — only if meaningful (>5% of revenue or >₹10K).
  let topInfluencer: SummaryMetrics["topInfluencer"] = null;
  if (infGroups.length > 0) {
    const sorted = [...infGroups].sort((a, b) => Number(b._sum.bookingValue ?? 0) - Number(a._sum.bookingValue ?? 0));
    const best = sorted[0];
    const infRev = Number(best._sum.bookingValue ?? 0);
    if (infRev > 0 && (infRev >= 10000 || (revenue > 0 && infRev / revenue > 0.05))) {
      const inf = await agencyScoped(prisma.influencer).findFirst({ where: { id: best.influencerId }, select: { name: true } });
      topInfluencer = { name: inf?.name ?? "An influencer", revenue: infRev, bookings: best._count._all };
    }
  }

  // Phase 0: ROAS is PAID revenue ÷ PAID spend. It used to be ALL booking
  // revenue (direct, organic, influencer…) ÷ Meta-only spend, narrated to hotel
  // owners as "₹x back for every ₹1 spent" — the most misleading form of the bug.
  // Both are zeroed/nulled BEFORE renderSummary runs, so the `adSpend` template
  // flag goes false and the prose never mentions spend or ROAS at all.
  const adSpend = hideSpend ? 0 : (paidSpend.total ?? 0);
  const paidRevenue = paidRevenueOf(curRows);
  const roas = hideSpend ? null : safeRoas(paidRevenue, paidSpend.total);
  const savings = calculateSavings(revenue, otaRate);
  const visitsChangePct = pct(visitsCur, visitsPrev);

  const metrics: SummaryMetrics = {
    revenue, bookings, avgBookingValue, revenueChangePct, bookingsChangePct, avgValueChangePct,
    topSource, topInfluencer, adSpend, roas, savings,
  };

  // ── Pattern ──
  let pattern: Pattern;
  if (bookings === 0) pattern = "no_data";
  else if (!hasPrevious || revenueChangePct == null) pattern = "strong"; // first period — positive, no comparison
  else if (revenueChangePct > 0) pattern = "strong";
  else if (revenueChangePct > -20) pattern = "flat_or_slight_decline";
  else pattern = "significant_decline";

  const summary = renderSummary(pattern, period, metrics, {
    hasPrevious, prevRevenue, avgValueChangePct, visitsChangePct,
  });

  // ── Channel highlight bullets (Meta / Google / Instagram reach + overall) ──
  // Per-channel booking revenue uses the same R1 classifier as the rest of the app.
  const channelRev = (channel: string) => {
    // Pass the WHOLE row. Hand-picking three fields dropped the click ids the
    // query already selects, so an auto-tagged Google booking was counted as
    // `direct` here while paidRevenue (which classifies the full row) counted it
    // as google_ads — this file contradicted itself.
    const rows = curRows.filter((r) => canonicalSourceType(r) === channel);
    return { revenue: rows.reduce((s, r) => s + r.value, 0), bookings: rows.length };
  };
  const meta = channelRev("meta_ads");
  const igOrganic = channelRev("instagram_organic");
  const igReach = socialSnaps.reduce((s, x) => s + (x.reach || x.views), 0);
  const igFollowers = socialSnaps.length > 0 ? socialSnaps[socialSnaps.length - 1].followers : 0;
  const plural = (n: number) => (n === 1 ? "" : "s");

  const highlights: string[] = [];
  // 1 — Meta Ads. Phase 0: this said "Meta Ads: spent <X> at <Y>x ROAS" using
  // the COMBINED spend and the blended ROAS. Both are now Meta-specific.
  const metaRoas = safeRoas(meta.revenue, paidSpend.meta);
  highlights.push(
    paidSpend.meta > 0
      ? hideSpend
        // Outcome only: the bookings and revenue Meta drove are still the point,
        // and neither one lets the reader back out the spend.
        ? `Meta Ads: drove ${meta.bookings} booking${plural(meta.bookings)} (${fmt(meta.revenue)}).`
        : `Meta Ads: spent ${fmt(paidSpend.meta)}${metaRoas != null ? ` at ${metaRoas.toFixed(1)}x ROAS` : ""}, driving ${meta.bookings} booking${plural(meta.bookings)} (${fmt(meta.revenue)}).`
      : forAgency
        ? `Meta Ads: not connected — connect a Meta ad account to track spend and ROAS.`
        : `Meta Ads: no ad account is connected for this hotel yet.`,
  );
  // 2 — Google Ads. Phase 0: this was a hardcoded "coming soon" string that
  // shipped alongside a working Google Ads integration. Now it reflects reality.
  const google = channelRev("google_ads");
  highlights.push(
    googleAdsConnections > 0
      ? paidSpend.google > 0
        ? hideSpend
          ? `Google Ads: drove ${google.bookings} booking${plural(google.bookings)} (${fmt(google.revenue)}).`
          : `Google Ads: spent ${fmt(paidSpend.google)}, driving ${google.bookings} booking${plural(google.bookings)} (${fmt(google.revenue)}).`
        : hideSpend
          // "no spend recorded" is itself a statement about spend.
          ? `Google Ads: connected, but no activity in this period.`
          : `Google Ads: connected, but no spend recorded in this period.`
      : forAgency
        ? `Google Ads: not connected — connect a Google Ads account to track spend and ROAS.`
        : `Google Ads: no ad account is connected for this hotel yet.`,
  );
  // 3 — Instagram reach
  highlights.push(
    igReach > 0 || igFollowers > 0
      ? `Instagram reach: ${formatNumber(igReach)} account${plural(igReach)} reached${igFollowers > 0 ? `, ${formatNumber(igFollowers)} followers` : ""}${igOrganic.bookings > 0 ? ` · ${igOrganic.bookings} organic booking${plural(igOrganic.bookings)}` : ""}.`
      : `Instagram: no organic reach data for this period.`,
  );
  // 4 — Overall bookings/revenue
  highlights.push(
    bookings > 0
      ? `Overall: ${bookings} booking${plural(bookings)} worth ${fmt(revenue)}${revenueChangePct != null ? ` (${revenueChangePct >= 0 ? "+" : ""}${Math.round(revenueChangePct)}% vs previous)` : ""}.`
      : `Overall: no bookings tracked in this period yet.`,
  );
  // 5 — Top source (only when meaningful)
  if (topSource && topSource.revenue > 0) {
    highlights.push(`Top source: ${topSource.name} — ${fmt(topSource.revenue)} from ${topSource.bookings} booking${plural(topSource.bookings)}.`);
  }

  return {
    hotelId: hotelClientId,
    period,
    periodLabel: PERIOD_LABEL[period],
    summary,
    highlights,
    metrics,
    pattern,
    generatedAt: new Date().toISOString(),
  };
}

function renderSummary(
  pattern: Pattern,
  period: Period,
  m: SummaryMetrics,
  extra: { hasPrevious: boolean; prevRevenue: number; avgValueChangePct: number | null; visitsChangePct: number | null },
): string {
  const avgUp = (extra.avgValueChangePct ?? 0) > 0;
  const avgShown = extra.avgValueChangePct != null && Math.abs(extra.avgValueChangePct) >= 1;
  const values: Record<string, string | number> = {
    revenue: fmt(m.revenue),
    bookings: m.bookings,
    avgBookingValue: fmt(m.avgBookingValue),
    revenueChangePct: m.revenueChangePct == null ? "" : Math.round(Math.abs(m.revenueChangePct)),
    previousRevenue: fmt(extra.prevRevenue),
    topSource: m.topSource?.name ?? "Direct",
    topSourceRevenue: fmt(m.topSource?.revenue ?? 0),
    topSourceBookings: m.topSource?.bookings ?? 0,
    roas: m.roas == null ? "" : `${m.roas.toFixed(1)}x`,
    savings: fmt(m.savings),
    avgValueChangeDirection: avgUp ? "up" : "down",
    avgValueChangePctAbs: extra.avgValueChangePct == null ? "" : Math.round(Math.abs(extra.avgValueChangePct)),
    moreOrLess: avgUp ? "more" : "less",
    influencerName: m.topInfluencer?.name ?? "",
    influencerRevenue: fmt(m.topInfluencer?.revenue ?? 0),
  };
  const flags: Record<string, boolean> = {
    comparison: extra.hasPrevious && m.revenueChangePct != null,
    adSpend: m.adSpend > 0 && m.roas != null,
    savings: m.savings > 0,
    influencerActive: m.topInfluencer != null,
    zero: m.bookings === 0,
    trafficSteady: extra.visitsChangePct != null && extra.visitsChangePct > -15,
    topSourceStillStrong: !!m.topSource && m.topSource.revenue > 0,
    avgValueShown: avgShown,
  };
  return renderTemplate(templateFor(pattern, period), { values, flags });
}
