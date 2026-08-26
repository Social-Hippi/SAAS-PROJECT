import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant-scope";
import { isAttributable, type MatchConfidence, type MatchMethod } from "@/lib/booking-identity";

// ─────────────────────────────────────────────────────────────────────────────
// Individual customer journeys attributed to one influencer.
//
// Every stage below is read from a PERSISTED row. A stage that was never
// recorded is reported as `captured: false` so the UI can say "Not captured"
// instead of rendering a zero — the difference between "it did not happen" and
// "we could not see it" is the whole point of this view.
//
// NO GUEST PII LEAVES THIS MODULE. Bookings carry only salted hashes of email
// and phone; neither is returned, and the guest name is reduced to initials.
// ─────────────────────────────────────────────────────────────────────────────

/** Human-readable reason for each confidence grade — the backend's own terms. */
export const CONFIDENCE_REASON: Record<MatchConfidence, string> = {
  DETERMINISTIC: "Matched on an identifier HotelTrack issued for this exact visit.",
  STRONG: "Matched on a deterministic customer identifier.",
  PARTIAL: "Multiple candidate journeys matched — the link is not exclusive.",
  UNKNOWN: "No deterministic journey match.",
};

export const METHOD_LABEL: Partial<Record<MatchMethod, string>> = {
  session_id: "HotelTrack journey token (session)",
  visitor_id: "HotelTrack journey token (visitor)",
  tracking_event: "Tracking event",
  booking_id: "Provider booking id",
  customer_id: "Customer identifier",
  email_hash: "Hashed email",
  phone_hash: "Hashed phone",
  coupon_code: "Coupon code",
  manual: "Entered manually",
  unknown: "No match",
};

export type JourneyStage = {
  key: "click" | "session" | "pageviews" | "interaction" | "booking_engine" | "booking" | "revenue" | "attribution";
  label: string;
  captured: boolean;
  detail: string | null;
  at: Date | null;
};

export type JourneySummary = {
  /** Short display id, e.g. HT-3F9A2B. Derived from the session id, never PII. */
  ref: string;
  sessionId: string;
  visitorId: string;
  hotelClientId: string;
  firstTouchSource: string | null;
  firstTouchMedium: string | null;
  campaign: string | null;
  landingPath: string;
  startedAt: Date;
  pageViews: number;
  reachedBookingEngine: boolean;
  bookingStatus: string | null;
  externalBookingId: string | null;
  revenue: number | null;
  currency: string | null;
  matchMethod: MatchMethod | null;
  confidence: MatchConfidence | null;
  attributable: boolean;
  /** Which evidence links this journey to the influencer. */
  evidence: { trackedLink: boolean; coupon: string | null };
};

export type InfluencerJourneys = {
  influencer: {
    id: string;
    name: string;
    instagramHandle: string | null;
    archived: boolean;
    platform: string | null;
    campaigns: string[];
    trackedUrls: { contentPieceId: string; title: string; utmLink: string; couponCode: string | null }[];
    coupons: { code: string; status: string; validFrom: Date | null; validUntil: Date | null }[];
  };
  journeys: JourneySummary[];
};

const shortRef = (sessionId: string) =>
  "HT-" + sessionId.replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase();

/** "Priya Sharma" -> "P. S." — enough to distinguish rows, not to identify. */
export function maskGuestName(name: string | null | undefined): string | null {
  if (!name) return null;
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.map((p) => p[0]!.toUpperCase() + ".").join(" ");
}

