import "./load-env";
import { prisma } from "../lib/prisma";

// Dev helper for the hotel's share link.
//
//   tsx scripts/dev-share-link.ts                  → list hotels + link state
//   tsx scripts/dev-share-link.ts gen <hotelId>    → mint a fresh /share/<uuid>
//   tsx scripts/dev-share-link.ts gen              → mint one for EVERY hotel
//   tsx scripts/dev-share-link.ts revoke <hotelId> → revoke the live link
//
// WHICH CREDENTIAL THIS MINTS, because there have been two:
//
//   • ShareLink.token → /share/<uuid>   ← the live one, and what `gen` creates.
//     It carries an expiry, a revocation switch and an optional password, and it
//     now serves the FULL dashboard — the same component /agency/hotel/<id>
//     renders. Minting one is how you compare the two surfaces by eye.
//
//   • HotelClient.shareToken → /h/<64-hex>   ← RETIRED. That route always 404s
//     and the token grants nothing (lib/hotel-auth.ts). This script used to
//     generate them; it no longer does, because handing someone a URL that
//     cannot work is worse than having no command. The listing still reports
//     whether a hotel carries a legacy token so stale rows are visible.
//
// The listing also prints showAdSpendToHotel, since that flag is the one thing
// that legitimately changes what the share link shows (npm run dev:show-spend).

const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3002").replace(/\/+$/, "");

/** Mirrors SHARE_LINK_TTL_DAYS in lib/share.ts, which is "server-only". */
const TTL_DAYS = 30;

async function mint(hotel: { id: string; name: string; agencyId: string }) {
  // At most one live link per hotel — the same rule createShareLink enforces.
  await prisma.shareLink.updateMany({
    where: { hotelClientId: hotel.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const link = await prisma.shareLink.create({
    data: {
      agencyId: hotel.agencyId,
      hotelClientId: hotel.id,
      expiresAt: new Date(Date.now() + TTL_DAYS * 86_400_000),
    },
    select: { token: true },
  });
  console.log(`\n${hotel.name}`);
  console.log(`  agency view  ${baseUrl}/agency/hotel/${hotel.id}`);
  console.log(`  share  view  ${baseUrl}/share/${link.token}`);
}

async function main() {
  const [cmd, hotelId] = process.argv.slice(2);

  if (cmd === "revoke") {
    if (!hotelId) {
      console.error("Usage: tsx scripts/dev-share-link.ts revoke <hotelId>");
      process.exitCode = 1;
      return;
    }
    const { count } = await prisma.shareLink.updateMany({
      where: { hotelClientId: hotelId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    console.log(`Revoked ${count} live link(s) for hotel ${hotelId}.`);
    return;
  }

  if (cmd === "gen") {
    const hotels = await prisma.hotelClient.findMany({
      where: { deletedAt: null, ...(hotelId ? { id: hotelId } : {}) },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, agencyId: true },
    });
    if (hotels.length === 0) {
      console.error(
        hotelId
          ? `No hotel with id ${hotelId}. Run with no arguments to list them.`
          : "No hotels in this database. Seed one first (npm run seed:dashboard-demo).",
      );
      process.exitCode = 1;
      return;
    }
    for (const hotel of hotels) await mint(hotel);
    console.log(
      "\nThe share link hides ad spend unless the hotel's showAdSpendToHotel is on.\n" +
        "To see the spend-visible version:  npm run dev:show-spend -- <hotelId>",
    );
    return;
  }

  const hotels = await prisma.hotelClient.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      agency: { select: { name: true } },
      shareToken: true,
      shareTokenRevoked: true,
      showAdSpendToHotel: true,
      shareLinks: {
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { token: true, expiresAt: true },
      },
    },
  });

  console.log(`${hotels.length} hotel(s):`);
  for (const h of hotels) {
    const legacy = h.shareToken ? (h.shareTokenRevoked ? "revoked" : "present (retired route)") : "none";
    console.log(
      `\n  ${h.id}  ${h.name}  [agency: ${h.agency.name}]` +
        `\n    ad spend shared with hotel: ${h.showAdSpendToHotel ? "YES" : "no"}` +
        `\n    legacy /h token: ${legacy}`,
    );
    const live = h.shareLinks[0];
    if (live) {
      console.log(`    share view  ${baseUrl}/share/${live.token}`);
      console.log(`      expires ${live.expiresAt.toISOString().slice(0, 10)}`);
    } else {
      console.log("    share view  none — run: tsx scripts/dev-share-link.ts gen " + h.id);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
