import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant-scope";
import {
  computeAdsSummary,
  computeKpis,
  normSource,
  type AdSnapshotInput,
  type EventInput,
} from "@/lib/attribution";
import { DEFAULT_OTA_RATE, calculateSavings } from "@/lib/savings";
import { getSpendByPlatformFor } from "@/lib/ad-spend";

// Loads everything the PUBLIC, read-only hotel dashboard (/h/<shareToken>) shows,
// computed server-side into a plain, serialisable shape. ALWAYS scoped by BOTH
// agencyId and hotelClientId — the caller resolves agencyId from the share token,
// never from the URL — so this can never read another tenant's data, and a hotel
// only ever sees its own numbers.
//
// Ad-spend figures (spend, True ROAS, per-channel spend) are computed only when
// `showAdSpend` is true; otherwise they're returned null and the view renders
// them as "—" / hides the card. The gating happens HERE, at the data layer, not
// just in the UI, so spend never even reaches the client when it's hidden.

export type HotelChannelRow = {
  source: string;
  label: string;
  visitorsBrought: number;
  bookings: number;
  revenue: number;
  conversionRate: number;
  /** null when ad spend is hidden from the hotel or unknown for this source. */
  spend: number | null;
  trueRoas: number | null;
};

export type HotelPublicDashboard = {
  kpis: {
    revenue: number;
    bookings: number;
    adr: number | null;
    topChannel: { label: string; pct: number } | null;
    followers: number;
    engagementRate: number | null;
    /** Only populated when showAdSpend is true. */
    adSpend: number | null;
    trueRoas: number | null;
  };
  channels: HotelChannelRow[];
  instagram: {
    connected: boolean;
    handle: string | null;
    followers: number;
    followerGrowth: number;
    engagementRate: number | null;
    followerSeries: { date: string; followers: number }[];
    topPosts: {
      mediaId: string;
      caption: string | null;
      mediaType: string | null;
      permalink: string | null;
      postedAt: string | null;
      reach: number;
      likes: number;
      comments: number;
      engagement: number;
    }[];
  };
  traffic: {
    /** Where the traffic numbers came from — GA when connected, else the snippet. */
    source: "ga" | "snippet" | "none";
    dailyVisitors: { date: string; visitors: number }[];
    sources: { source: string; sessions: number }[];
    totalSessions: number;
    conversionRate: number | null;
  };
  /** OTA commission saved by direct (snippet-tracked) bookings this period. */
  otaSavings: {
    rate: number;
    bookingRevenue: number;
    amount: number;
  };
};

