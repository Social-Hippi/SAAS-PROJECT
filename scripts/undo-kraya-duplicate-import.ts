import "./load-env";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma";
import { parseKrayaExport } from "../lib/kraya-import";
import { normalizePhone } from "../lib/pii-client";

// ─────────────────────────────────────────────────────────────────────────────
// Remove the duplicate Kraya rows created by a local re-import run WITHOUT the
// production PII salt.
//
// piiSalt() falls back to a dev default when neither PII_SALT nor ENCRYPTION_KEY
// is present. A script run with only DATABASE_URL therefore hashes every phone
// differently from production, matches nothing, and creates a second copy of
// every conversation and booking instead of updating the existing ones.
//
// The bad rows are exactly identifiable: recompute the DEV-salt hash for every
// phone in the export files, and delete only rows carrying those hashes. Rows
// written by production keep the real salt and cannot collide with them.
//
//   tsx scripts/undo-kraya-duplicate-import.ts            → report only
//   tsx scripts/undo-kraya-duplicate-import.ts --delete   → delete them
// ─────────────────────────────────────────────────────────────────────────────

const HOTEL_ID = "cmru6bnmo000004l6yl2ryzh9";
const DEV_SALT = "hoteltrack-dev-pii-salt";
const EXPORTS = [
  "/Users/apple/Downloads/leads-20260916032721.xlsx",
  "/Users/apple/Downloads/leads-20260916032832.xlsx",
  "/Users/apple/Downloads/leads-20260916032849.xlsx",
];

function devHash(raw: string): string | null {
  const n = normalizePhone(raw);
  if (!n) return null;
  const inner = createHash("sha256").update(n).digest("hex");
  return createHash("sha256").update(`${DEV_SALT}:${inner}`).digest("hex");
}

async function main() {
  // Guard: with the real salt present these hashes would be wrong, and the
  // delete would target nothing — or, worse, something else.
  if (process.env.PII_SALT || process.env.ENCRYPTION_KEY) {
    throw new Error("PII_SALT/ENCRYPTION_KEY is set — this script must run WITHOUT them.");
  }

  const hashes = new Set<string>();
  for (const path of EXPORTS) {
    for (const lead of parseKrayaExport(readFileSync(path), "Booking Confirmed").leads) {
      const h = devHash(lead.phone);
      if (h) hashes.add(h);
    }
  }
  const list = [...hashes];

  const conversations = await prisma.whatsAppConversation.count({
    where: { hotelClientId: HOTEL_ID, phoneHash: { in: list } },
  });
  const bookings = await prisma.booking.count({
    where: { hotelClientId: HOTEL_ID, provider: "kraya", guestPhoneHash: { in: list } },
  });
  const totalConv = await prisma.whatsAppConversation.count({ where: { hotelClientId: HOTEL_ID } });
  const totalBk = await prisma.booking.count({ where: { hotelClientId: HOTEL_ID, provider: "kraya" } });

  console.log(`dev-salt hashes from exports : ${list.length}`);
  console.log(`conversations to delete      : ${conversations}  (of ${totalConv})`);
  console.log(`bookings to delete           : ${bookings}  (of ${totalBk})`);

  if (process.argv.includes("--delete")) {
    const b = await prisma.booking.deleteMany({
      where: { hotelClientId: HOTEL_ID, provider: "kraya", guestPhoneHash: { in: list } },
    });
    const c = await prisma.whatsAppConversation.deleteMany({
      where: { hotelClientId: HOTEL_ID, phoneHash: { in: list } },
    });
    console.log(`\ndeleted: bookings=${b.count} conversations=${c.count}`);
    console.log(`remaining conversations=${await prisma.whatsAppConversation.count({ where: { hotelClientId: HOTEL_ID } })}`);
    console.log(`remaining bookings=${await prisma.booking.count({ where: { hotelClientId: HOTEL_ID, provider: "kraya" } })}`);
  } else {
    console.log("\nDry run. Re-run with --delete to remove them.");
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
