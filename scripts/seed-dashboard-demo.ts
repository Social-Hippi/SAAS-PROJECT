import "./load-env";
import { prisma } from "../lib/prisma";
import { buildUtmLink, utmContentFor } from "../lib/utm";

// Seeds realistic DEMO data for the per-hotel attribution dashboard so all four
// sections (KPIs, content, paid ads, influencer) are populated for testing.
//
// Usage:
//   npm run seed:dashboard-demo            # newest hotel client
//   npm run seed:dashboard-demo -- <hotelId>
//
// Idempotent: it removes its own demo rows first (demo content is prefixed
// "[demo]"; demo ad snapshots use metaAccountId "act_demo_000"), so real data
// is never touched and re-runs don't pile up.

const DEMO_PREFIX = "[demo] ";
const DEMO_AD_ACCOUNT = "act_demo_000";
const WINDOW_DAYS = 60;
const DAY_MS = 86_400_000;

const rnd = (min: number, max: number) => min + Math.random() * (max - min);
const rndInt = (min: number, max: number) => Math.floor(rnd(min, max + 1));
const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
const dateOnly = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const DEMO_CONTENT = [
  { title: "Sunset Reels", contentType: "organic", platform: "instagram", sessions: 420, convRate: 0.03 },
  { title: "Summer Flash Sale", contentType: "paid_ad", platform: "facebook", sessions: 640, convRate: 0.05 },
  { title: "Spa Weekend Ads", contentType: "paid_ad", platform: "instagram", sessions: 320, convRate: 0.045 },
  {
    title: "Collab with Mia",
    contentType: "influencer",
    platform: "instagram",
    sessions: 260,
    convRate: 0.04,
    influencerName: "Mia Chen",
    couponCode: "MIA15",
  },
] as const;

