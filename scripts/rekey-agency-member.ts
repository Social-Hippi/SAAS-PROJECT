import "dotenv/config";
import { prisma } from "../lib/prisma";
import { isAllowedStaffEmail } from "../lib/access";

// ─────────────────────────────────────────────────────────────────────────────
// Re-key a single AgencyMember's email to a Social Hippi staff address so an
// agency provisioned under a non-staff login (but holding real data) regains
// access under the read-path staff gate — WITHOUT deleting any data. The Clerk
// login (clerkId) is unchanged; only the stored member.email is updated, which
// is the value isAllowedStaffEmail() checks in getAgencyContext().
//
// SAFE BY DEFAULT — dry run unless you pass --confirm.
//   Dry run:  npx tsx scripts/rekey-agency-member.ts
//   Apply:    npx tsx scripts/rekey-agency-member.ts --confirm
//
// Reversible: re-run with the FROM/TO emails swapped to undo.
// ─────────────────────────────────────────────────────────────────────────────

const AGENCY_ID = "cmpo1h4fk0000kcil074608rj"; // "Social Hippi" (4 hotels, 51 events)
const FROM_EMAIL = "aare3revanth4@gmail.com";
const TO_EMAIL = "ashrith@socialhippi.com";

const CONFIRM = process.argv.includes("--confirm");

async function main() {
  // Safety assert: never re-key TO a non-staff address (that would be pointless
  // and could mask a typo).
  if (!isAllowedStaffEmail(TO_EMAIL)) {
    throw new Error(
      `Refusing to re-key: TO_EMAIL "${TO_EMAIL}" is not a staff address.`,
    );
  }

  const member = await prisma.agencyMember.findFirst({
    where: { agencyId: AGENCY_ID, email: FROM_EMAIL },
    select: { id: true, email: true, name: true, role: true, clerkId: true },
  });

  if (!member) {
    console.log(
      `\nNo member with email ${FROM_EMAIL} in agency ${AGENCY_ID}. ` +
        `Nothing to do (already re-keyed?).\n`,
    );
    return;
  }

  console.log("\n" + "═".repeat(72));
  console.log("RE-KEY AGENCY MEMBER");
  console.log("═".repeat(72));
  console.log(`  member id:  ${member.id}`);
  console.log(`  role:       ${member.role}`);
  console.log(`  clerkId:    ${member.clerkId}  (UNCHANGED — same login)`);
  console.log(`  email:      ${member.email}  →  ${TO_EMAIL}`);
  console.log("═".repeat(72));

  if (!CONFIRM) {
    console.log(
      "\nDRY RUN — nothing changed. Re-run with --confirm to apply:\n" +
        "  npx tsx scripts/rekey-agency-member.ts --confirm\n",
    );
    return;
  }

  const updated = await prisma.agencyMember.update({
    where: { id: member.id },
    data: { email: TO_EMAIL },
    select: { id: true, email: true },
  });
  console.log(`\n--confirm passed — updated. member ${updated.id} email is now ${updated.email}.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
