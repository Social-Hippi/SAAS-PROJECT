import "./load-env";
import { prisma } from "../lib/prisma";

// One-off: list Coastal Digital's hotels, then create a new "Rishikesh Riverside
// Camp" under it if one doesn't already exist. Prints the new hotel id so the
// existing demo seeders (seed:dashboard-demo, seed:social-demo) can target it.

const COASTAL_ID = "cmpo1h4fk0000kcil074608rj";

async function main() {
  const agency = await prisma.agency.findUnique({
    where: { id: COASTAL_ID },
    select: { id: true, name: true },
  });
  if (!agency) {
    console.error(`Coastal Digital not found (${COASTAL_ID}).`);
    process.exit(1);
  }
  console.log(`Agency: ${agency.name}\n`);

  const existing = await prisma.hotelClient.findMany({
    where: { agencyId: agency.id },
    select: { id: true, name: true, websiteUrl: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`Existing hotels in ${agency.name}:`);
  for (const h of existing) console.log(`  ${h.id}  ${h.name}  ${h.websiteUrl}`);

  // Avoid creating a duplicate if it's already there.
  const already = existing.find((h) => /rishikesh/i.test(h.name));
  if (already) {
    console.log(`\nRishikesh already exists in this agency: ${already.id}`);
    return;
  }

  const hotel = await prisma.hotelClient.create({
    data: {
      agencyId: agency.id,
      name: "Rishikesh Riverside Camp",
      websiteUrl: "https://rishikeshriverside.example.com",
      contactName: "Aarav Sharma",
      contactEmail: "aarav@rishikeshriverside.example.com",
      conversionMethod: "url_change",
      thankYouUrlPattern: "/booking-confirmed",
      snippetStatus: "live",
    },
    select: { id: true, name: true, siteId: true },
  });

  console.log(
    `\nCreated ${hotel.name}\n` +
      `  hotel id:  ${hotel.id}\n` +
      `  site id:   ${hotel.siteId}\n\n` +
      `Now seed it:\n` +
      `  npm run seed:dashboard-demo -- ${hotel.id}\n` +
      `  npm run seed:social-demo -- ${hotel.id}\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
