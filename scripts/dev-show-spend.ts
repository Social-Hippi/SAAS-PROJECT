import "./load-env";
import { prisma } from "../lib/prisma";

// DEV ONLY: toggle a hotel's showAdSpendToHotel flag, which is the one thing that
// legitimately changes what the public /share/<uuid> report shows. Flipping it on
// and reloading is how you check that the spend gate actually gates.
//
//   npm run dev:show-spend -- <hotelId>        # turn it ON
//   npm run dev:show-spend -- <hotelId> off    # turn it OFF

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: npm run dev:show-spend -- <hotelId> [off]");
    process.exitCode = 1;
    return;
  }
  const on = (process.argv[3] ?? "on").toLowerCase() !== "off";
  const hotel = await prisma.hotelClient.update({
    where: { id },
    data: { showAdSpendToHotel: on },
    select: { name: true, showAdSpendToHotel: true },
  });
  console.log(`${hotel.name}: ad spend ${hotel.showAdSpendToHotel ? "SHOWN to" : "hidden from"} the share link.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