async function main() {
  const hotelId = process.argv[2];
  const hotel = hotelId
    ? await prisma.hotelClient.findUnique({ where: { id: hotelId } })
    : await prisma.hotelClient.findFirst({ orderBy: { createdAt: "desc" } });

  if (!hotel) {
    console.error(
      "No hotel client found. Create one in the app first (or pass a hotel id).",
    );
    process.exit(1);
  }
  const { id: hid, agencyId } = hotel;
  console.log(`Seeding demo data for hotel "${hotel.name}" (${hid})…`);

  // ── Clean up previous demo rows for this hotel ──
  const oldDemo = await prisma.contentPiece.findMany({
    where: { hotelClientId: hid, title: { startsWith: DEMO_PREFIX } },
    select: { id: true },
  });
  const oldKeys = oldDemo.map((c) => utmContentFor(c.id));
  if (oldKeys.length > 0) {
    await prisma.trackingEvent.deleteMany({
      where: { hotelClientId: hid, utmContent: { in: oldKeys } },
    });
  }
  // CouponRedemptions cascade when their content piece is deleted.
  await prisma.contentPiece.deleteMany({
    where: { hotelClientId: hid, title: { startsWith: DEMO_PREFIX } },
  });
  await prisma.adSnapshot.deleteMany({
    where: { hotelClientId: hid, metaAccountId: DEMO_AD_ACCOUNT },
  });

  const destination = `${hotel.websiteUrl.replace(/\/$/, "")}/rooms`;

  // ── Content pieces + their tracking events ──
  let eventCount = 0;
  let conversionCount = 0;
  const redemptionsToCreate: {
    agencyId: string;
    contentPieceId: string;
    redemptionDate: Date;
    orderValue: string;
  }[] = [];

  for (const spec of DEMO_CONTENT) {
    const title = `${DEMO_PREFIX}${spec.title}`;
    const created = await prisma.contentPiece.create({
      data: {
        agencyId,
        hotelClientId: hid,
        title,
        contentType: spec.contentType,
        platform: spec.platform,
        destinationUrl: destination,
        utmLink: "",
        influencerName: "influencerName" in spec ? spec.influencerName : null,
        couponCode: "couponCode" in spec ? spec.couponCode : null,
      },
      select: { id: true },
    });
    const utmLink = buildUtmLink({
      destinationUrl: destination,
      source: spec.platform,
      medium: spec.contentType,
      title,
      contentPieceId: created.id,
      agencyId,
    });
    await prisma.contentPiece.update({
      where: { id: created.id },
      data: { utmLink },
    });

    const utmContent = utmContentFor(created.id);
    const campaign = new URL(utmLink).searchParams.get("utm_campaign");
    const events: {
      agencyId: string;
      hotelClientId: string;
      eventType: "visit" | "conversion";
      utmSource: string;
      utmMedium: string;
      utmCampaign: string | null;
      utmContent: string;
      utmTerm: string;
      pageUrl: string;
      conversionValue: string | null;
      sessionId: string;
      deviceType: string;
      createdAt: Date;
    }[] = [];

    for (let i = 0; i < spec.sessions; i++) {
      const at = daysAgo(rnd(0, WINDOW_DAYS));
      const sessionId = uid();
      const device = ["desktop", "mobile", "tablet"][rndInt(0, 2)];
      const common = {
        agencyId,
        hotelClientId: hid,
        utmSource: spec.platform,
        utmMedium: spec.contentType,
        utmCampaign: campaign,
        utmContent,
        utmTerm: agencyId,
        pageUrl: destination,
        sessionId,
        deviceType: device,
      };
      events.push({
        ...common,
        eventType: "visit",
        conversionValue: null,
        createdAt: at,
      });
      if (Math.random() < spec.convRate) {
        const value = rnd(180, 620);
        events.push({
          ...common,
          eventType: "conversion",
          conversionValue: value.toFixed(2),
          // a little after the visit, same session
          createdAt: new Date(at.getTime() + rndInt(1, 30) * 60_000),
        });
        conversionCount++;
        if ("couponCode" in spec) {
          redemptionsToCreate.push({
            agencyId,
            contentPieceId: created.id,
            redemptionDate: at,
            orderValue: value.toFixed(2),
          });
        }
      }
    }

    await prisma.trackingEvent.createMany({ data: events });
    eventCount += events.length;
  }

  if (redemptionsToCreate.length > 0) {
    await prisma.couponRedemption.createMany({ data: redemptionsToCreate });
  }

  // ── Daily Meta ad snapshots over the window ──
  const snapshots = [];
  for (let d = 0; d < WINDOW_DAYS; d++) {
    const spend = rnd(35, 140);
    const impressions = rndInt(4000, 22000);
    const clicks = rndInt(80, 600);
    const conversions = rndInt(0, 6);
    const roas = rnd(1.8, 5.5);
    snapshots.push({
      agencyId,
      hotelClientId: hid,
      metaAccountId: DEMO_AD_ACCOUNT,
      date: dateOnly(daysAgo(d)),
      spend: spend.toFixed(2),
      impressions,
      reach: Math.round(impressions * rnd(0.6, 0.85)),
      clicks,
      ctr: Number(((clicks / impressions) * 100).toFixed(4)),
      cpc: (spend / Math.max(clicks, 1)).toFixed(4),
      cpm: ((spend / impressions) * 1000).toFixed(4),
      conversions,
      roas: Number(roas.toFixed(2)),
      pixelPurchases: conversions,
      pixelLeads: rndInt(0, 10),
      pixelPageViews: rndInt(50, 400),
    });
  }
  await prisma.adSnapshot.createMany({ data: snapshots });

  console.log(
    `Done: ${DEMO_CONTENT.length} content pieces, ${eventCount} tracking events ` +
      `(${conversionCount} bookings), ${snapshots.length} ad snapshots, ` +
      `${redemptionsToCreate.length} coupon redemptions.`,
  );
  console.log(`\nOpen the dashboard at:  /agency/hotel/${hid}\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
