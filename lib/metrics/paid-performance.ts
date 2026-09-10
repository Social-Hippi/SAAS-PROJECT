import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import {
  classifyGoogleChannelType,
  classifyMetaObjective,
  type ClassifiedCampaignType,
} from "@/lib/metrics/campaign-type";
import {
  ok,
  notAttributable,
  notApplicable,
  unavailable,
  ratio,
  type MetricValue,
} from "@/lib/metrics/metric-value";

// ─────────────────────────────────────────────────────────────────────────────
// PAID PERFORMANCE — one row per campaign, per platform.
//
// METRIC DEFINITIONS, stated once and computed in exactly one place:
//
//   CTR   clicks ÷ impressions              platform-reported, always real
//   CPC   spend ÷ clicks                    platform-reported, always real
//   CPL   spend ÷ platform conversions      platform-reported
//   ROAS  HOTELTRACK-VERIFIED revenue ÷ spend
//
// The last one is the important one, and it is deliberately NOT the platform's
// own ROAS. Meta reports the conversions its pixel believes it caused; the
// hotel's actual reservations are a different set, and the whole point of this
// product is the gap between them. So ROAS and Bookings come from
// CampaignPerformance — the table the Meta sync builds by joining campaign spend
// to bookings the snippet actually tracked on the hotel's own website.
//
// GOOGLE HAS NO SUCH TABLE. There is no CampaignPerformance equivalent for
// Google Ads in this codebase, so verified bookings and ROAS for a Google
// campaign are honestly "Not attributable" rather than quietly falling back to
// Google's own conversion counts, which measure something else. Clicks,
// impressions, CTR, CPC, CPL and spend are all still real.
//
// CTC is not implemented: it is not defined anywhere in this product, and the
// three cost measures that ARE defined (CPC, CPL, and cost per booking on the
// summary) already cover the question it would have answered.
// ─────────────────────────────────────────────────────────────────────────────

const SPEND_WITHHELD =
  "Your agency has chosen not to share advertising costs on this report.";

export type PaidCampaignRow = {
  campaignId: string;
  campaignName: string;
  type: ClassifiedCampaignType;
  impressions: MetricValue<number>;
  clicks: MetricValue<number>;
  ctr: MetricValue<number>;
  cpc: MetricValue<number>;
  /** Platform-reported conversions — what Meta/Google believe they caused. */
  conversions: MetricValue<number>;
  cpl: MetricValue<number>;
  spend: MetricValue<number>;
  /** Bookings HotelTrack verified against this campaign. */
  bookings: MetricValue<number>;
  roas: MetricValue<number>;
};

export type PaidPerformance = {
  platform: "meta" | "google";
  platformLabel: string;
  connected: boolean;
  rows: PaidCampaignRow[];
  totals: {
    impressions: MetricValue<number>;
    clicks: MetricValue<number>;
    spend: MetricValue<number>;
    conversions: MetricValue<number>;
    bookings: MetricValue<number>;
    ctr: MetricValue<number>;
    roas: MetricValue<number>;
  };
  /** True when verified bookings exist for this platform at all. */
  hasVerifiedBookings: boolean;
};

type Range = { since: Date; until: Date };

function buildRow(args: {
  campaignId: string;
  campaignName: string;
  type: ClassifiedCampaignType;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  verified: { bookings: number; revenue: number } | null;
  showAdSpend: boolean;
}): PaidCampaignRow {
  const {
    campaignId, campaignName, type, impressions, clicks, spend, conversions, verified, showAdSpend,
  } = args;

  const spendM: MetricValue<number> = showAdSpend ? ok(spend) : notApplicable(SPEND_WITHHELD);
  const impressionsM = ok(impressions);
  const clicksM = ok(clicks);
  const conversionsM = ok(conversions);

  // Verified outcomes, or an explicit refusal to guess.
  const bookingsM: MetricValue<number> = verified
    ? ok(verified.bookings)
    : notAttributable(
        "We couldn't connect any reservations on your website back to this campaign.",
      );
  const revenueM: MetricValue<number> = verified
    ? ok(verified.revenue)
    : notAttributable(
        "We couldn't connect any booking revenue back to this campaign.",
      );

  return {
    campaignId,
    campaignName,
    type,
    impressions: impressionsM,
    clicks: clicksM,
    ctr: ratio(clicksM, impressionsM, {
      zeroDenominatorReason: "This campaign recorded no impressions in this period.",
    }),
    cpc: ratio(spendM, clicksM, {
      zeroDenominatorReason: "This campaign recorded no clicks in this period.",
    }),
    conversions: conversionsM,
    cpl: ratio(spendM, conversionsM, {
      zeroDenominatorReason: "This campaign recorded no conversions in this period.",
    }),
    spend: spendM,
    bookings: bookingsM,
    roas: ratio(revenueM, spendM, {
      zeroDenominatorReason: "No spend was recorded for this campaign in this period.",
    }),
  };
}

