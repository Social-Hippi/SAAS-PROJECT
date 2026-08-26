import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant-scope";
import { contentPieceIdFromUtmContent } from "@/lib/influencer-attribution";
import { isAttributable, type MatchConfidence } from "@/lib/booking-identity";

// ─────────────────────────────────────────────────────────────────────────────
// Influencer performance — server-side aggregation.
//
// WHAT IS DELIBERATELY ABSENT, and why (these are audit findings, not omissions
// to be filled in later with something plausible):
//
//   LINK CLICKS      Not observable. HotelTrack sees LANDINGS, never the click
//                    itself — that belongs to Instagram. `ClickEvent` records
//                    on-site [data-ht-click] elements, which is a different
//                    thing. Reporting sessions as "clicks" would relabel one
//                    number as two.
//   CHECKOUT         Not observable. Checkout happens on the booking engine,
//                    outside HotelTrack's script.
//   ROAS             No influencer cost is stored on any model, so there is no
//                    denominator. A ROAS without a real cost is a fiction.
//
// Each is reported as an explicit availability state so the UI can say "Not
// tracked" rather than render a misleading zero.
//
// TWO REVENUE STREAMS THAT MUST NOT BE SUMMED. Booking revenue (authoritative,
// from the booking provider) and coupon-redemption revenue (legacy, derived
// from browser conversions) have no join between them: InfluencerRedemption
// carries no bookingId. Adding them would double-count any booking that used a
// coupon. They are returned separately and the UI presents them separately.
// ─────────────────────────────────────────────────────────────────────────────

export type Availability =
  | { state: "available" }
  /** The signal cannot be observed by HotelTrack at all. */
  | { state: "not_observable"; reason: string }
  /** Observable, but this hotel has not configured what it needs. */
  | { state: "not_configured"; reason: string };

export type InfluencerRow = {
  influencerId: string;
  name: string;
  platform: string | null;
  instagramHandle: string | null;
  archived: boolean;
  /** Distinct sessions that landed via one of this influencer's tracked links. */
  sessions: number;
  /** Sessions that reached the hotel's booking engine (funnelStage = intent). */
  bookingEngineVisits: number;
  /** Bookings matched to this influencer's journeys at STRONG confidence or better. */
  confirmedBookings: number;
  /** Authoritative booking revenue. Null when no attributable booking exists. */
  attributedRevenue: number | null;
  currency: string | null;
  /** True when matched bookings span more than one currency — do not sum. */
  mixedCurrency: boolean;
  couponRedemptions: number;
  couponRevenue: number;
  /** Weakest confidence among this influencer's attributed bookings. */
  confidence: MatchConfidence | null;
  contentPieces: number;
  activeCoupons: number;
};

export type InfluencerKpis = {
  activeInfluencers: number;
  sessions: number;
  bookingEngineVisits: number;
  confirmedBookings: number;
  attributedRevenue: number | null;
  currency: string | null;
  mixedCurrency: boolean;
  couponRedemptions: number;
  couponRevenue: number;
  /** bookings ÷ sessions, or null when there were no sessions. */
  bookingConversionRate: number | null;
  revenuePerSession: number | null;
  averageBookingValue: number | null;
};

export type InfluencerPerformance = {
  kpis: InfluencerKpis;
  rows: InfluencerRow[];
  series: { date: string; sessions: number; bookingEngineVisits: number; bookings: number; revenue: number }[];
  funnel: {
    linkClicks: Availability;
    sessions: { value: number };
    bookingEngine: { value: number } & { availability: Availability };
    checkout: Availability;
    confirmedBookings: { value: number } & { availability: Availability };
    attributedRevenue: { value: number | null; currency: string | null } & { availability: Availability };
  };
  availability: {
    linkClicks: Availability;
    checkout: Availability;
    roas: Availability;
    bookingEngine: Availability;
    bookings: Availability;
  };
  /** Bookings that matched a journey but below the attribution floor. Surfaced, never counted. */
  belowConfidenceFloor: number;
};

const NOT_OBSERVABLE_CLICKS: Availability = {
  state: "not_observable",
  reason: "HotelTrack records landings, not clicks. Click counts live in the platform the link was posted on.",
};
const NOT_OBSERVABLE_CHECKOUT: Availability = {
  state: "not_observable",
  reason: "Checkout happens inside the booking engine, outside HotelTrack's tracking script.",
};
const NO_COST: Availability = {
  state: "not_configured",
  reason: "Influencer cost is not recorded, so ROAS has no denominator.",
};

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

