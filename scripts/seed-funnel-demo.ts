import "./load-env";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { STAGES, SENSIBLE_DEFAULTS, stageRank, type FunnelStage } from "@/lib/funnel";

// Seeds a realistic demo funnel for local preview of the Phase 2 "Funnel Analysis"
// section. Creates DEMO-marked Sessions (+ StageReached + a few conversions) for a
// hotel so the funnel/drop-off/revenue render. Visitor ids are prefixed
// "vis_DEMO_" so the data is trivial to purge:
//
//   npx tsx scripts/seed-funnel-demo.ts <hotelName>   # default: novotel
//   npx tsx scripts/seed-funnel-demo.ts <hotelName> --clean   # remove demo data
//
// Demo data is additive + reversible — delete it any time with --clean.

const DEMO_PREFIX = "vis_DEMO_";
const DAY_MS = 86_400_000;

// Exit pages per stage so the "top drop-off pages" table has variety.
const EXIT_PAGES: Record<FunnelStage, string[]> = {
  awareness: ["/", "/about", "/gallery"],
  consideration: ["/rooms/deluxe", "/rooms/suite", "/rooms"],
  intent: ["/book/details", "/book/guests", "/book"],
  booking: ["/thank-you"],
};
// How many sessions get STUCK at each stage (deepest = that stage).
const STUCK_AT: Record<FunnelStage, number> = {
  awareness: 40,
  consideration: 45,
  intent: 26,
  booking: 9,
};

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

async function main() {
  const hotelName = (process.argv[2] && !process.argv[2].startsWith("--")) ? process.argv[2] : "novotel";
  const clean = process.argv.includes("--clean");

  const hotel = await prisma.hotelClient.findFirst({
    where: { name: { equals: hotelName, mode: "insensitive" }, deletedAt: null },
    select: { id: true, name: true, agencyId: true },
  });
  if (!hotel) throw new Error(`No hotel named "${hotelName}".`);

  if (clean) {
    const sessions = await prisma.session.findMany({
      where: { hotelClientId: hotel.id, visitorId: { startsWith: DEMO_PREFIX } },
      select: { id: true },
    });
    const ids = sessions.map((s) => s.id);
    await prisma.trackingEvent.deleteMany({ where: { hotelClientId: hotel.id, sessionId: { in: ids } } });
    await prisma.session.deleteMany({ where: { id: { in: ids } } }); // cascades StageReached/PageView
    console.log(`Cleaned ${ids.length} demo sessions from ${hotel.name}.`);
    await prisma.$disconnect();
    return;
  }

  // Give the hotel sensible funnel rules (real config the agency would want).
  await prisma.hotelClient.update({
    where: { id: hotel.id },
    data: { funnelStageRules: SENSIBLE_DEFAULTS },
  });

  let made = 0, conversions = 0;
  for (const deepest of STAGES) {
    const deepRank = stageRank(deepest);
    for (let i = 0; i < STUCK_AT[deepest]; i++) {
      const sid = `sess_${randomUUID()}`;
      const vid = `${DEMO_PREFIX}${randomUUID().slice(0, 8)}`;
      // Spread across the last 7 days.
      const startedAt = new Date(Date.now() - Math.floor(Math.random() * 7) * DAY_MS - Math.floor(Math.random() * 6) * 3_600_000);
      const exitPath = pick(EXIT_PAGES[deepest], i);

      await prisma.session.create({
        data: {
          id: sid,
          visitorId: vid,
          hotelClientId: hotel.id,
          agencyId: hotel.agencyId,
          startedAt,
          endedAt: new Date(startedAt.getTime() + (deepRank + 1) * 120_000),
          landingPath: "/",
          exitPath,
          pageViewCount: deepRank + 1,
          totalTimeMs: (deepRank + 1) * 90_000,
          highestStageReached: deepest,
          utmSource: pick(["instagram", "facebook", "google", "direct"], i),
        },
      });

      // StageReached for every stage up to the deepest, staggered ~2 min apart.
      await prisma.stageReached.createMany({
        data: STAGES.slice(0, deepRank).map((stage, k) => ({
          sessionId: sid,
          visitorId: vid,
          hotelClientId: hotel.id,
          agencyId: hotel.agencyId,
          stage,
          reachedAt: new Date(startedAt.getTime() + k * 120_000 + Math.floor(Math.random() * 60_000)),
        })),
        skipDuplicates: true,
      });

      // Booking sessions convert with revenue.
      if (deepest === "booking") {
        await prisma.trackingEvent.create({
          data: {
            agencyId: hotel.agencyId,
            hotelClientId: hotel.id,
            eventType: "conversion",
            pageUrl: "https://hotel.example/thank-you",
            sessionId: sid,
            visitorId: vid,
            deviceType: "desktop",
            conversionValue: (24000 + Math.floor(Math.random() * 30000)).toFixed(2),
          },
        });
        conversions += 1;
      }
      made += 1;
    }
  }

  console.log(`Seeded ${made} demo sessions (${conversions} conversions) into ${hotel.name} (${hotel.id}).`);
  console.log(`Preview: /agency/hotel/${hotel.id}/journeys`);
  console.log(`Purge later: npx tsx scripts/seed-funnel-demo.ts ${hotelName} --clean`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
