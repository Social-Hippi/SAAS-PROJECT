import "./load-env";
import { prisma } from "../lib/prisma";
import {
  classifyConnection,
  detectSnippet,
  fetchHomepage,
  isSafePublicUrl,
} from "../lib/snippet-test";
import { normalizeSitePlatform } from "../lib/site-platform";

// Live smoke test for the install-guide / Test-connection feature.
//   1. round-trips the new HotelClient.sitePlatform column
//   2. fires a real event at the running dev server's public /api/track/event
//      and confirms the hotel flips to "live" (the data the green light needs)
//   3. fetches a live page that embeds the snippet and runs the REAL
//      detectSnippet() / fetchHomepage() the action uses
//   4. drives classifyConnection() through every traffic-light branch
//
// Usage: BASE_URL=http://localhost:3001 npx tsx scripts/smoke-install-test.ts

const SITE_ID = "test-site-hoteltrack";
const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ""}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function main() {
  console.log(`\n▶ Live smoke test against ${BASE_URL}\n`);

  // ── 0. Ensure the seeded test hotel exists ────────────────────────────────
  const hotel = await prisma.hotelClient.findUnique({ where: { siteId: SITE_ID } });
  if (!hotel) {
    console.error(
      `No test hotel (siteId=${SITE_ID}). Run \`npm run seed:test-hotel\` first.`,
    );
    process.exit(1);
  }
  console.log(`Hotel: ${hotel.name} (${hotel.id})  agency=${hotel.agencyId}\n`);

  // ── 1. sitePlatform column round-trips ────────────────────────────────────
  console.log("1) sitePlatform column");
  for (const p of ["wordpress", "shopify", "other"] as const) {
    const updated = await prisma.hotelClient.update({
      where: { id: hotel.id },
      data: { sitePlatform: p },
      select: { sitePlatform: true },
    });
    check(`stores "${p}"`, updated.sitePlatform === p);
  }
  check(
    "normalizeSitePlatform coerces junk → other",
    normalizeSitePlatform("nonsense") === "other",
  );

  // ── 2. Live event ingestion (the "firing" signal) ─────────────────────────
  console.log("\n2) Live event firing via /api/track/event");
  const before = await prisma.trackingEvent.count({ where: { hotelClientId: hotel.id } });
  let posted = false;
  try {
    const res = await fetch(`${BASE_URL}/api/track/event`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({
        siteId: SITE_ID,
        type: "visit",
        utmSource: "smoke-test",
        pageUrl: `${BASE_URL}/smoke`,
        sessionId: "smoke-session",
        deviceType: "desktop",
      }),
    });
    posted = res.status === 204;
    check("POST visit returns 204", res.status === 204, `got ${res.status}`);
  } catch (e) {
    check("dev server reachable", false, String(e));
  }

  if (posted) {
    // sendBeacon/fetch is fire-and-forget server-side; the row is written before
    // the 204, so a tiny settle is plenty.
    await new Promise((r) => setTimeout(r, 300));
    const after = await prisma.trackingEvent.count({ where: { hotelClientId: hotel.id } });
    check("event row written", after === before + 1, `${before} → ${after}`);
    const fresh = await prisma.hotelClient.findUnique({
      where: { id: hotel.id },
      select: { snippetStatus: true, lastEventAt: true },
    });
    check("snippetStatus flipped to live", fresh?.snippetStatus === "live");
    check("lastEventAt set", !!fresh?.lastEventAt);
  }

  // ── 3. Real snippet detection against a live page ─────────────────────────
  console.log("\n3) Snippet detection via fetchHomepage()/detectSnippet()");
  check("isSafePublicUrl blocks localhost", isSafePublicUrl("http://localhost") === false);
  check("isSafePublicUrl blocks metadata IP", isSafePublicUrl("http://169.254.169.254") === false);
  check("isSafePublicUrl allows https public", isSafePublicUrl("https://example.com") === true);

  const { html, error } = await fetchHomepage(`${BASE_URL}/test-tracking.html`);
  check("fetched test page", !!html && !error, error ?? "");
  if (html) {
    check("detects snippet for correct siteId", detectSnippet(html, SITE_ID) === true);
    check("rejects snippet for wrong siteId", detectSnippet(html, "some-other-id") === false);
  }

  // ── 4. Traffic-light classification across all branches ───────────────────
  console.log("\n4) classifyConnection() traffic light");
  const cases: Array<[string, Parameters<typeof classifyConnection>[0], string]> = [
    ["recent events → green", { snippetDetected: false, fetchError: null, eventsEver: 5, recentEvents: 2, checkedUrl: "x" }, "green"],
    ["snippet + history → green", { snippetDetected: true, fetchError: null, eventsEver: 9, recentEvents: 0, checkedUrl: "x" }, "green"],
    ["snippet, no events → yellow", { snippetDetected: true, fetchError: null, eventsEver: 0, recentEvents: 0, checkedUrl: "x" }, "yellow"],
    ["events, fetch failed → yellow", { snippetDetected: false, fetchError: "down", eventsEver: 3, recentEvents: 0, checkedUrl: "x" }, "yellow"],
    ["events, no snippet seen → yellow", { snippetDetected: false, fetchError: null, eventsEver: 3, recentEvents: 0, checkedUrl: "x" }, "yellow"],
    ["fetch failed, no events → red", { snippetDetected: false, fetchError: "down", eventsEver: 0, recentEvents: 0, checkedUrl: "x" }, "red"],
    ["nothing → red", { snippetDetected: false, fetchError: null, eventsEver: 0, recentEvents: 0, checkedUrl: "x" }, "red"],
  ];
  for (const [name, input, expected] of cases) {
    const { level } = classifyConnection(input);
    check(name, level === expected, `got ${level}`);
  }

  // Restore the seed's platform default so reruns are stable.
  await prisma.hotelClient.update({
    where: { id: hotel.id },
    data: { sitePlatform: "other" },
  });

  console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
