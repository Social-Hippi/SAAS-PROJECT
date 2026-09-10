import "./load-env";
import { prisma } from "../lib/prisma";

// Read-only inventory of every agency/hotel and its row counts, used to scope
// the demo-data cleanup. Deletes nothing.

async function main() {
  const agencies = await prisma.agency.findMany({
    select: { id: true, name: true, email: true, plan: true, subscriptionStatus: true },
  });

  for (const a of agencies) {
    const members = await prisma.agencyMember.findMany({
      where: { agencyId: a.id },
      select: { email: true },
    });
    const [token, ig, ga] = await Promise.all([
      prisma.metaToken.count({ where: { agencyId: a.id } }),
      prisma.instagramConnection.count({ where: { agencyId: a.id } }),
      prisma.googleAnalyticsConnection.count({ where: { agencyId: a.id } }),
    ]);
    console.log(
      `\nAGENCY: ${a.name} | ${a.email} | plan=${a.plan}/${a.subscriptionStatus} | members=[${members.map((m) => m.email).join(", ")}] | metaTokens=${token} igConns=${ig} gaConns=${ga}`,
    );

    const hotels = await prisma.hotelClient.findMany({
      where: { agencyId: a.id },
      select: { id: true, name: true, websiteUrl: true, metaAdAccountId: true },
    });
    for (const h of hotels) {
      const w = { hotelClientId: h.id };
      const [ads, social, posts, stories, events, content, redemptions, reports, gaSnaps] =
        await Promise.all([
          prisma.adSnapshot.count({ where: w }),
          prisma.socialSnapshot.count({ where: w }),
          prisma.postSnapshot.count({ where: w }),
          prisma.storySnapshot.count({ where: w }),
          prisma.trackingEvent.count({ where: w }),
          prisma.contentPiece.count({ where: w }),
          // Redemptions hang off the content piece, not the hotel directly.
          prisma.couponRedemption.count({ where: { contentPiece: { hotelClientId: h.id } } }),
          prisma.report.count({ where: w }),
          prisma.gaSnapshot.count({ where: w }),
        ]);
      console.log(
        `  HOTEL: ${h.name} | ${h.websiteUrl} | adAcct=${h.metaAdAccountId ?? "none"}\n` +
          `    adSnapshots=${ads} socialSnapshots=${social} posts=${posts} stories=${stories} trackingEvents=${events} contentPieces=${content} couponRedemptions=${redemptions} reports=${reports} gaSnapshots=${gaSnaps}`,
      );
    }
    if (hotels.length === 0) console.log("  (no hotels)");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
