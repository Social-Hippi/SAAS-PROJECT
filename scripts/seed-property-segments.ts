// Seed Aster Holidays' two property segments.
//
// Idempotent: upserts on (hotelClientId, slug), so re-running never duplicates
// and never overwrites rules an admin has since corrected by hand — only the
// routing fields (workbook, tab, layout) are refreshed.
//
// ONLY CONFIRMED RULES ARE SEEDED. Coffeeberry Hills gets its booking host,
// which is proven by the one real conversion; Three Hills gets the page prefix
// confirmed present in recorded traffic. The two unknowns — Three Hills' booking
// engine hostname, and any CBH page prefixes — are left EMPTY rather than
// guessed. An empty rule set matches nothing, so that traffic falls to
// Unassigned, which is rendered as its own visible row. A guessed prefix would
// instead put real visits under the wrong property, silently.
//
//   npx tsx scripts/seed-property-segments.ts [--hotel <id>] [--agency <id>]

import "./load-env";
import { prisma } from "../lib/prisma";

const args = process.argv.slice(2);
const argOf = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
};

const HOTEL_ID = argOf("--hotel") ?? "cmru6bnmo000004l6yl2ryzh9"; // Aster Holidays
const AGENCY_ID = argOf("--agency") ?? "cmr3jr4ni000004i5mzd380hb";

const SEGMENTS = [
  {
    slug: "coffeeberry-hills",
    name: "Coffeeberry Hills",
    displayOrder: 1,
    // Confirmed by the ₹7,475 conversion on 8 Sep 2026.
    bookingHosts: ["bookings.coffeeberryhills.in"],
    pathPrefixes: [] as string[], // unknown — admin-fillable
    sourceSheetId: "1udjgKPY6i5piW627rwV_bWDvp5mjquHTNn_b4I7_QD0",
    sourceTabName: "Aster | Call Reports Tracker",
    trackerLayout: "cbh_v1",
  },
  {
    slug: "three-hills",
    name: "Three Hills",
    displayOrder: 2,
    bookingHosts: [] as string[], // unknown — see Open Decisions
    // Confirmed present in recorded traffic.
    pathPrefixes: ["/three-hills-coorg-resort"],
    sourceSheetId: "143UeHzcX7kJalj1-ar838cPiYt_9CaR3nbsUSW7pw7U",
    sourceTabName: "3hills tracker",
    trackerLayout: "three_hills_v1",
  },
];

async function main() {
  const hotel = await prisma.hotelClient.findUnique({
    where: { id: HOTEL_ID },
    select: { id: true, name: true, agencyId: true },
  });
  if (!hotel) {
    console.error(`Hotel ${HOTEL_ID} not found in this database. Nothing seeded.`);
    process.exitCode = 1;
    return;
  }
  if (hotel.agencyId !== AGENCY_ID) {
    console.error(
      `Hotel ${HOTEL_ID} belongs to agency ${hotel.agencyId}, not ${AGENCY_ID}. Refusing to seed ` +
        `across tenants.`,
    );
    process.exitCode = 1;
    return;
  }

  for (const seg of SEGMENTS) {
    const row = await prisma.propertySegment.upsert({
      where: { hotelClientId_slug: { hotelClientId: hotel.id, slug: seg.slug } },
      create: {
        agencyId: hotel.agencyId,
        hotelClientId: hotel.id,
        name: seg.name,
        slug: seg.slug,
        displayOrder: seg.displayOrder,
        pathPrefixes: seg.pathPrefixes,
        bookingHosts: seg.bookingHosts,
        sourceSheetId: seg.sourceSheetId,
        sourceTabName: seg.sourceTabName,
        trackerLayout: seg.trackerLayout,
      },
      // Refresh routing only. Matching rules are left alone so a hand-correction
      // survives a re-run.
      update: {
        name: seg.name,
        displayOrder: seg.displayOrder,
        sourceSheetId: seg.sourceSheetId,
        sourceTabName: seg.sourceTabName,
        trackerLayout: seg.trackerLayout,
      },
      select: { id: true, name: true, pathPrefixes: true, bookingHosts: true },
    });
    console.log(
      `${row.name}: paths=[${row.pathPrefixes.join(", ")}] hosts=[${row.bookingHosts.join(", ")}]`,
    );
  }

  console.log(`\nSeeded ${SEGMENTS.length} segments for ${hotel.name}.`);
  console.log("Unknown rules left empty on purpose — unmatched traffic shows as Unassigned.");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