const SOURCE_LABELS: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  google_organic: "Google · organic",
  google_paid: "Google · paid",
  direct: "Direct",
  email: "Email",
  referral: "Referral",
  youtube: "YouTube",
  other: "Other",
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function loadHotelPublicDashboard(args: {
  agencyId: string;
  hotelId: string;
  since: Date;
  until: Date;
  showAdSpend: boolean;
  /** Pixel-only tracking: no snippet events to attribute (see lib/tracking-mode). */
  pixelMode: boolean;
}): Promise<HotelPublicDashboard> {
  const { agencyId, hotelId, since, until, showAdSpend, pixelMode } = args;
  const scoped = <D>(model: D) => agencyScopedFor(agencyId, model);

  // ── Snippet conversions + visit-source counts (empty in pixel mode) ──────────
  const [conversions, visitGroups, snapshots, hotelMeta] = await Promise.all([
    pixelMode
      ? Promise.resolve(
          [] as {
            utmSource: string | null;
            utmMedium: string | null;
            sessionId: string;
            conversionValue: import("@prisma/client").Prisma.Decimal | null;
            gclid: string | null; gbraid: string | null; wbraid: string | null; fbclid: string | null;
          }[],
        )
      : scoped(prisma.trackingEvent).findMany({
          where: {
            hotelClientId: hotelId,
            eventType: "conversion",
            createdAt: { gte: since, lte: until },
          },
          // utmMedium is needed (with utmSource) to classify paid vs non-paid.
          select: { utmSource: true, utmMedium: true, sessionId: true, conversionValue: true, gclid: true, gbraid: true, wbraid: true, fbclid: true, },
        }),
    pixelMode
      ? Promise.resolve([] as { utmSource: string | null; sessionId: string }[])
      : scoped(prisma.trackingEvent).groupBy({
          by: ["utmSource", "sessionId"],
          where: {
            hotelClientId: hotelId,
            eventType: "visit",
            createdAt: { gte: since, lte: until },
          },
        }),
    scoped(prisma.adSnapshot).findMany({
      where: { hotelClientId: hotelId, archived: false, date: { gte: since, lte: until } },
      orderBy: { date: "asc" },
      select: { date: true, spend: true, conversions: true, roas: true },
    }),
    scoped(prisma.hotelClient).findFirst({
      where: { id: hotelId },
      select: { otaCommissionRate: true },
    }),
  ]);

  // ── KPIs (revenue / bookings / ROAS) ─────────────────────────────────────────
  const snapshotInputs: AdSnapshotInput[] = snapshots.map((s) => ({
    date: s.date,
    spend: Number(s.spend),
    conversions: s.conversions,
    roas: s.roas,
  }));
  const ads = computeAdsSummary(snapshotInputs);
  const eventInputs: EventInput[] = conversions.map((c) => ({
    eventType: "conversion",
    utmSource: c.utmSource,
    utmMedium: c.utmMedium,
    utmContent: null,
    utmCampaign: null,
    sessionId: c.sessionId,
    conversionValue: c.conversionValue == null ? null : Number(c.conversionValue),
    gclid: c.gclid, gbraid: c.gbraid, wbraid: c.wbraid, fbclid: c.fbclid,
  }));
  // Phase 0: divide by CANONICAL paid spend (Meta + Google), not `ads.spend`
  // (Meta only). `ads` remains the Meta-reported block and is unchanged.
  const paidSpend = await getSpendByPlatformFor(agencyId, hotelId, since, until);
  const kpis = computeKpis(eventInputs, paidSpend);
  const adr = kpis.bookings > 0 ? kpis.revenue / kpis.bookings : null;

  // OTA commission saved by direct (snippet-tracked) bookings — booking revenue ×
  // this hotel's own OTA rate (fallback DEFAULT_OTA_RATE). Same basis as the
  // agency-side "Commission Saved vs OTAs" KPI, just scoped to this one hotel.
  const otaRate = hotelMeta?.otaCommissionRate == null ? DEFAULT_OTA_RATE : Number(hotelMeta.otaCommissionRate);
  const otaSavings = {
    rate: otaRate,
    bookingRevenue: kpis.revenue,
    amount: calculateSavings(kpis.revenue, otaRate),
  };

  // ── Channel performance (last-touch by the conversion's own source) ──────────
  const visitorsBySource = new Map<string, Set<string>>();
  for (const g of visitGroups) {
    const s = normSource(g.utmSource);
    const set = visitorsBySource.get(s) ?? new Set<string>();
    set.add(g.sessionId);
    visitorsBySource.set(s, set);
  }
  const convBySource = new Map<string, { bookings: number; revenue: number }>();
  for (const c of conversions) {
    const s = normSource(c.utmSource);
    const e = convBySource.get(s) ?? { bookings: 0, revenue: 0 };
    e.bookings += 1;
    e.revenue += c.conversionValue == null ? 0 : Number(c.conversionValue);
    convBySource.set(s, e);
  }
  // v1 spend attribution mirrors the agency dashboard: all matched ad spend maps
  // to the documented paid source ("facebook"). Only revealed when showAdSpend.
  const totalSpend = ads.spend;
  const spendBySource: Record<string, number> =
    showAdSpend && totalSpend > 0 ? { [normSource("facebook")]: totalSpend } : {};

  const channelKeys = new Set<string>([...visitorsBySource.keys(), ...convBySource.keys()]);
  const channels: HotelChannelRow[] = [...channelKeys]
    .map((source): HotelChannelRow => {
      const conv = convBySource.get(source) ?? { bookings: 0, revenue: 0 };
      const visitorsBrought = visitorsBySource.get(source)?.size ?? 0;
      const spend = showAdSpend ? spendBySource[source] ?? null : null;
      return {
        source,
        label: sourceLabel(source),
        visitorsBrought,
        bookings: conv.bookings,
        revenue: conv.revenue,
        conversionRate: visitorsBrought > 0 ? conv.bookings / visitorsBrought : 0,
        spend,
        trueRoas: spend && spend > 0 ? conv.revenue / spend : null,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.visitorsBrought - a.visitorsBrought);

  // Channel mix: the top channel's share of total tracked bookings.
  const totalBookings = channels.reduce((s, c) => s + c.bookings, 0);
  const topByBookings = [...channels].sort((a, b) => b.bookings - a.bookings)[0];
  const topChannel =
    topByBookings && totalBookings > 0 && topByBookings.bookings > 0
      ? { label: topByBookings.label, pct: topByBookings.bookings / totalBookings }
      : null;

  // ── Instagram organic ────────────────────────────────────────────────────────
  const [igConn, socialSnaps, priorFollowerSnap, topPosts, postAgg] = await Promise.all([
    scoped(prisma.instagramConnection).findFirst({
      where: { hotelClientId: hotelId, tokenType: "igaa_direct" },
      select: { status: true, username: true },
    }),
    scoped(prisma.socialSnapshot).findMany({
      where: { hotelClientId: hotelId, date: { gte: since, lte: until } },
      orderBy: { date: "asc" },
      select: { date: true, followers: true },
    }),
    scoped(prisma.socialSnapshot).findFirst({
      where: { hotelClientId: hotelId, date: { lt: since } },
      orderBy: { date: "desc" },
      select: { followers: true },
    }),
    scoped(prisma.postSnapshot).findMany({
      where: { hotelClientId: hotelId, postedAt: { gte: since, lte: until } },
      orderBy: { reach: "desc" },
      take: 6,
      select: {
        mediaId: true,
        caption: true,
        mediaType: true,
        permalink: true,
        postedAt: true,
        reach: true,
        likes: true,
        comments: true,
        engagement: true,
      },
    }),
    scoped(prisma.postSnapshot).aggregate({
      where: { hotelClientId: hotelId, postedAt: { gte: since, lte: until } },
      _sum: { reach: true, likes: true, comments: true, saves: true, shares: true },
    }),
  ]);

  const followerSeries = socialSnaps.map((s) => ({ date: iso(s.date), followers: s.followers }));
  const currentFollowers = socialSnaps.length
    ? socialSnaps[socialSnaps.length - 1].followers
    : priorFollowerSnap?.followers ?? 0;
  const priorFollowers = priorFollowerSnap?.followers ?? (socialSnaps.length ? socialSnaps[0].followers : 0);
  const postReach = postAgg._sum.reach ?? 0;
  const interactions =
    (postAgg._sum.likes ?? 0) +
    (postAgg._sum.comments ?? 0) +
    (postAgg._sum.saves ?? 0) +
    (postAgg._sum.shares ?? 0);
  const engagementRate = postReach > 0 ? interactions / postReach : null;

  // ── Google Analytics website traffic (falls back to snippet visits) ──────────
  const [gaConn, gaSnaps, gaSources] = await Promise.all([
    scoped(prisma.googleAnalyticsConnection).findFirst({
      where: { hotelClientId: hotelId },
      select: { status: true },
    }),
    scoped(prisma.gaSnapshot).findMany({
      where: { hotelClientId: hotelId, date: { gte: since, lte: until } },
      orderBy: { date: "asc" },
      select: { date: true, sessions: true, conversions: true },
    }),
    scoped(prisma.gaSourceBreakdown).groupBy({
      by: ["source"],
      where: { hotelClientId: hotelId, date: { gte: since, lte: until } },
      _sum: { sessions: true, conversions: true },
    }),
  ]);

  const gaConnected = gaConn?.status === "connected" && (gaSnaps.length > 0 || gaSources.length > 0);
  let traffic: HotelPublicDashboard["traffic"];
  if (gaConnected) {
    const gaSessions = gaSnaps.reduce((s, r) => s + r.sessions, 0);
    const gaConversions = gaSnaps.reduce((s, r) => s + r.conversions, 0);
    traffic = {
      source: "ga",
      dailyVisitors: gaSnaps.map((r) => ({ date: iso(r.date), visitors: r.sessions })),
      sources: gaSources
        .map((r) => ({ source: r.source, sessions: r._sum.sessions ?? 0 }))
        .filter((r) => r.sessions > 0)
        .sort((a, b) => b.sessions - a.sessions),
      totalSessions: gaSessions,
      conversionRate: gaSessions > 0 ? gaConversions / gaSessions : null,
    };
  } else if (!pixelMode) {
    // Snippet fallback: daily distinct visit sessions + per-source visit sessions.
    const dayVisits = await scoped(prisma.trackingEvent).findMany({
      where: { hotelClientId: hotelId, eventType: "visit", createdAt: { gte: since, lte: until } },
      select: { createdAt: true, sessionId: true, utmSource: true },
    });
    const byDay = new Map<string, Set<string>>();
    const bySrc = new Map<string, Set<string>>();
    for (const v of dayVisits) {
      const d = iso(v.createdAt);
      (byDay.get(d) ?? byDay.set(d, new Set()).get(d)!).add(v.sessionId);
      const s = normSource(v.utmSource);
      (bySrc.get(s) ?? bySrc.set(s, new Set()).get(s)!).add(v.sessionId);
    }
    const totalSessions = new Set(dayVisits.map((v) => v.sessionId)).size;
    traffic = {
      source: "snippet",
      dailyVisitors: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, set]) => ({ date, visitors: set.size })),
      sources: [...bySrc.entries()].map(([source, set]) => ({ source, sessions: set.size })).sort((a, b) => b.sessions - a.sessions),
      totalSessions,
      conversionRate: totalSessions > 0 ? kpis.bookings / totalSessions : null,
    };
  } else {
    traffic = { source: "none", dailyVisitors: [], sources: [], totalSessions: 0, conversionRate: null };
  }

  return {
    kpis: {
      revenue: kpis.revenue,
      bookings: kpis.bookings,
      adr,
      topChannel,
      followers: currentFollowers,
      engagementRate,
      // Combined paid spend (Meta + Google) so the figure shown matches the
      // denominator `trueRoas` actually used. Null when hidden from the hotel,
      // and also null when currencies can't be safely combined.
      adSpend: showAdSpend ? paidSpend.total : null,
      trueRoas: showAdSpend ? kpis.roas : null,
    },
    channels,
    instagram: {
      connected: igConn?.status === "active",
      handle: igConn?.username ?? null,
      followers: currentFollowers,
      followerGrowth: currentFollowers - priorFollowers,
      engagementRate,
      followerSeries,
      topPosts: topPosts.map((p) => ({
        mediaId: p.mediaId,
        caption: p.caption,
        mediaType: p.mediaType,
        permalink: p.permalink,
        postedAt: p.postedAt ? iso(p.postedAt) : null,
        reach: p.reach,
        likes: p.likes,
        comments: p.comments,
        engagement: p.engagement,
      })),
    },
    traffic,
    otaSavings,
  };
}
