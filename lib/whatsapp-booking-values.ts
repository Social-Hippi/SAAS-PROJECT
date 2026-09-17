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
  /**
   * How a person finds this booking again.
   *
   * NOT the guest's name, and not their number. The Kraya import deliberately
   * takes neither — `externalBookingId` is a salted phone hash, which identifies
   * nothing to a human. So the handle shown is Kraya's OWN lead id, with the
   * stage and pipeline it sits in: enough to look the lead up in Kraya and read
   * the amount off it.
   *
   * A lead that arrived by spreadsheet has no Kraya id at all, and falls back to
   * the last four digits of the number — the whole of what is kept of a contact
   * detail, and only because without it those leads cannot be found to value.
   */
  krayaLeadId: string | null;
  phoneLast4: string | null;
  stageName: string | null;
  pipelineName: string | null;
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
  krayaLeadId: string | null;
  phoneLast4: string | null;
  stageName: string | null;
  pipelineName: string | null;
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
           b."agencyAdAttributed",
           b."agencyRevenue",
           b."agencyRevenueAt",
           l."krayaLeadId",
           l."phoneLast4",
           l."stageName",
           l."pipelineName",
           EXISTS (
             SELECT 1 FROM "WhatsAppConversation" c
              WHERE c."agencyId" = b."agencyId"
                AND c."hotelClientId" = b."hotelClientId"
                AND c."phoneHash" = b."guestPhoneHash"
                AND c."sourceId" IS NOT NULL
                AND c."firstMessageAt" <= b."bookedAt"
           ) AS traced
      FROM "Booking" b
      -- LATERAL, not a plain join: one number can hold several conversations,
      -- and a plain join would return the booking once per conversation and
      -- multiply the list. LIMIT 1 keeps exactly one row per booking.
      LEFT JOIN LATERAL (
        SELECT c."krayaLeadId", c."phoneLast4", c."stageName", c."pipelineName"
          FROM "WhatsAppConversation" c
         WHERE c."agencyId" = b."agencyId"
           AND c."hotelClientId" = b."hotelClientId"
           AND c."phoneHash" = b."guestPhoneHash"
         ORDER BY c."lastMessageAt" DESC NULLS LAST
         LIMIT 1
      ) l ON TRUE
     WHERE b."agencyId" = ${agencyId}
       AND b."hotelClientId" = ${hotelClientId}
       AND b.provider = 'kraya'
       AND b."bookedAt" >= ${since}
       AND b."bookedAt" <= ${until}
     ORDER BY b."bookedAt" DESC`;

  return rows.map((r) => ({
    id: r.id,
    bookedAt: r.bookedAt,
    // A synthesised id is an internal key, not something to show: it identifies
    // the row to us and nothing to a person. Only a real Kraya id is displayable.
    krayaLeadId: r.krayaLeadId?.startsWith("export:") ? null : r.krayaLeadId,
    phoneLast4: r.phoneLast4,
    stageName: r.stageName,
    pipelineName: r.pipelineName,
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
