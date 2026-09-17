import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// The WhatsApp bookings an agency values by hand.
//
// Kraya records that a booking happened and who made it, never what it was
// worth. So the only route from a WhatsApp booking to return-on-ad-spend is a
// person reading the reservations record and typing the amount in.
//
// Two things are captured per booking and they are not the same kind of claim:
//
//   traced   the guest's conversation carries a real ad sourceId. A RECORD.
//            It cannot be switched off, because switching it off would not make
//            the ad go away.
//   marked   the agency's judgement that an untraced booking came from an ad.
//            An OPINION. Needed only because ad tracing began part-way through
//            the period, so earlier bookings carry no ad even where one plainly
//            caused them.
//
// Both count toward the report's WhatsApp revenue, and the report says that
// plainly rather than passing the second off as the first.
// ─────────────────────────────────────────────────────────────────────────────

export type WhatsAppBookingValue = {
  id: string;
  bookedAt: Date;
  guestName: string | null;
  externalBookingId: string;
  /** The conversation carries a real ad sourceId. A record, not a judgement. */
  traced: boolean;
  /** The agency's own mark. Irrelevant while `traced` is true. */
  marked: boolean;
  /** NULL means NOT ENTERED, which is never zero. */
  amount: number | null;
  enteredAt: Date | null;
};

type Row = {
  id: string;
  bookedAt: Date;
  guestName: string | null;
  externalBookingId: string;
  traced: boolean;
  agencyAdAttributed: boolean;
  agencyRevenue: Prisma.Decimal | null;
  agencyRevenueAt: Date | null;
};

/**
 * Every Kraya booking for one hotel in a window, newest first, each flagged with
 * whether its conversation was traced to an ad.
 *
 * Multi-tenant: agencyId is bound into the WHERE clause, not just the hotel id —
 * a raw query gets none of `agencyScoped`'s automatic filtering, so the tenant
 * boundary has to be written out here and must never be removed.
 *
 * Returns ALL WhatsApp bookings, not only the ad ones, because deciding which
 * came from an ad is the job this list exists to support.
 */
export async function listWhatsAppBookingValues(
  agencyId: string,
  hotelClientId: string,
  since: Date,
  until: Date,
): Promise<WhatsAppBookingValue[]> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT b.id,
           b."bookedAt",
           b."guestName",
           b."externalBookingId",
           b."agencyAdAttributed",
           b."agencyRevenue",
           b."agencyRevenueAt",
           EXISTS (
             SELECT 1 FROM "WhatsAppConversation" c
              WHERE c."agencyId" = b."agencyId"
                AND c."hotelClientId" = b."hotelClientId"
                AND c."phoneHash" = b."guestPhoneHash"
                AND c."sourceId" IS NOT NULL
                AND c."firstMessageAt" <= b."bookedAt"
           ) AS traced
      FROM "Booking" b
     WHERE b."agencyId" = ${agencyId}
       AND b."hotelClientId" = ${hotelClientId}
       AND b.provider = 'kraya'
       AND b."bookedAt" >= ${since}
       AND b."bookedAt" <= ${until}
     ORDER BY b."bookedAt" DESC`;

  return rows.map((r) => ({
    id: r.id,
    bookedAt: r.bookedAt,
    guestName: r.guestName,
    externalBookingId: r.externalBookingId,
    traced: r.traced,
    marked: r.agencyAdAttributed,
    amount: r.agencyRevenue == null ? null : Number(r.agencyRevenue),
    enteredAt: r.agencyRevenueAt,
  }));
}

/** A booking counts toward the report's WhatsApp ad revenue. */
export function countsAsAdBooking(b: WhatsAppBookingValue): boolean {
  return b.traced || b.marked;
}

/**
 * What the report will show, computed from the same rule the loader uses, so
 * the agency screen and the hotel's report can never disagree.
 */
export function summariseValues(bookings: readonly WhatsAppBookingValue[]): {
  countable: number;
  valued: number;
  total: number;
} {
  const counted = bookings.filter(countsAsAdBooking);
  const valued = counted.filter((b) => b.amount != null);
  return {
    countable: counted.length,
    valued: valued.length,
    total: valued.reduce((sum, b) => sum + (b.amount ?? 0), 0),
  };
}
