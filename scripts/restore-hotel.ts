import "./load-env";
import { prisma } from "../lib/prisma";
import { restoreHotelCore } from "../lib/hotel-delete";

// Manually restore a soft-deleted hotel from the command line — the platform
// owner's recovery path for early customers, before a self-service restore UI
// exists. (The restoreHotel server action needs a Clerk session, so the CLI uses
// the shared core directly, acting as an admin of the owning agency.)
//
// Usage:  npx tsx scripts/restore-hotel.ts <hotelClientId>

async function main() {
  const hotelClientId = process.argv[2];
  if (!hotelClientId) {
    console.error("Usage: npx tsx scripts/restore-hotel.ts <hotelClientId>");
    process.exit(1);
  }

  // Cross-agency lookup is fine here — this is an out-of-band admin tool.
  const hotel = await prisma.hotelClient.findUnique({
    where: { id: hotelClientId },
    select: { id: true, name: true, agencyId: true, deletedAt: true },
  });
  if (!hotel) {
    console.error(`Hotel ${hotelClientId} not found.`);
    process.exit(1);
  }
  if (!hotel.deletedAt) {
    console.log(`Hotel "${hotel.name}" (${hotel.id}) is already active — nothing to do.`);
    return;
  }

  await restoreHotelCore(
    { agencyId: hotel.agencyId, memberId: "cli", role: "admin" },
    hotel.id,
  );
  console.log(`Restored hotel "${hotel.name}" (${hotel.id}). deletedAt cleared; data flowing again on next sync.`);
}

main()
  .catch((e) => {
    console.error("Restore failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
