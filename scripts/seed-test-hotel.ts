
import "./load-env";
import { prisma } from "../lib/prisma";

// Creates (or updates) a known test agency + hotel so the local tracking test
// page has a stable siteId to point at. Run with: npm run seed:test-hotel

const SITE_ID = "test-site-hoteltrack";

async function main() {
  let agency = await prisma.agency.findFirst({
    where: { email: "test@hoteltrack.local" },
  });
  if (!agency) {
    agency = await prisma.agency.create({
      data: { name: "Test Agency", email: "test@hoteltrack.local" },
    });
  }

  const config = {
    conversionMethod: "both" as const,
    thankYouUrlPattern: "/thank-you",
    successPhrase: "Booking confirmed",
    successSelector: "#booking-confirmation",
  };

  const hotel = await prisma.hotelClient.upsert({
    where: { siteId: SITE_ID },
    update: config,
    create: {
      agencyId: agency.id,
      name: "Test Hotel",
      websiteUrl: "http://localhost",
      contactName: "Test Contact",
      contactEmail: "hotel@hoteltrack.local",
      siteId: SITE_ID,
      ...config,
    },
  });

  console.log("✅ Test hotel ready");
  console.log("   siteId:           ", hotel.siteId);
  console.log("   conversionMethod: ", hotel.conversionMethod);
  console.log("   thankYouUrlPattern:", hotel.thankYouUrlPattern);
  console.log("   successPhrase:    ", hotel.successPhrase);
  console.log("   successSelector:  ", hotel.successSelector);
  console.log("\nOpen the test page (use the port your dev server prints):");
  console.log("   http://localhost:3000/test-tracking.html");

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
