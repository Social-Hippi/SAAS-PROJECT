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
// Matching rules are PRESERVED on re-run by default, so a hand-correction made
// in the admin surface is not silently reverted by a redeploy. Pass
// --update-rules to overwrite them from this file — which is what to do when the
// rules here have been corrected centrally, as they were once the production
// path inventory resolved the prefixes.
//
//   npx tsx scripts/seed-property-segments.ts [--hotel <id>] [--agency <id>] [--update-rules]

import "./load-env";
import { prisma } from "../lib/prisma";

const args = process.argv.slice(2);
const argOf = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
};

const UPDATE_RULES = args.includes("--update-rules");
const HOTEL_ID = argOf("--hotel") ?? "cmru6bnmo000004l6yl2ryzh9"; // Aster Holidays
const AGENCY_ID = argOf("--agency") ?? "cmr3jr4ni000004i5mzd380hb";

const SEGMENTS = [
  {
    slug: "coffeeberry-hills",
    name: "Coffeeberry Hills",
    displayOrder: 1,
    // Confirmed by the ₹7,475 conversion on 8 Sep 2026.
    bookingHosts: ["bookings.coffeeberryhills.in"],
    // Resolved from the production path inventory over 90 days. Prefix matching
    // catches gallery pages, the ads landing page and #rooms anchors.
    pathPrefixes: ["/coffeeberry-hills"],
    sourceSheetId: "1udjgKPY6i5piW627rwV_bWDvp5mjquHTNn_b4I7_QD0",
    sourceTabName: "Aster | Call Reports Tracker",
    trackerLayout: "cbh_v1",
  },
  {
    slug: "three-hills",
    name: "Three Hills",
    displayOrder: 2,
    bookingHosts: [] as string[], // unknown — see Open Decisions
    // Both spellings appear in recorded traffic.
    pathPrefixes: ["/three-hills", "/3hills"],
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
      // Routing always refreshes. Matching rules only with --update-rules, so a
      // hand-correction is not silently reverted by an ordinary re-run.
      update: {
        name: seg.name,
        displayOrder: seg.displayOrder,
        sourceSheetId: seg.sourceSheetId,
        sourceTabName: seg.sourceTabName,
        trackerLayout: seg.trackerLayout,
        ...(UPDATE_RULES
          ? { pathPrefixes: seg.pathPrefixes, bookingHosts: seg.bookingHosts }
          : {}),
      },
      select: { id: true, name: true, pathPrefixes: true, bookingHosts: true },
    });
    console.log(
      `${row.name}: paths=[${row.pathPrefixes.join(", ")}] hosts=[${row.bookingHosts.join(", ")}]`,
    );
  }

  console.log(`\nSeeded ${SEGMENTS.length} segments for ${hotel.name}.`);
  if (!UPDATE_RULES) {
    console.log("Matching rules were PRESERVED. Re-run with --update-rules to overwrite them.");
  }
  console.log(
    "Three Hills' booking hostname is still unknown and stays empty — its conversions fall to " +
      "Unassigned until someone supplies it.",
  );
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