export async function loadInfluencerJourneys(q: {
  agencyId: string;
  influencerId: string;
  hotelClientIds?: string[];
  since: Date;
  until: Date;
  limit?: number;
}): Promise<InfluencerJourneys | null> {
  const scoped = <D>(model: D) => agencyScopedFor(q.agencyId, model);
  const hotelFilter = q.hotelClientIds?.length ? { hotelClientId: { in: q.hotelClientIds } } : {};

  const influencer = await scoped(prisma.influencer).findFirst({
    where: { id: q.influencerId },
    select: { id: true, name: true, instagramHandle: true, archivedAt: true },
  });
  if (!influencer) return null; // wrong tenant or nonexistent — indistinguishable by design

  const [pieces, coupons] = await Promise.all([
    scoped(prisma.contentPiece).findMany({
      where: { ...hotelFilter, influencerId: q.influencerId },
      select: { id: true, title: true, utmLink: true, platform: true, couponCode: true },
    }),
    scoped(prisma.couponCode).findMany({
      where: { ...hotelFilter, influencerId: q.influencerId },
      select: { code: true, status: true, validFrom: true, validUntil: true },
    }),
  ]);

  const utmContents = pieces.map((p) => `ht-${p.id}`);
  const sessions = utmContents.length
    ? await scoped(prisma.session).findMany({
        where: { ...hotelFilter, startedAt: { gte: q.since, lte: q.until }, utmContent: { in: utmContents } },
        select: {
          id: true, visitorId: true, hotelClientId: true, startedAt: true, landingPath: true,
          pageViewCount: true, utmSource: true, utmMedium: true, utmCampaign: true, utmContent: true,
        },
        orderBy: { startedAt: "desc" },
        take: Math.min(q.limit ?? 100, 500),
      })
    : [];

  const sessionIds = sessions.map((s) => s.id);
  const visitorIds = [...new Set(sessions.map((s) => s.visitorId))];

  const [intentViews, matches, couponUse] = await Promise.all([
    sessionIds.length
      ? scoped(prisma.pageView).findMany({
          where: { sessionId: { in: sessionIds }, funnelStage: "intent" },
          select: { sessionId: true },
        })
      : Promise.resolve([]),
    visitorIds.length
      ? scoped(prisma.bookingJourneyMatch).findMany({
          where: { visitorId: { in: visitorIds } },
          select: {
            visitorId: true, matchMethod: true, matchConfidence: true,
            booking: {
              select: {
                status: true, externalBookingId: true, grossAmount: true, currency: true,
                bookedAt: true, journeySessionId: true,
              },
            },
          },
        })
      : Promise.resolve([]),
    sessionIds.length
      ? scoped(prisma.trackingEvent).findMany({
          where: { sessionId: { in: sessionIds }, couponCodeUsed: { not: null } },
          select: { sessionId: true, couponCodeUsed: true },
        })
      : Promise.resolve([]),
  ]);

  const intent = new Set(intentViews.map((v) => v.sessionId));
  const couponBySession = new Map(couponUse.map((c) => [c.sessionId, c.couponCodeUsed]));

  // Prefer a match whose booking names THIS session; else fall back to the
  // visitor-level match. Never merge two different bookings into one journey.
  const bySession = new Map<string, (typeof matches)[number]>();
  const byVisitor = new Map<string, (typeof matches)[number]>();
  for (const m of matches) {
    if (!m.booking) continue;
    if (m.booking.journeySessionId) bySession.set(m.booking.journeySessionId, m);
    else if (m.visitorId && !byVisitor.has(m.visitorId)) byVisitor.set(m.visitorId, m);
  }

  const journeys: JourneySummary[] = sessions.map((s) => {
    const m = bySession.get(s.id) ?? byVisitor.get(s.visitorId) ?? null;
    const b = m?.booking ?? null;
    const confidence = (m?.matchConfidence as MatchConfidence | undefined) ?? null;
    return {
      ref: shortRef(s.id),
      sessionId: s.id,
      visitorId: s.visitorId,
      hotelClientId: s.hotelClientId,
      firstTouchSource: s.utmSource,
      firstTouchMedium: s.utmMedium,
      campaign: s.utmCampaign,
      landingPath: s.landingPath,
      startedAt: s.startedAt,
      pageViews: s.pageViewCount,
      reachedBookingEngine: intent.has(s.id),
      bookingStatus: b?.status ?? null,
      externalBookingId: b?.externalBookingId ?? null,
      revenue: b?.grossAmount != null ? Number(b.grossAmount) : null,
      currency: b?.currency ?? null,
      matchMethod: (m?.matchMethod as MatchMethod | undefined) ?? null,
      confidence,
      attributable: confidence ? isAttributable(confidence) : false,
      evidence: {
        trackedLink: true, // every session here arrived via a tracked link
        coupon: couponBySession.get(s.id) ?? null,
      },
    };
  });

  return {
    influencer: {
      id: influencer.id,
      name: influencer.name,
      instagramHandle: influencer.instagramHandle,
      archived: influencer.archivedAt != null,
      platform: pieces[0]?.platform ?? null,
      campaigns: [...new Set(sessions.flatMap((s) => (s.utmCampaign ? [s.utmCampaign] : [])))],
      trackedUrls: pieces.map((p) => ({
        contentPieceId: p.id, title: p.title, utmLink: p.utmLink, couponCode: p.couponCode,
      })),
      coupons: coupons.map((c) => ({
        code: c.code, status: c.status, validFrom: c.validFrom, validUntil: c.validUntil,
      })),
    },
    journeys,
  };
}

