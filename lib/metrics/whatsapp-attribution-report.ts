import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant";
import type { ResolvedRange } from "@/lib/attribution";

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp enquiries and bookings, credited to the ad that produced them.
//
// THE POINT OF THE WHOLE EXERCISE. A guest taps a click-to-WhatsApp ad, chats,
// and books by phone. No website is involved, so the tracking snippet never sees
// them and the booking looks organic forever. Meta names the ad on the first
// message; the reservations team records the outcome in Kraya; the phone number
// joins the two.
//
// THE JOIN IS AN INFERENCE, NOT A FACT, and the shape of this module says so.
// Meta naming the ad IS a fact. "The person who messaged is the person who
// booked" is not — a family shares a number, an agent books for ten guests. So
// bookings are counted per ad, unattributed bookings are counted separately and
// shown, and no total is presented as though every booking had been placed.
//
// COVERAGE IS REPORTED, NOT ASSUMED. Attribution began the day the hotel added
// the wa_ref_* attributes in Kraya — 11 September for Aster. Every lead before
// that is real and carries no ad, which is indistinguishable from "an ad
// produced nothing" unless the report says which. `attributionSince` is that
// date, and the UI is expected to render it.
// ─────────────────────────────────────────────────────────────────────────────

export type AdPerformance = {
  /** Meta's ad id, exactly as Kraya reported it. */
  adId: string;
  enquiries: number;
  bookings: number;
};

export type WhatsAppAttributionReport = {
  /** Every WhatsApp enquiry in the window, whatever its origin. */
  enquiries: number;
  /** Those Meta named an ad for. */
  enquiriesFromAds: number;
  /** Confirmed bookings that began as a WhatsApp enquiry. */
  bookings: number;
  /** Those whose enquiry carried an ad. Never assumed — joined on phone hash. */
  bookingsFromAds: number;
  /** Per ad, busiest first. */
  ads: AdPerformance[];
  /**
   * The earliest enquiry carrying an ad, or null when none does.
   *
   * Reported because it is the difference between "the ads produced nothing" and
   * "we were not yet recording which ad". Both look identical in the totals.
   */
  attributionSince: Date | null;
  /** True when no Kraya connection exists — distinct from "nothing happened". */
  notConnected: boolean;
};

export async function loadWhatsAppAttribution(args: {
  agencyId: string;
  hotelClientId: string;
  range: ResolvedRange;
}): Promise<WhatsAppAttributionReport> {
  const { agencyId, hotelClientId, range } = args;

  const empty: WhatsAppAttributionReport = {
    enquiries: 0,
    enquiriesFromAds: 0,
    bookings: 0,
    bookingsFromAds: 0,
    ads: [],
    attributionSince: null,
    notConnected: true,
  };

  const connection = await agencyScopedFor(agencyId, prisma.krayaConnection).findFirst({
    where: { hotelClientId },
    select: { id: true },
  });
  if (!connection) return empty;

  const window = { gte: range.since, lte: range.until };

  const [enquiries, enquiriesFromAds, bookings, since] = await Promise.all([
    agencyScopedFor(agencyId, prisma.whatsAppConversation).count({
      where: { hotelClientId, firstMessageAt: window },
    }),
    agencyScopedFor(agencyId, prisma.whatsAppConversation).count({
      where: { hotelClientId, firstMessageAt: window, sourceId: { not: null } },
    }),
    agencyScopedFor(agencyId, prisma.booking).count({
      where: { hotelClientId, provider: "kraya", bookedAt: window },
    }),
    agencyScopedFor(agencyId, prisma.whatsAppConversation).findFirst({
      where: { hotelClientId, sourceId: { not: null } },
      orderBy: { firstMessageAt: "asc" },
      select: { firstMessageAt: true },
    }),
  ]);

  // Bookings joined to the ad behind their enquiry.
  //
  // COUNT(DISTINCT b.id): one guest can hold several conversations — a repeat
  // visitor, or the same number reaching two pipelines — and a plain count would
  // credit one booking to each, inflating every ad it touched.
  //
  // The enquiry must not START AFTER the booking, or an ad clicked in October
  // would be credited with a booking confirmed in September: attribution running
  // backwards, which is worse than none at all.
  const perAd = await prisma.$queryRaw<{ adId: string; bookings: bigint }[]>`
    SELECT c."sourceId" AS "adId", COUNT(DISTINCT b.id) AS bookings
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
      AND c."firstMessageAt" <= b."bookedAt"
    GROUP BY c."sourceId"`;

  const enquiriesPerAd = await prisma.$queryRaw<{ adId: string; n: bigint }[]>`
    SELECT "sourceId" AS "adId", COUNT(*) AS n
    FROM "WhatsAppConversation"
    WHERE "agencyId" = ${agencyId}
      AND "hotelClientId" = ${hotelClientId}
      AND "sourceId" IS NOT NULL
      AND "firstMessageAt" >= ${range.since}
      AND "firstMessageAt" <= ${range.until}
    GROUP BY "sourceId"`;

  const bookingsByAd = new Map(perAd.map((r) => [r.adId, Number(r.bookings)]));
  const ads: AdPerformance[] = enquiriesPerAd
    .map((r) => ({
      adId: r.adId,
      enquiries: Number(r.n),
      bookings: bookingsByAd.get(r.adId) ?? 0,
    }))
    .sort((a, b) => b.bookings - a.bookings || b.enquiries - a.enquiries);

  return {
    enquiries,
    enquiriesFromAds,
    bookings,
    bookingsFromAds: [...bookingsByAd.values()].reduce((t, n) => t + n, 0),
    ads,
    attributionSince: since?.firstMessageAt ?? null,
    notConnected: false,
  };
}
