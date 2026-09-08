import type { OwnerMetrics } from "@/lib/owner-metrics";
import type { ChannelView } from "@/lib/channel-view-types";

// ─────────────────────────────────────────────────────────────────────────────
// Spend stripping for the /share/<uuid> read routes.
//
// The report renders in two halves: a server-rendered half (which gates spend
// inline, from the same flag) and a client-fetched half that calls
// /api/hotel/[id]/*. Without these transforms the second half would hand the
// browser everything the first half carefully withheld — and "hidden" in the UI
// while present in a JSON response the reader can just open DevTools to see is
// not hidden at all.
//
// So the strip happens server-side, in the route, BEFORE the payload is
// serialized. Two rules shape what goes:
//
//   1. Remove spend, and remove anything that spend can be DIVIDED OUT OF.
//      cost/booking, CPC, CPM, cost-per-conversion and every ROAS are all
//      `spend ÷ known` or `known ÷ spend`, so leaving one in leaks the figure
//      the toggle exists to hide.
//   2. Keep outcomes. Bookings, revenue, sessions, impressions, clicks, reach
//      and CTR are what the hotel is being shown in the first place, and none of
//      them is derived from spend. CTR is clicks ÷ impressions — it stays.
//
// Both functions are pure and total: they take the loaded payload and return a
// new one, so a route can wrap its result in a single expression and a test can
// assert over the output without a database.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OwnerMetrics with every spend and spend-derived figure removed.
 *
 * `marketingSpend` is zeroed rather than dropped so the payload keeps its shape
 * (PerformanceOverview reads `.total` and renders "—" for a null); `paidConnected`
 * is left alone, because whether an ad account is connected is not a spend
 * figure, and clearing it would make the card claim the hotel runs no ads.
 */
export function stripSpendFromOwnerMetrics(m: OwnerMetrics): OwnerMetrics {
  return {
    ...m,
    marketingSpend: {
      total: null,
      meta: 0,
      google: 0,
      mixedCurrency: false,
      currency: m.marketingSpend.currency,
    },
    costPerBooking: {
      // Bookings counts survive — they are outcomes. Only the division goes.
      ...m.costPerBooking,
      costPerBooking: null,
      totalSpend: null,
    },
    roas: {
      ...m.roas,
      // Every ratio here has spend in its denominator.
      overall: null,
      meta: null,
      google: null,
      blended: null,
      mixedCurrency: false,
      // paidRevenue / nonPaidRevenue / totalRevenue / metaRevenue / googleRevenue
      // are revenue, not spend, and are deliberately kept.
    },
    topCampaigns: {
      campaigns: m.topCampaigns.campaigns.map((c) => ({
        ...c,
        spend: null,
        roas: null,
        costPerBooking: null,
      })),
    },
  };
}

/**
 * A channel deep-dive with spend removed. Only the paid-ads channel carries any
 * — Instagram, Facebook, influencer, direct and other are outcome-only — so
 * every other branch is returned untouched rather than pointlessly rebuilt.
 */
export function stripSpendFromChannelView(view: ChannelView): ChannelView {
  if (view.channelType !== "paid_ads") return view;

  return {
    ...view,
    kpis: view.kpis && {
      ...view.kpis,
      totalSpend: 0,
      // spend ÷ clicks, spend ÷ impressions, spend ÷ conversions.
      cpc: 0,
      cpm: 0,
      costPerConversion: null,
      costPerBooking: null,
      roas: null,
      platformReportedRoas: null,
      trackedRoas: null,
      // impressions, reach, frequency, ctr, linkClicks, conversions, bookings,
      // revenue, conversionRate and the platform/tracked COUNTS all stay.
    },
    // Per-account rows exist only to break spend down by ad account; with the
    // spend gone the row is an account id and nothing else worth showing.
    accounts: [],
    topCampaigns: view.topCampaigns?.map((c) => ({ ...c, spend: 0, roas: null })),
    trend: view.trend?.map((t) => ({ ...t, spend: 0 })),
  };
}
