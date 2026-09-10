import "./load-env";
import { prisma } from "../lib/prisma";

// READ-ONLY: definitively settle whether an InstagramConnection for "cea_iitm"
// exists in the DB this app talks to. Raw SQL (bypasses any model-level
// scoping) + which DB host we're on.

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? "";
  const host = dbUrl.match(/@([^/:?]+)/)?.[1] ?? "unknown";
  const dbName = dbUrl.match(/\/([^/?]+)(\?|$)/)?.[1] ?? "?";
  console.log(`DB host: ${host}  db: ${dbName}\n`);

  // Raw count + raw search, so nothing in the Prisma model layer can hide rows.
  const total = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    'SELECT COUNT(*)::bigint AS n FROM "InstagramConnection"',
  );
  console.log("InstagramConnection total rows (raw SQL):", Number(total[0].n));

  const matches = await prisma.$queryRawUnsafe<
    Array<{ id: string; igUserId: string; username: string | null; status: string; tokenType: string; hotelClientId: string; createdAt: Date }>
  >(
    `SELECT "id","igUserId","username","status","tokenType","hotelClientId","createdAt"
     FROM "InstagramConnection"
     WHERE "username" ILIKE '%cea_iitm%' OR "igUserId" ILIKE '%cea_iitm%'`,
  );
  console.log(`\nRows matching "cea_iitm": ${matches.length}`);
  for (const m of matches) console.log("  ", JSON.stringify(m));

  // Also list every row regardless of filters, so we see deprecated_eaa etc.
  const all = await prisma.$queryRawUnsafe<
    Array<{ igUserId: string; username: string | null; status: string; tokenType: string; createdAt: Date }>
  >(
    `SELECT "igUserId","username","status","tokenType","createdAt"
     FROM "InstagramConnection" ORDER BY "createdAt" DESC`,
  );
  console.log(`\nALL InstagramConnection rows (${all.length}):`);
  for (const r of all) console.log("  ", JSON.stringify(r));

  // Is there a hotel named/identified cea_iitm? (maybe the IG is on a hotel.)
  const hotels = await prisma.$queryRawUnsafe<
    Array<{ id: string; name: string }>
  >(`SELECT "id","name" FROM "HotelClient" WHERE "name" ILIKE '%cea%' OR "id" ILIKE '%cea%'`);
  console.log(`\nHotels matching "cea": ${hotels.length}`);
  for (const h of hotels) console.log("  ", JSON.stringify(h));
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
