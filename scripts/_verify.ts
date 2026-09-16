import "./load-env";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma";
import { parseKrayaExport } from "../lib/kraya-import";
import { normalizePhone } from "../lib/pii-client";
const H = "cmru6bnmo000004l6yl2ryzh9";
const DEV_SALT = "hoteltrack-dev-pii-salt";
const devHash = (raw: string) => {
  const n = normalizePhone(raw);
  if (!n) return null;
  const inner = createHash("sha256").update(n).digest("hex");
  return createHash("sha256").update(`${DEV_SALT}:${inner}`).digest("hex");
};
async function main() {
  console.log("PII_SALT set locally:", Boolean(process.env.PII_SALT), "| ENCRYPTION_KEY set:", Boolean(process.env.ENCRYPTION_KEY));
  const hashes = new Set<string>();
  for (const f of ["leads-20260916032721","leads-20260916032832","leads-20260916032849"]) {
    for (const l of parseKrayaExport(readFileSync(`/Users/apple/Downloads/${f}.xlsx`), "Booking Confirmed").leads) {
      const h = devHash(l.phone); if (h) hashes.add(h);
    }
  }
  const list = [...hashes];
  console.log("distinct dev-salt hashes from the exports:", list.length);
  const conv = await prisma.whatsAppConversation.count({ where: { hotelClientId: H, phoneHash: { in: list } } });
  const bk   = await prisma.booking.count({ where: { hotelClientId: H, provider: "kraya", guestPhoneHash: { in: list } } });
  const total = await prisma.whatsAppConversation.count({ where: { hotelClientId: H } });
  console.log(`conversations matching the DEV salt: ${conv} of ${total}`);
  console.log(`bookings matching the DEV salt:      ${bk}`);
}
main().catch(e=>{console.error("ERR",e.message);process.exitCode=1;}).finally(()=>prisma.$disconnect());