/** Meta: campaign snapshots joined to HotelTrack's verified CampaignPerformance. */
export async function loadMetaPaidPerformance(
  hotelClientId: string,
  range: Range,
  showAdSpend: boolean,
  /**
   * Restrict to these campaigns — used when the property chip has filtered the
   * view to one property.
   *
   * Filtering at the SOURCE rather than dropping rows afterwards, because the
   * totals below are computed from whatever rows survive. Removing rows from the
   * rendered table while the Total line still counted every campaign would be a
   * worse answer than not filtering at all.
   */
  onlyCampaignIds?: ReadonlySet<string>,
): Promise<PaidPerformance> {
  const [token, snaps, verifiedRows] = await Promise.all([
    agencyScoped(prisma.metaToken).findFirst({
      where: { hotelClientId },
      select: { status: true },
    }),
    agencyScoped(prisma.adCampaignSnapshot).findMany({
      where: {
        hotelClientId,
        archived: false,
        date: { gte: range.since, lte: range.until },
      },
      // ORDER MATTERS: the aggregation below takes the last name it sees as the
      // campaign's current one. Without this that was whichever row Postgres
      // happened to return last, so after a rename the report could show either
      // the old name or the new one, unpredictably — and the property split
      // reads that name.
      orderBy: { date: "asc" },
      select: {
        metaCampaignId: true,
        campaignName: true,
        objective: true,
        spend: true,
        impressions: true,
        clicks: true,
        conversions: true,
      },
    }),
    agencyScoped(prisma.campaignPerformance).findMany({
      where: {
        hotelClientId,
        archived: false,
        date: { gte: range.since, lte: range.until },
      },
      select: { campaignName: true, realBookings: true, realBookingValue: true },
    }),
  ]);

  // Verified outcomes are keyed by campaign NAME — that is the dimension the
  // utm_campaign join uses, and the only key the two tables share.
  const verifiedByName = new Map<string, { bookings: number; revenue: number }>();
  for (const v of verifiedRows) {
    const key = v.campaignName.trim().toLowerCase();
    const cur = verifiedByName.get(key) ?? { bookings: 0, revenue: 0 };
    cur.bookings += v.realBookings;
    cur.revenue += Number(v.realBookingValue);
    verifiedByName.set(key, cur);
  }

  /** Sum the outcomes found under each of a campaign's names; null if none. */
  const mergeVerified = (
    found: ({ bookings: number; revenue: number } | undefined)[],
  ): { bookings: number; revenue: number } | null => {
    const present = found.filter((v): v is { bookings: number; revenue: number } => v != null);
    if (present.length === 0) return null;
    return {
      bookings: present.reduce((t, v) => t + v.bookings, 0),
      revenue: present.reduce((t, v) => t + v.revenue, 0),
    };
  };

  const kept = onlyCampaignIds
    ? snaps.filter((s) => onlyCampaignIds.has(s.metaCampaignId))
    : snaps;

  const agg = new Map<
    string,
    {
      name: string;
      /** EVERY name this campaign had in the window, oldest first. */
      names: string[];
      objective: string | null;
      spend: number;
      impressions: number;
      clicks: number;
      conversions: number;
    }
  >();
  for (const s of kept) {
    const e = agg.get(s.metaCampaignId) ?? {
      name: s.campaignName,
      names: [],
      objective: s.objective,
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
    };
    e.spend += Number(s.spend);
    e.impressions += s.impressions;
    e.clicks += s.clicks;
    e.conversions += s.conversions;
    e.name = s.campaignName; // latest name wins on a rename — see orderBy above
    if (!e.names.includes(s.campaignName)) e.names.push(s.campaignName);
    // Any non-null objective in the window wins: older rows predate the column.
    if (s.objective) e.objective = s.objective;
    agg.set(s.metaCampaignId, e);
  }

  const rows = [...agg.entries()]
    .map(([campaignId, e]) =>
      buildRow({
        campaignId,
        campaignName: e.name,
        type: classifyMetaObjective(e.objective),
        impressions: e.impressions,
        clicks: e.clicks,
        spend: e.spend,
        conversions: e.conversions,
        // Bookings join on campaign NAME (the utm_campaign dimension), so a
        // rename mid-window orphans every booking recorded under the old name
        // and silently shows 0. Try every name the campaign had.
        verified: mergeVerified(e.names.map((n) => verifiedByName.get(n.trim().toLowerCase()))),
        showAdSpend,
      }),
    )
    .sort((a, b) => {
      const as = a.spend.state === "ok" ? a.spend.value : 0;
      const bs = b.spend.state === "ok" ? b.spend.value : 0;
      return bs - as;
    });

  return {
    platform: "meta",
    platformLabel: "Meta Ads",
    // MetaToken.status is an open string vocabulary ("active" | "expired" |
    // "revoked" | "disconnected"), unlike the Google enum above.
    connected: Boolean(token) && token?.status !== "revoked" && token?.status !== "disconnected",
    rows,
    totals: totalsOf(rows, showAdSpend, verifiedByName.size > 0),
    hasVerifiedBookings: verifiedByName.size > 0,
  };
}

