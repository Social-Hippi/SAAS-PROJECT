import "./load-env";
import { prisma } from "../lib/prisma";

// One-off agreed with the owner on 2026-06-06: delete the duplicate, empty
// "NEELAKURINIJI" hotel (created 09:39, never mapped to an ad account). The
// real hotel cmq2667w0000304ky0316umy0 (365 ad snapshots) is untouched.
// Aborts unless the target is verifiably empty.

const DUPLICATE_ID = "cmq25vq3x000004kyk1mt5su2";

async function main() {
  const hotel = await prisma.hotelClient.findUnique({
    where: { id: DUPLICATE_ID },
    select: { id: true, name: true, metaAdAccountId: true },
  });
  if (!hotel) {
    console.log("Duplicate hotel not found — nothing to do.");
    return;
  }

  const [ads, events, content, social, posts, ga] = await Promise.all([
    prisma.adSnapshot.count({ where: { hotelClientId: hotel.id } }),
    prisma.trackingEvent.count({ where: { hotelClientId: hotel.id } }),
    prisma.contentPiece.count({ where: { hotelClientId: hotel.id } }),
    prisma.socialSnapshot.count({ where: { hotelClientId: hotel.id } }),
    prisma.postSnapshot.count({ where: { hotelClientId: hotel.id } }),
    prisma.gaSnapshot.count({ where: { hotelClientId: hotel.id } }),
  ]);
  const total = ads + events + content + social + posts + ga;
  if (hotel.metaAdAccountId || total > 0) {
    throw new Error(
      `SAFETY ABORT: hotel "${hotel.name}" is not empty ` +
        `(adAcct=${hotel.metaAdAccountId}, rows=${total}) — refusing to delete.`,
    );
  }

  await prisma.hotelClient.delete({ where: { id: hotel.id } });
  console.log(`✅ Deleted empty duplicate hotel "${hotel.name}" (${hotel.id}).`);

  const remaining = await prisma.hotelClient.findMany({
    select: { id: true, name: true, metaAdAccountId: true },
  });
  console.log("Remaining hotels:");
  for (const h of remaining) console.log(`  ${h.id} "${h.name}" adAcct=${h.metaAdAccountId ?? "none"}`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
