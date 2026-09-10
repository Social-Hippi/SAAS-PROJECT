import "./load-env";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

// Seeds the Part 7 sample bookings (total ₹95,500 across 5 bookings) for ONE
// hotel so the Revenue by Source section renders populated — for screenshots /
// manual QA. Idempotent: re-running first clears its own rows (sessionId prefix
// `rbsdemo_`). Usage:  npx tsx scripts/seed-revenue-demo.ts [hotelId]
//
// Does NOT touch conversion-capture logic; it just writes conversion
// TrackingEvent rows the same shape the snippet would.

const PREFIX = "rbsdemo_";

const SAMPLE: { utm: { source?: string; medium?: string; campaign?: string; content?: string }; value: number }[] = [
  { utm: { source: "instagram", medium: "reel", campaign: "monsoon" }, value: 15000 },
  { utm: { source: "instagram", medium: "story", campaign: "influencer", content: "priya" }, value: 8500 },
  { utm: { source: "facebook", medium: "cpc", campaign: "monsoon" }, value: 25000 },
  { utm: { source: "google", medium: "cpc", campaign: "brand" }, value: 42000 },
  { utm: {}, value: 5000 }, // direct, no UTM
];

async function main() {
  const hotelId = process.argv[2];
  const hotel = hotelId
    ? await prisma.hotelClient.findUnique({ where: { id: hotelId } })
    : await prisma.hotelClient.findFirst({ orderBy: { createdAt: "desc" } });
  if (!hotel) throw new Error("No hotel found. Pass a hotelId or create a hotel first.");
  const { id: hid, agencyId } = hotel;

  const removed = await prisma.trackingEvent.deleteMany({
    where: { hotelClientId: hid, sessionId: { startsWith: PREFIX } },
  });

  // Spread across the last few days so the daily chart + sparklines have shape.
  let i = 0;
  for (const s of SAMPLE) {
    await prisma.trackingEvent.create({
      data: {
        agencyId,
        hotelClientId: hid,
        eventType: "conversion",
        utmSource: s.utm.source ?? null,
        utmMedium: s.utm.medium ?? null,
        utmCampaign: s.utm.campaign ?? null,
        utmContent: s.utm.content ?? null,
        pageUrl: `${hotel.websiteUrl.replace(/\/$/, "")}/thank-you`,
        conversionValue: s.value.toFixed(2),
        sessionId: `${PREFIX}${randomUUID()}`,
        deviceType: "desktop",
        createdAt: new Date(Date.now() - i * 86_400_000),
      },
    });
    i += 1;
  }

  const total = SAMPLE.reduce((a, s) => a + s.value, 0);
  console.log(`Seeded ${SAMPLE.length} sample bookings (₹${total.toLocaleString("en-IN")}) for "${hotel.name}" (${hid}); cleared ${removed.count} previous.`);
  console.log(`Remove later: prisma.trackingEvent.deleteMany({ where: { hotelClientId: "${hid}", sessionId: { startsWith: "${PREFIX}" } } })`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
