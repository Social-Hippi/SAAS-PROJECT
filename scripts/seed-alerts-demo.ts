import "./load-env";
import { prisma } from "../lib/prisma";
import { encryptToken } from "../lib/encryption";

// Seeds deterministic conditions that fire every email alert, so you can test
// the engine end-to-end:
//
//   1. Performance drop  — a hotel whose weekly bookings fell ~75% vs last week
//   2. Snippet error     — a "live" hotel that has sent no events for 72h
//   3. Meta token expiry — the agency's Meta token set to expire in 7 days
//   4. Weekly summary    — the demo hotels give the digest something to report
//
// Usage:
//   npm run seed:alerts-demo                 # first agency
//   npm run seed:alerts-demo -- <agencyId>
//
// Then trigger the alerts (CRON_SECRET from your .env):
//   curl -H "Authorization: Bearer <CRON_SECRET>" \
//     "http://localhost:3000/api/alerts/run?force=1"
//
// Idempotent: it removes its own demo hotels (name prefix "[alert demo] ") and
// their alerts first, so real data is never touched and re-runs don't pile up.

const PREFIX = "[alert demo] ";
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const dateOnly = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

type EventSeed = {
  agencyId: string;
  hotelClientId: string;
  eventType: "visit" | "conversion";
  pageUrl: string;
  sessionId: string;
  deviceType: string;
  conversionValue: string | null;
  createdAt: Date;
};

/** Builds `count` conversion events (each preceded by a visit) within a window. */
function bookings(
  agencyId: string,
  hotelId: string,
  pageUrl: string,
  count: number,
  minDaysAgo: number,
  maxDaysAgo: number,
): EventSeed[] {
  const out: EventSeed[] = [];
  for (let i = 0; i < count; i++) {
    const at = daysAgo(minDaysAgo + Math.random() * (maxDaysAgo - minDaysAgo));
    const sessionId = uid();
    const base = {
      agencyId,
      hotelClientId: hotelId,
      pageUrl,
      sessionId,
      deviceType: ["desktop", "mobile", "tablet"][i % 3],
    };
    out.push({ ...base, eventType: "visit", conversionValue: null, createdAt: at });
    out.push({
      ...base,
      eventType: "conversion",
      conversionValue: (180 + Math.random() * 420).toFixed(2),
      createdAt: new Date(at.getTime() + 10 * 60_000),
    });
  }
  return out;
}

async function createDemoHotel(agencyId: string, name: string) {
  return prisma.hotelClient.create({
    data: {
      agencyId,
      name: `${PREFIX}${name}`,
      websiteUrl: "https://demo-hotel.example.com",
      contactName: "Demo Contact",
      contactEmail: "demo@demo-hotel.example.com",
      conversionMethod: "url_change",
      thankYouUrlPattern: "/thank-you",
    },
    select: { id: true, websiteUrl: true, name: true },
  });
}

async function main() {
  const agencyArg = process.argv[2];
  const agency = agencyArg
    ? await prisma.agency.findUnique({ where: { id: agencyArg } })
    : await prisma.agency.findFirst({ orderBy: { createdAt: "asc" } });

  if (!agency) {
    console.error("No agency found. Sign up + onboard in the app first.");
    process.exit(1);
  }
  console.log(`Seeding alert demo data for agency "${agency.name}" (${agency.id})…`);

  // ── Clean up previous demo rows (and the alerts that referenced them) ──
  const oldDemo = await prisma.hotelClient.findMany({
    where: { agencyId: agency.id, name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const oldIds = oldDemo.map((h) => h.id);
  if (oldIds.length > 0) {
    await prisma.alert.deleteMany({ where: { hotelClientId: { in: oldIds } } });
    // TrackingEvents + AdSnapshots cascade when the hotel is deleted.
    await prisma.hotelClient.deleteMany({ where: { id: { in: oldIds } } });
  }

  // ── 1) Performance drop: 20 bookings last week → 5 this week (~75% drop) ──
  const dropping = await createDemoHotel(agency.id, "Dropping Resort");
  const dest = `${dropping.websiteUrl}/rooms`;
  const events: EventSeed[] = [
    ...bookings(agency.id, dropping.id, dest, 20, 7, 14), // prior week
    ...bookings(agency.id, dropping.id, dest, 5, 0, 7), //  this week
  ];
  await prisma.trackingEvent.createMany({ data: events });
  // It's actively sending this week, so mark it live with a fresh lastEventAt.
  await prisma.hotelClient.update({
    where: { id: dropping.id },
    data: { snippetStatus: "live", lastEventAt: daysAgo(0.5) },
  });
  // A little ad spend so the weekly summary shows ROAS.
  await prisma.adSnapshot.createMany({
    data: Array.from({ length: 7 }, (_, d) => ({
      agencyId: agency.id,
      hotelClientId: dropping.id,
      metaAccountId: "act_alert_demo",
      date: dateOnly(daysAgo(d)),
      spend: "60.00",
      impressions: 8000,
      reach: 6000,
      clicks: 200,
      ctr: 2.5,
      cpc: "0.3000",
      cpm: "7.5000",
      conversions: 1,
      roas: 2.4,
      pixelPurchases: 1,
      pixelLeads: 2,
      pixelPageViews: 120,
    })),
  });

  // ── 2) Snippet error: live, but last event was 3 days ago (>48h silent) ──
  const silent = await createDemoHotel(agency.id, "Silent Inn");
  await prisma.trackingEvent.createMany({
    data: bookings(agency.id, silent.id, `${silent.websiteUrl}/rooms`, 6, 3, 5),
  });
  await prisma.hotelClient.update({
    where: { id: silent.id },
    data: { snippetStatus: "live", lastEventAt: daysAgo(3) },
  });

  // ── 3) Meta token expiry: connected token expiring in 7 days ──
  // Tokens are hotel-scoped — attach the demo token to the `dropping` hotel.
  const expiresAt = new Date(Date.now() + 7 * DAY_MS);
  const existingToken = await prisma.metaToken.findFirst({
    where: { agencyId: agency.id, hotelClientId: dropping.id },
    select: { id: true },
  });
  if (existingToken) {
    await prisma.metaToken.update({
      where: { id: existingToken.id },
      data: { status: "connected", tokenExpiresAt: expiresAt },
    });
    console.log("  • Set existing Meta token to expire in 7 days.");
  } else {
    await prisma.metaToken.create({
      data: {
        agencyId: agency.id,
        hotelClientId: dropping.id,
        encryptedToken: encryptToken("alert-demo-token-not-a-real-meta-token"),
        status: "connected",
        tokenExpiresAt: expiresAt,
      },
    });
    console.log("  • Created a demo Meta token expiring in 7 days.");
  }

  console.log(
    "\nDone. Demo hotels created: 'Dropping Resort' (perf drop), 'Silent Inn' (snippet error).",
  );
  console.log("\nTrigger the alerts with:");
  console.log(
    `  curl -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/alerts/run?force=1"`,
  );
  console.log("\nThen view history at /agency/alerts\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