/** Google: campaign snapshots. No verified-booking table exists for Google. */
export async function loadGooglePaidPerformance(
  hotelClientId: string,
  range: Range,
  showAdSpend: boolean,
): Promise<PaidPerformance> {
  const [conn, snaps] = await Promise.all([
    agencyScoped(prisma.googleAdsConnection).findFirst({
      where: { hotelClientId },
      select: { status: true },
    }),
    agencyScoped(prisma.googleAdsCampaignSnapshot).findMany({
      where: { hotelClientId, date: { gte: range.since, lte: range.until } },
      orderBy: { date: "asc" }, // latest name wins on a rename; see the Meta note above
      select: {
        campaignId: true,
        campaignName: true,
        advertisingChannelType: true,
        spend: true,
        impressions: true,
        clicks: true,
        conversions: true,
      },
    }),
  ]);

  const agg = new Map<
    string,
    { name: string; channel: string | null; spend: number; impressions: number; clicks: number; conversions: number }
  >();
  for (const s of snaps) {
    const e = agg.get(s.campaignId) ?? {
      name: s.campaignName,
      channel: s.advertisingChannelType,
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
    };
    e.spend += Number(s.spend);
    e.impressions += s.impressions;
    e.clicks += s.clicks;
    e.conversions += s.conversions;
    e.name = s.campaignName;
    if (s.advertisingChannelType) e.channel = s.advertisingChannelType;
    agg.set(s.campaignId, e);
  }

  const rows = [...agg.entries()]
    .map(([campaignId, e]) =>
      buildRow({
        campaignId,
        campaignName: e.name,
        type: classifyGoogleChannelType(e.channel),
        impressions: e.impressions,
        clicks: e.clicks,
        spend: e.spend,
        conversions: e.conversions,
        // No verified join exists for Google — see the header note.
        verified: null,
        showAdSpend,
      }),
    )
    .sort((a, b) => {
      const as = a.spend.state === "ok" ? a.spend.value : 0;
      const bs = b.spend.state === "ok" ? b.spend.value : 0;
      return bs - as;
    });

  return {
    platform: "google",
    platformLabel: "Google Ads",
    // GoogleAdsStatus is an enum: ACTIVE | TOKEN_EXPIRED | ERROR | REVOKED.
    // A token that merely expired still has real historical data behind it, so
    // only an explicit revocation counts as disconnected here.
    connected: Boolean(conn) && conn?.status !== "REVOKED",
    rows,
    totals: totalsOf(rows, showAdSpend, false),
    hasVerifiedBookings: false,
  };
}

function totalsOf(
  rows: PaidCampaignRow[],
  showAdSpend: boolean,
  hasVerified: boolean,
): PaidPerformance["totals"] {
  let impressions = 0;
  let clicks = 0;
  let spend = 0;
  let conversions = 0;
  let bookings = 0;
  let revenue = 0;

  for (const r of rows) {
    if (r.impressions.state === "ok") impressions += r.impressions.value;
    if (r.clicks.state === "ok") clicks += r.clicks.value;
    if (r.spend.state === "ok") spend += r.spend.value;
    if (r.conversions.state === "ok") conversions += r.conversions.value;
    if (r.bookings.state === "ok") bookings += r.bookings.value;
    // Revenue is recovered from the row's own ROAS inputs rather than re-queried.
    if (r.roas.state === "ok" && r.spend.state === "ok") revenue += r.roas.value * r.spend.value;
  }

  const spendM: MetricValue<number> = showAdSpend ? ok(spend) : notApplicable(SPEND_WITHHELD);
  const impressionsM = ok(impressions);
  const clicksM = ok(clicks);

  return {
    impressions: impressionsM,
    clicks: clicksM,
    spend: spendM,
    conversions: ok(conversions),
    bookings: hasVerified
      ? ok(bookings)
      : notAttributable(
          "None of these campaigns could be connected to reservations on your website.",
        ),
    ctr: ratio(clicksM, impressionsM, {
      zeroDenominatorReason: "No impressions were recorded in this period.",
    }),
    roas: hasVerified
      ? ratio(ok(revenue), spendM, {
          zeroDenominatorReason: "No spend was recorded in this period.",
        })
      : notAttributable(
          "We couldn't connect booking revenue to these campaigns, so a return figure would be a guess.",
        ),
  };
}

/** Both platforms unavailable — used when an integration is disconnected. */
export function disconnectedPaidPerformance(
  platform: "meta" | "google",
): PaidPerformance {
  const label = platform === "meta" ? "Meta Ads" : "Google Ads";
  const gone = unavailable<number>(`${label} isn't connected for this hotel yet.`);
  return {
    platform,
    platformLabel: label,
    connected: false,
    rows: [],
    totals: {
      impressions: gone,
      clicks: gone,
      spend: gone,
      conversions: gone,
      bookings: gone,
      ctr: gone,
      roas: gone,
    },
    hasVerifiedBookings: false,
  };
}
