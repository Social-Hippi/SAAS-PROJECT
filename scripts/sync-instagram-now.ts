import "./load-env";
import { prisma } from "../lib/prisma";
import { syncInstagramConnection } from "../lib/instagram-sync";

// Manually trigger the IGAA sync for one connection (default: the cea_iitm
// account) and print the result + resulting row counts. Runs the SAME engine
// the cron/button use, so it exercises the fixed metric lists end-to-end.
//
//   npx tsx scripts/sync-instagram-now.ts [username-substring]

const ymd = (d: Date | null) => (d ? d.toISOString() : "null");

async function main() {
  const needle = process.argv[2] ?? "cea_iitm";
  const conn = await prisma.instagramConnection.findFirst({
    where: { username: { contains: needle }, tokenType: "igaa_direct" },
    select: { id: true, agencyId: true, hotelClientId: true, igUserId: true, username: true, status: true },
  });
  if (!conn) {
    console.error(`No igaa_direct connection matching "${needle}".`);
    process.exit(1);
  }
  console.log(`Syncing @${conn.username} (${conn.igUserId}) — status before: ${conn.status}\n`);

  const res = await syncInstagramConnection(
    { id: conn.id, agencyId: conn.agencyId, hotelClientId: conn.hotelClientId, igUserId: conn.igUserId },
    { days: 30, perRequestDelayMs: 0 },
  );
  console.log("Sync result:", JSON.stringify(res));

  const [after, social, post, latestSocial, latestPost] = await Promise.all([
    prisma.instagramConnection.findUnique({
      where: { id: conn.id },
      select: { status: true, lastSyncedAt: true, errorMessage: true },
    }),
    prisma.socialSnapshot.count({ where: { hotelClientId: conn.hotelClientId } }),
    prisma.postSnapshot.count({ where: { hotelClientId: conn.hotelClientId } }),
    prisma.socialSnapshot.findFirst({
      where: { hotelClientId: conn.hotelClientId },
      orderBy: { date: "desc" },
      select: { date: true, followers: true, reach: true, profileViews: true },
    }),
    prisma.postSnapshot.findFirst({
      where: { hotelClientId: conn.hotelClientId },
      orderBy: { fetchedAt: "desc" },
      select: { mediaType: true, likes: true, comments: true, reach: true, impressions: true, saves: true },
    }),
  ]);

  console.log("\nConnection after:", JSON.stringify({ ...after, lastSyncedAt: ymd(after?.lastSyncedAt ?? null) }));
  console.log("SocialSnapshot rows:", social, latestSocial ? `| latest ${JSON.stringify({ ...latestSocial, date: ymd(latestSocial.date) })}` : "");
  console.log("PostSnapshot rows:  ", post, latestPost ? `| latest ${JSON.stringify(latestPost)}` : "");
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
