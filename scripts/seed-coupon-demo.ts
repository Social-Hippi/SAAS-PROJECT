import "./load-env";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

// Seeds Phase R2 influencer/coupon demo data for ONE hotel so the Influencers &
// Coupons admin, the Influencer Performance section, and the influencer row in
// Revenue by Source render populated — for screenshots / manual QA. Idempotent:
// re-running clears its own rows (influencer names prefixed `R2DEMO ·`).
// Usage:  npx tsx scripts/seed-coupon-demo.ts [hotelId]

const NAME_PREFIX = "R2DEMO · ";
const SESS_PREFIX = "r2demo_";
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

async function main() {
  const hotelId = process.argv[2];
  const hotel = hotelId
    ? await prisma.hotelClient.findUnique({ where: { id: hotelId } })
    : await prisma.hotelClient.findFirst({ orderBy: { createdAt: "desc" } });
  if (!hotel) throw new Error("No hotel found. Pass a hotelId or create a hotel first.");
  const { id: hid, agencyId } = hotel;

  // Clean previous demo rows (redemptions cascade with their coupon/influencer).
  const demoInfs = await prisma.influencer.findMany({ where: { hotelClientId: hid, name: { startsWith: NAME_PREFIX } }, select: { id: true } });
  await prisma.influencer.deleteMany({ where: { id: { in: demoInfs.map((i) => i.id) } } });
  await prisma.trackingEvent.deleteMany({ where: { hotelClientId: hid, sessionId: { startsWith: SESS_PREFIX } } });

  const personas = [
    { name: "Priya Sharma", handle: "priya", code: "PRIYA10", redemptions: [{ v: 15000, src: "snippet_auto" }, { v: 8500, src: "manual_entry", guest: "Anita R" }, { v: 22000, src: "snippet_auto" }] },
    { name: "Arjun Mehta", handle: "arjun.travels", code: "ARJUN15", redemptions: [{ v: 12000, src: "manual_entry", guest: "Vikram S" }, { v: 9500, src: "snippet_auto" }] },
    { name: "Neha Kapoor", handle: "nehaesc", code: "NEHA20", redemptions: [{ v: 31000, src: "snippet_auto" }] },
  ];

  let codes = 0, reds = 0;
  for (const p of personas) {
    const inf = await prisma.influencer.create({ data: { agencyId, hotelClientId: hid, name: NAME_PREFIX + p.name, instagramHandle: p.handle } });
    const coupon = await prisma.couponCode.create({ data: { agencyId, hotelClientId: hid, influencerId: inf.id, code: p.code, status: "ACTIVE", discountType: "percentage", discountValue: "10" } });
    codes += 1;
    let i = 0;
    for (const r of p.redemptions) {
      const when = daysAgo(1 + i);
      let trackingEventId: string | null = null;
      if (r.src === "snippet_auto") {
        const te = await prisma.trackingEvent.create({
          data: {
            agencyId, hotelClientId: hid, eventType: "conversion",
            pageUrl: `${hotel.websiteUrl.replace(/\/$/, "")}/thank-you`,
            conversionValue: r.v.toFixed(2), couponCodeUsed: p.code,
            sessionId: `${SESS_PREFIX}${randomUUID()}`, deviceType: "desktop", createdAt: when,
          },
          select: { id: true },
        });
        trackingEventId = te.id;
      }
      await prisma.influencerRedemption.create({
        data: {
          agencyId, hotelClientId: hid, couponCodeId: coupon.id, influencerId: inf.id,
          bookingValue: r.v.toFixed(2), redemptionSource: r.src, trackingEventId,
          guestName: "guest" in r ? (r as { guest: string }).guest : null,
          redeemedAt: when, bookingDate: when,
        },
      });
      reds += 1;
      i += 1;
    }
  }

  console.log(`Seeded ${personas.length} influencers, ${codes} codes, ${reds} redemptions for "${hotel.name}" (${hid}).`);
  console.log(`Remove later: delete influencers named "${NAME_PREFIX}…" + trackingEvents with sessionId "${SESS_PREFIX}…".`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
