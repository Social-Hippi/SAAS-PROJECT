import "server-only";

import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Kraya leads, by property and bucket.
//
// For a date window: per Kraya pipeline (property), how many leads came from an
// ad, and which bucket (Kraya stage) each sits in NOW — beside the same counts
// for every lead, so ad leads can be compared with the rest.
//
// Decisions, agreed with the agency:
//
//   PROPERTY = Kraya pipeline, verbatim. "Leads" is its own box — it is the
//     inbox leads wait in before the team files them under a property, and
//     folding it into either property would be a guess.
//
//   BUCKETS KEEP KRAYA'S OWN NAMES. "Sold out" and "Sold out for CBH" are not
//     merged: each property is shown in its own box, and deciding that two
//     differently named stages are the same would be us guessing at the
//     reservations team's vocabulary.
//
//   CURRENT BUCKET *AND* EVER BOOKED. The bucket is where the lead sits now, so
//     a guest who booked and then moved on (to "Inhouse", say) no longer shows
//     under "Booking Confirmed". Counting bookings from the bucket alone would
//     therefore under-count them; "booked" is counted separately, from whether
//     the lead ever produced a booking.
//
//   THE WINDOW IS WHEN THE LEAD FIRST MESSAGED. A lead from today counts for
//     today, whichever bucket it moves to afterwards.
//
//   "FROM ADS" = the lead carries a Meta click-to-WhatsApp ad sticker (sourceId).
//     That began on 11 Sep 2026, and a guest who reached WhatsApp from a Google
//     ad via the website carries no sticker — both limits are stated on screen.
// ─────────────────────────────────────────────────────────────────────────────

/** Kraya's inbox pipeline: leads not yet filed under a property. */
export const UNSORTED_PIPELINE = "Leads";

export type BucketRow = {
  bucket: string;
  fromAds: number;
  all: number;
};

export type PropertyBreakdown = {
  /** The Kraya pipeline name, verbatim, or null when Kraya sent none. */
  pipeline: string | null;
  label: string;
  fromAds: number;
  all: number;
  /** Leads in the window that ever produced a booking. */
  bookedFromAds: number;
  bookedAll: number;
  buckets: BucketRow[];
};

type Row = {
  pipeline: string | null;
  bucket: string | null;
  from_ads: bigint;
  all_leads: bigint;
  booked_from_ads: bigint;
  booked_all: bigint;
};

/** What the agency reads above a property's box. */
export function propertyLabel(pipeline: string | null): string {
  if (pipeline == null) return "No property recorded";
  if (pipeline === UNSORTED_PIPELINE) return "Leads — not yet sorted into a property";
  return pipeline;
}

/** Where a box sits: real properties alphabetically, then the inbox, then none. */
function rank(pipeline: string | null): number {
  if (pipeline == null) return 2;
  if (pipeline === UNSORTED_PIPELINE) return 1;
  return 0;
}

/**
 * Folds grouped rows into one box per property. Pure, so it is tested without a
 * database.
 */
export function shapeBreakdown(
  rows: ReadonlyArray<{
    pipeline: string | null;
    bucket: string | null;
    fromAds: number;
    all: number;
    bookedFromAds: number;
    bookedAll: number;
  }>,
): PropertyBreakdown[] {
  const byPipeline = new Map<string | null, PropertyBreakdown>();
  for (const r of rows) {
    let box = byPipeline.get(r.pipeline);
    if (!box) {
      box = {
        pipeline: r.pipeline,
        label: propertyLabel(r.pipeline),
        fromAds: 0,
        all: 0,
        bookedFromAds: 0,
        bookedAll: 0,
        buckets: [],
      };
      byPipeline.set(r.pipeline, box);
    }
    box.fromAds += r.fromAds;
    box.all += r.all;
    box.bookedFromAds += r.bookedFromAds;
    box.bookedAll += r.bookedAll;
    box.buckets.push({ bucket: r.bucket ?? "No bucket recorded", fromAds: r.fromAds, all: r.all });
  }

  for (const box of byPipeline.values()) {
    // Most ad leads first — that is what the section is about — then by volume.
    box.buckets.sort((a, b) => b.fromAds - a.fromAds || b.all - a.all || a.bucket.localeCompare(b.bucket));
  }

  return [...byPipeline.values()].sort(
    (a, b) =>
      rank(a.pipeline) - rank(b.pipeline) || (a.pipeline ?? "").localeCompare(b.pipeline ?? ""),
  );
}

/**
 * The breakdown for one hotel over a window of FIRST-MESSAGE dates.
 *
 * Multi-tenant: agencyId is bound into the WHERE clause and into the booking
 * join — a raw query gets none of agencyScoped's automatic filtering.
 */
export async function loadLeadBreakdown(
  agencyId: string,
  hotelClientId: string,
  since: Date,
  until: Date,
): Promise<PropertyBreakdown[]> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT c."pipelineName" AS pipeline,
           c."stageName"    AS bucket,
           COUNT(*) FILTER (WHERE c."sourceId" IS NOT NULL)            AS from_ads,
           COUNT(*)                                                     AS all_leads,
           COUNT(*) FILTER (WHERE c."sourceId" IS NOT NULL AND b.booked) AS booked_from_ads,
           COUNT(*) FILTER (WHERE b.booked)                             AS booked_all
      FROM "WhatsAppConversation" c
      -- Ever booked. One booking per guest per hotel (it is keyed on the phone
      -- hash), so EXISTS cannot double-count. Cancelled and refunded bookings do
      -- not count as booked.
      CROSS JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1 FROM "Booking" bk
           WHERE bk."agencyId" = c."agencyId"
             AND bk."hotelClientId" = c."hotelClientId"
             AND bk.provider = 'kraya'
             AND bk."guestPhoneHash" = c."phoneHash"
             AND bk.status NOT IN ('CANCELLED', 'REFUNDED')
        ) AS booked
      ) b
     WHERE c."agencyId" = ${agencyId}
       AND c."hotelClientId" = ${hotelClientId}
       AND c."firstMessageAt" >= ${since}
       AND c."firstMessageAt" <= ${until}
     GROUP BY c."pipelineName", c."stageName"`;

  return shapeBreakdown(
    rows.map((r) => ({
      pipeline: r.pipeline,
      bucket: r.bucket,
      fromAds: Number(r.from_ads),
      all: Number(r.all_leads),
      bookedFromAds: Number(r.booked_from_ads),
      bookedAll: Number(r.booked_all),
    })),
  );
}
