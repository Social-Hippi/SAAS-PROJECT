import "./load-env";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

// Seeds realistic Phase 3 (click / form / identity) demo data for ONE hotel so
// the Visitor Journeys page renders the new sections populated — for screenshots
// and manual QA. Idempotent: re-running first clears its own rows (visitorId
// prefix `vis_p3demo-`). Usage:  npx tsx scripts/seed-phase3-demo.ts [hotelId]
//
// PII hashing is inlined here (NOT imported from lib/pii — that's `server-only`
// and throws under tsx). It mirrors lib/pii-client (client SHA-256) + lib/pii
// (salted server layer) EXACTLY, so the demo email below is searchable in the
// Customer Journey Lookup box.

const PREFIX = "vis_p3demo-";
const piiSalt = () => process.env.PII_SALT || process.env.ENCRYPTION_KEY || "hoteltrack-dev-pii-salt";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const clientHash = (raw: string) => sha256(raw.trim().toLowerCase());
const storedEmailHash = (email: string) => sha256(`${piiSalt()}:${clientHash(email)}`);

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

async function main() {
  const hotelId = process.argv[2];
  const hotel = hotelId
    ? await prisma.hotelClient.findUnique({ where: { id: hotelId } })
    : await prisma.hotelClient.findFirst({ orderBy: { createdAt: "desc" } });
  if (!hotel) throw new Error("No hotel found. Pass a hotelId or create a hotel first.");
  const { id: hid, agencyId } = hotel;
  console.log(`Seeding Phase 3 demo data for hotel "${hotel.name}" (${hid})`);

  // Clean previous demo rows (cascades clicks/forms via Session FK).
  await prisma.visitorIdentity.deleteMany({ where: { hotelClientId: hid, visitorId: { startsWith: PREFIX } } });
  await prisma.session.deleteMany({ where: { hotelClientId: hid, visitorId: { startsWith: PREFIX } } });

  // Visitor personas: some identified, some anonymous, some returning.
  const personas = [
    { vid: `${PREFIX}priya`, name: "Priya Sharma", email: "priya@example.com", customerId: "PMS-10432", sessions: 3, converts: true },
    { vid: `${PREFIX}arjun`, name: "Arjun Mehta", email: "arjun@example.com", customerId: null, sessions: 2, converts: false },
    { vid: `${PREFIX}neha`, name: "Neha Kapoor", email: "neha@example.com", customerId: "PMS-10433", sessions: 1, converts: true },
    { vid: `${PREFIX}anon1`, name: null, email: null, customerId: null, sessions: 1, converts: false },
    { vid: `${PREFIX}anon2`, name: null, email: null, customerId: null, sessions: 2, converts: false },
  ];

  const CLICK_TARGETS = [
    { target: "check-availability", tag: "BUTTON", text: "Check Availability", convertBias: 0.45 },
    { target: "book-now-button", tag: "BUTTON", text: "Book Now", convertBias: 0.08 },
    { target: "view-rooms", tag: "A", text: "View Rooms", convertBias: 0.2 },
    { target: "whatsapp-enquiry", tag: "A", text: "WhatsApp Us", convertBias: 0.15 },
  ];
  // Form fields ordered as the funnel; date-picker abandons most, name least.
  const FORM_FIELDS = [
    { field: "date-picker", fillRate: 0.8 },
    { field: "guest-count", fillRate: 0.88 },
    { field: "guest-name", fillRate: 0.95 },
    { field: "email", fillRate: 0.6 },
    { field: "phone", fillRate: 0.55 },
  ];

  let clicks = 0, forms = 0, ids = 0, convs = 0;

  for (const p of personas) {
    if (p.name || p.email) {
      await prisma.visitorIdentity.create({
        data: {
          visitorId: p.vid,
          hotelClientId: hid,
          agencyId,
          name: p.name,
          emailHash: p.email ? storedEmailHash(p.email) : null,
          phoneHash: null,
          customerId: p.customerId,
          identifiedAt: daysAgo(2),
          identifiedInSessionId: null,
        },
      });
      ids++;
    }

    for (let s = 0; s < p.sessions; s++) {
      const sid = `sess_${randomUUID()}`;
      const start = daysAgo(1 + s);
      const converted = p.converts && s === p.sessions - 1; // last session converts
      await prisma.session.create({
        data: {
          id: sid,
          visitorId: p.vid,
          hotelClientId: hid,
          agencyId,
          startedAt: start,
          endedAt: new Date(start.getTime() + 6 * 60_000),
          landingPath: "/",
          exitPath: converted ? "/thank-you" : "/book",
          pageViewCount: 4,
          totalTimeMs: 6 * 60_000,
          highestStageReached: converted ? "booking" : "intent",
          utmSource: ["instagram", "facebook", "google"][s % 3],
          utmMedium: "social",
        },
      });

      // A few pages so the lookup + timeline have content.
      const pages = ["/", "/rooms", "/rooms/deluxe", converted ? "/thank-you" : "/book"];
      for (let i = 0; i < pages.length; i++) {
        const enteredAt = new Date(start.getTime() + i * 90_000);
        await prisma.pageView.create({
          data: {
            sessionId: sid, visitorId: p.vid, hotelClientId: hid, agencyId,
            pagePath: pages[i], enteredAt,
            exitedAt: new Date(enteredAt.getTime() + 80_000), timeOnPageMs: 80_000,
            exitReason: i === pages.length - 1 ? "unload" : "navigation",
            funnelStage: i === pages.length - 1 && converted ? "booking" : "intent",
          },
        });
      }

      // Clicks — each session fires a couple of CTAs.
      for (const ct of CLICK_TARGETS) {
        if (Math.random() < (converted ? ct.convertBias + 0.4 : ct.convertBias + 0.25)) {
          await prisma.clickEvent.create({
            data: {
              sessionId: sid, visitorId: p.vid, hotelClientId: hid, agencyId,
              pagePath: "/book", clickTarget: ct.target, elementTag: ct.tag,
              elementText: ct.text, occurredAt: new Date(start.getTime() + 120_000),
            },
          });
          clicks++;
        }
      }

      // Form-field focus + blur (filled or abandoned per fillRate).
      for (const ff of FORM_FIELDS) {
        const focusAt = new Date(start.getTime() + 200_000);
        await prisma.formFieldEvent.create({
          data: {
            sessionId: sid, visitorId: p.vid, hotelClientId: hid, agencyId,
            pagePath: "/book", fieldName: ff.field, action: "focused", hasValue: null, occurredAt: focusAt,
          },
        });
        const filled = converted || Math.random() < ff.fillRate;
        await prisma.formFieldEvent.create({
          data: {
            sessionId: sid, visitorId: p.vid, hotelClientId: hid, agencyId,
            pagePath: "/book", fieldName: ff.field, action: "blurred", hasValue: filled,
            occurredAt: new Date(focusAt.getTime() + 5_000),
          },
        });
        forms += 2;
      }

      if (converted) {
        await prisma.trackingEvent.create({
          data: {
            agencyId, hotelClientId: hid, eventType: "conversion",
            pageUrl: `${hotel.websiteUrl.replace(/\/$/, "")}/thank-you`,
            conversionValue: (8000 + Math.round(Math.random() * 20000)).toFixed(2),
            sessionId: sid, visitorId: p.vid, deviceType: "desktop", createdAt: start,
          },
        });
        convs++;
      }
    }
  }

  console.log(`Done: ${ids} identities, ${clicks} clicks, ${forms} form events, ${convs} conversions.`);
  console.log(`Try the Customer Journey Lookup with: priya@example.com  (or name "Priya")`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