function dayRange(since: Date, until: Date): string[] {
  const out: string[] = [];
  const cur = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
  const end = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate()));
  while (cur <= end && out.length < 400) {
    out.push(dayKey(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export type PerformanceQuery = {
  agencyId: string;
  /** Empty/undefined = every hotel the agency owns. */
  hotelClientIds?: string[];
  influencerId?: string;
  since: Date;
  until: Date;
};

export async function loadInfluencerPerformance(q: PerformanceQuery): Promise<InfluencerPerformance> {
  const scoped = <D>(model: D) => agencyScopedFor(q.agencyId, model);
  const hotelFilter = q.hotelClientIds?.length ? { hotelClientId: { in: q.hotelClientIds } } : {};
  const range = { gte: q.since, lte: q.until };

  // ── 1. Which content pieces belong to which influencer ───────────────────
  const pieces = await scoped(prisma.contentPiece).findMany({
    where: { ...hotelFilter, influencerId: q.influencerId ? q.influencerId : { not: null } },
    select: { id: true, influencerId: true, platform: true, hotelClientId: true },
  });
  const pieceToInfluencer = new Map<string, string>();
  const piecesPerInfluencer = new Map<string, number>();
  const platformOf = new Map<string, string>();
  for (const p of pieces) {
    if (!p.influencerId) continue;
    pieceToInfluencer.set(p.id, p.influencerId);
    piecesPerInfluencer.set(p.influencerId, (piecesPerInfluencer.get(p.influencerId) ?? 0) + 1);
    if (!platformOf.has(p.influencerId)) platformOf.set(p.influencerId, p.platform);
  }
  const utmContents = [...pieceToInfluencer.keys()].map((id) => `ht-${id}`);

  // ── 2. Sessions that landed via one of those links ───────────────────────
  const sessions = utmContents.length
    ? await scoped(prisma.session).findMany({
        where: { ...hotelFilter, startedAt: range, utmContent: { in: utmContents } },
        select: { id: true, visitorId: true, utmContent: true, startedAt: true, hotelClientId: true },
      })
    : [];

  const sessionInfluencer = new Map<string, string>();
  const visitorInfluencer = new Map<string, string>();
  for (const s of sessions) {
    const pieceId = contentPieceIdFromUtmContent(s.utmContent);
    const infId = pieceId ? pieceToInfluencer.get(pieceId) : undefined;
    if (!infId) continue;
    sessionInfluencer.set(s.id, infId);
    // First influencer wins for a visitor: a visitor's first influencer touch is
    // the one whose link produced them. Never overwritten by a later one.
    if (!visitorInfluencer.has(s.visitorId)) visitorInfluencer.set(s.visitorId, infId);
  }

  // ── 3. Booking-engine visits (funnelStage = intent) ──────────────────────
  const sessionIds = [...sessionInfluencer.keys()];
  const intentViews = sessionIds.length
    ? await scoped(prisma.pageView).findMany({
        where: { sessionId: { in: sessionIds }, funnelStage: "intent" },
        select: { sessionId: true, enteredAt: true },
      })
    : [];
  const intentSessions = new Set(intentViews.map((v) => v.sessionId));

  // ── 4. Attributable bookings ─────────────────────────────────────────────
  const visitorIds = [...visitorInfluencer.keys()];
  const matches = visitorIds.length
    ? await scoped(prisma.bookingJourneyMatch).findMany({
        where: { visitorId: { in: visitorIds } },
        select: {
          bookingId: true, visitorId: true, matchMethod: true, matchConfidence: true,
          booking: {
            select: {
              id: true, status: true, grossAmount: true, currency: true, bookedAt: true,
              hotelClientId: true,
            },
          },
        },
      })
    : [];

  // ── 5. Coupon redemptions (a SEPARATE stream — never summed with bookings) ─
  const redemptions = await scoped(prisma.influencerRedemption).findMany({
    where: {
      ...hotelFilter,
      redeemedAt: range,
      ...(q.influencerId ? { influencerId: q.influencerId } : {}),
    },
    select: { influencerId: true, bookingValue: true, redeemedAt: true },
  });

  const [influencers, activeCodeGroups] = await Promise.all([
    scoped(prisma.influencer).findMany({
      where: q.influencerId ? { id: q.influencerId } : {},
      select: { id: true, name: true, instagramHandle: true, archivedAt: true },
    }),
    scoped(prisma.couponCode).groupBy({
      by: ["influencerId"],
      where: { ...hotelFilter, status: "ACTIVE" },
      _count: { _all: true },
    }),
  ]);
  const activeCodes = new Map(activeCodeGroups.map((g) => [g.influencerId, g._count._all]));
  const meta = new Map(influencers.map((i) => [i.id, i]));

  // ── 6. Roll up ────────────────────────────────────────────────────────────
  type Acc = InfluencerRow & { currencies: Set<string>; confidences: MatchConfidence[] };
  const accs = new Map<string, Acc>();
  const ensure = (id: string): Acc => {
    let a = accs.get(id);
    if (!a) {
      const m = meta.get(id);
      a = {
        influencerId: id,
        name: m?.name ?? "(removed influencer)",
        platform: platformOf.get(id) ?? null,
        instagramHandle: m?.instagramHandle ?? null,
        archived: m?.archivedAt != null,
        sessions: 0, bookingEngineVisits: 0, confirmedBookings: 0,
        attributedRevenue: null, currency: null, mixedCurrency: false,
        couponRedemptions: 0, couponRevenue: 0, confidence: null,
        contentPieces: piecesPerInfluencer.get(id) ?? 0,
        activeCoupons: activeCodes.get(id) ?? 0,
        currencies: new Set<string>(), confidences: [],
      };
      accs.set(id, a);
    }
    return a;
  };

  for (const [sessionId, infId] of sessionInfluencer) {
    const a = ensure(infId);
    a.sessions += 1;
    if (intentSessions.has(sessionId)) a.bookingEngineVisits += 1;
  }

  let belowFloor = 0;
  const countedBookings = new Set<string>();
  for (const m of matches) {
    const infId = visitorInfluencer.get(m.visitorId ?? "");
    if (!infId || !m.booking) continue;
    if (m.booking.bookedAt < q.since || m.booking.bookedAt > q.until) continue;
    if (q.hotelClientIds?.length && !q.hotelClientIds.includes(m.booking.hotelClientId)) continue;
    // A cancelled or refunded booking is not confirmed revenue.
    if (m.booking.status !== "CONFIRMED" && m.booking.status !== "COMPLETED") continue;

    const confidence = m.matchConfidence as MatchConfidence;
    if (!isAttributable(confidence)) { belowFloor += 1; continue; }
    // ONE BOOKING, ONE REVENUE RECORD — even when several matches point at it.
    if (countedBookings.has(m.booking.id)) continue;
    countedBookings.add(m.booking.id);

    const a = ensure(infId);
    a.confirmedBookings += 1;
    a.confidences.push(confidence);
    if (m.booking.grossAmount != null) {
      a.attributedRevenue = (a.attributedRevenue ?? 0) + Number(m.booking.grossAmount);
      if (m.booking.currency) a.currencies.add(m.booking.currency);
    }
  }

  for (const r of redemptions) {
    const a = ensure(r.influencerId);
    a.couponRedemptions += 1;
    a.couponRevenue += Number(r.bookingValue);
  }

  const rows: InfluencerRow[] = [...accs.values()].map((a) => {
    const currencies = [...a.currencies];
    const weakest = a.confidences.length
      ? a.confidences.reduce((w, c) => (rank(c) < rank(w) ? c : w))
      : null;
    return {
      ...a,
      currency: currencies.length === 1 ? currencies[0] : null,
      mixedCurrency: currencies.length > 1,
      attributedRevenue: currencies.length > 1 ? null : a.attributedRevenue,
      confidence: weakest,
    };
  });
  rows.sort(
    (x, y) =>
      (y.attributedRevenue ?? 0) - (x.attributedRevenue ?? 0) ||
      y.confirmedBookings - x.confirmedBookings ||
      y.sessions - x.sessions ||
      x.name.localeCompare(y.name),
  );

  // ── 7. KPIs + series ──────────────────────────────────────────────────────
  const totalSessions = rows.reduce((s, r) => s + r.sessions, 0);
  const totalIntent = rows.reduce((s, r) => s + r.bookingEngineVisits, 0);
  const totalBookings = rows.reduce((s, r) => s + r.confirmedBookings, 0);
  const allCurrencies = new Set(rows.flatMap((r) => (r.currency ? [r.currency] : [])));
  const anyMixed = rows.some((r) => r.mixedCurrency) || allCurrencies.size > 1;
  const totalRevenue = anyMixed ? null : rows.reduce((s, r) => s + (r.attributedRevenue ?? 0), 0);

  const sessionsByDay = new Map<string, number>();
  const intentByDay = new Map<string, number>();
  for (const s of sessions) {
    if (!sessionInfluencer.has(s.id)) continue;
    const k = dayKey(s.startedAt);
    sessionsByDay.set(k, (sessionsByDay.get(k) ?? 0) + 1);
  }
  for (const v of intentViews) intentByDay.set(dayKey(v.enteredAt), (intentByDay.get(dayKey(v.enteredAt)) ?? 0) + 1);

  const bookingsByDay = new Map<string, { n: number; rev: number }>();
  for (const m of matches) {
    if (!m.booking || !countedBookings.has(m.booking.id)) continue;
    const k = dayKey(m.booking.bookedAt);
    const row = bookingsByDay.get(k) ?? { n: 0, rev: 0 };
    row.n += 1;
    row.rev += Number(m.booking.grossAmount ?? 0);
    bookingsByDay.set(k, row);
  }

  const series = dayRange(q.since, q.until).map((date) => ({
    date,
    sessions: sessionsByDay.get(date) ?? 0,
    bookingEngineVisits: intentByDay.get(date) ?? 0,
    bookings: bookingsByDay.get(date)?.n ?? 0,
    revenue: bookingsByDay.get(date)?.rev ?? 0,
  }));

  // Availability depends on real configuration, not on whether rows happen to be 0.
  const hotelsInScope = await scoped(prisma.hotelClient).findMany({
    where: q.hotelClientIds?.length ? { id: { in: q.hotelClientIds } } : {},
    select: { id: true, bookingDomains: true },
  });
  const anyBookingDomains = hotelsInScope.some((h) => h.bookingDomains.length > 0);
  const connectionCount = await scoped(prisma.bookingConnection).count({
    where: q.hotelClientIds?.length ? { hotelClientId: { in: q.hotelClientIds } } : {},
  });

  const bookingEngineAvailability: Availability = anyBookingDomains
    ? { state: "available" }
    : { state: "not_configured", reason: "No booking-engine domains are configured for this hotel." };
  const bookingsAvailability: Availability = connectionCount > 0
    ? { state: "available" }
    : { state: "not_configured", reason: "No booking provider is connected, so confirmed bookings cannot arrive." };

  const activeInfluencers = rows.filter(
    (r) => r.sessions > 0 || r.confirmedBookings > 0 || r.couponRedemptions > 0,
  ).length;

  return {
    kpis: {
      activeInfluencers,
      sessions: totalSessions,
      bookingEngineVisits: totalIntent,
      confirmedBookings: totalBookings,
      attributedRevenue: totalRevenue,
      currency: allCurrencies.size === 1 ? [...allCurrencies][0] : null,
      mixedCurrency: anyMixed,
      couponRedemptions: rows.reduce((s, r) => s + r.couponRedemptions, 0),
      couponRevenue: rows.reduce((s, r) => s + r.couponRevenue, 0),
      bookingConversionRate: totalSessions > 0 ? totalBookings / totalSessions : null,
      revenuePerSession: totalSessions > 0 && totalRevenue != null ? totalRevenue / totalSessions : null,
      averageBookingValue: totalBookings > 0 && totalRevenue != null ? totalRevenue / totalBookings : null,
    },
    rows,
    series,
    funnel: {
      linkClicks: NOT_OBSERVABLE_CLICKS,
      sessions: { value: totalSessions },
      bookingEngine: { value: totalIntent, availability: bookingEngineAvailability },
      checkout: NOT_OBSERVABLE_CHECKOUT,
      confirmedBookings: { value: totalBookings, availability: bookingsAvailability },
      attributedRevenue: {
        value: totalRevenue,
        currency: allCurrencies.size === 1 ? [...allCurrencies][0] : null,
        availability: bookingsAvailability,
      },
    },
    availability: {
      linkClicks: NOT_OBSERVABLE_CLICKS,
      checkout: NOT_OBSERVABLE_CHECKOUT,
      roas: NO_COST,
      bookingEngine: bookingEngineAvailability,
      bookings: bookingsAvailability,
    },
    belowConfidenceFloor: belowFloor,
  };
}

const ORDER: MatchConfidence[] = ["UNKNOWN", "PARTIAL", "STRONG", "DETERMINISTIC"];
function rank(c: MatchConfidence): number {
  const i = ORDER.indexOf(c);
  return i < 0 ? 0 : i;
}