/** Ordered timeline for ONE journey. Uncaptured stages are marked, not zeroed. */
export async function loadJourneyDetail(q: {
  agencyId: string;
  sessionId: string;
}): Promise<{ journey: JourneySummary; stages: JourneyStage[]; pages: { path: string; at: Date; stage: string | null }[] } | null> {
  const scoped = <D>(model: D) => agencyScopedFor(q.agencyId, model);

  const session = await scoped(prisma.session).findFirst({
    where: { id: q.sessionId },
    select: {
      id: true, visitorId: true, hotelClientId: true, startedAt: true, endedAt: true,
      landingPath: true, exitPath: true, pageViewCount: true,
      utmSource: true, utmMedium: true, utmCampaign: true, utmContent: true,
    },
  });
  if (!session) return null;

  const [pageViews, clicks, matches, couponEvent] = await Promise.all([
    scoped(prisma.pageView).findMany({
      where: { sessionId: session.id },
      select: { pagePath: true, enteredAt: true, funnelStage: true },
      orderBy: { enteredAt: "asc" },
    }),
    scoped(prisma.clickEvent).findMany({
      where: { sessionId: session.id },
      select: { clickTarget: true, occurredAt: true },
      orderBy: { occurredAt: "asc" },
    }),
    scoped(prisma.bookingJourneyMatch).findMany({
      where: { visitorId: session.visitorId },
      select: {
        matchMethod: true, matchConfidence: true,
        booking: {
          select: {
            status: true, externalBookingId: true, grossAmount: true, currency: true,
            bookedAt: true, journeySessionId: true, guestName: true,
          },
        },
      },
    }),
    scoped(prisma.trackingEvent).findFirst({
      where: { sessionId: session.id, couponCodeUsed: { not: null } },
      select: { couponCodeUsed: true },
    }),
  ]);

  const m = matches.find((x) => x.booking?.journeySessionId === session.id) ?? matches[0] ?? null;
  const b = m?.booking ?? null;
  const confidence = (m?.matchConfidence as MatchConfidence | undefined) ?? null;
  const intentView = pageViews.find((p) => p.funnelStage === "intent") ?? null;

  const journey: JourneySummary = {
    ref: shortRef(session.id),
    sessionId: session.id,
    visitorId: session.visitorId,
    hotelClientId: session.hotelClientId,
    firstTouchSource: session.utmSource,
    firstTouchMedium: session.utmMedium,
    campaign: session.utmCampaign,
    landingPath: session.landingPath,
    startedAt: session.startedAt,
    pageViews: session.pageViewCount,
    reachedBookingEngine: intentView != null,
    bookingStatus: b?.status ?? null,
    externalBookingId: b?.externalBookingId ?? null,
    revenue: b?.grossAmount != null ? Number(b.grossAmount) : null,
    currency: b?.currency ?? null,
    matchMethod: (m?.matchMethod as MatchMethod | undefined) ?? null,
    confidence,
    attributable: confidence ? isAttributable(confidence) : false,
    evidence: { trackedLink: true, coupon: couponEvent?.couponCodeUsed ?? null },
  };

  const stages: JourneyStage[] = [
    {
      key: "click", label: "Click",
      // The landing proves a click happened; the click itself is Instagram's data.
      captured: true,
      detail: `Arrived via ${session.utmSource ?? "unknown source"} / ${session.utmMedium ?? "unknown medium"}`,
      at: session.startedAt,
    },
    { key: "session", label: "Session", captured: true, detail: shortRef(session.id), at: session.startedAt },
    {
      key: "pageviews", label: "Pages viewed",
      captured: pageViews.length > 0,
      detail: pageViews.length ? `${pageViews.length} page${pageViews.length === 1 ? "" : "s"}` : null,
      at: pageViews[0]?.enteredAt ?? null,
    },
    {
      key: "interaction", label: "Interaction",
      captured: clicks.length > 0,
      detail: clicks.length ? clicks.map((c) => c.clickTarget).slice(0, 3).join(", ") : null,
      at: clicks[0]?.occurredAt ?? null,
    },
    {
      key: "booking_engine", label: "Booking engine",
      captured: intentView != null,
      detail: intentView ? intentView.pagePath : null,
      at: intentView?.enteredAt ?? null,
    },
    {
      key: "booking", label: "Booking",
      captured: b != null,
      detail: b ? `${b.status}${b.externalBookingId ? ` · ${b.externalBookingId}` : ""}` : null,
      at: b?.bookedAt ?? null,
    },
    {
      key: "revenue", label: "Revenue",
      captured: b?.grossAmount != null,
      detail: b?.grossAmount != null ? `${b.currency ?? ""} ${Number(b.grossAmount)}`.trim() : null,
      at: b?.bookedAt ?? null,
    },
    {
      key: "attribution", label: "Attribution",
      captured: confidence != null,
      detail: confidence ? CONFIDENCE_REASON[confidence] : null,
      at: null,
    },
  ];

  return {
    journey,
    stages,
    pages: pageViews.map((p) => ({ path: p.pagePath, at: p.enteredAt, stage: p.funnelStage })),
  };
}
