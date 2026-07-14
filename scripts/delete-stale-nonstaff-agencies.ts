import "dotenv/config";
import { prisma } from "../lib/prisma";
import { isAllowedStaffEmail, allowedAdminEmailDomain } from "../lib/access";

// ─────────────────────────────────────────────────────────────────────────────
// Remove agency provisioning created by NON-staff accounts before the access
// lockdown (e.g. a student account that signed up and provisioned an agency).
//
// SAFE BY DEFAULT — this is a DRY RUN unless you pass --confirm. It prints the
// EXACT rows it would delete and exits. Nothing is removed without --confirm.
//
//   Dry run (default, prints only):   npx tsx scripts/delete-stale-nonstaff-agencies.ts
//   Actually delete (after review):   npx tsx scripts/delete-stale-nonstaff-agencies.ts --confirm
//
// What it does, deliberately conservatively:
//   • A member is "non-staff" when isAllowedStaffEmail(member.email) is false
//     (same authoritative rule as lib/access.ts, honoring ALLOWED_ADMIN_EMAIL_DOMAIN).
//   • An agency is deleted ENTIRELY only if EVERY one of its members is non-staff
//     (a fully-stale agency). Deleting it cascades to all its hotels, content,
//     tracking data, etc. (schema onDelete: Cascade).
//   • An agency that has BOTH staff and non-staff members is NEVER deleted; only
//     its individual non-staff member rows are removed, so no legitimate data is
//     touched.
// ─────────────────────────────────────────────────────────────────────────────

const CONFIRM = process.argv.includes("--confirm");

type MemberRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  clerkId: string;
  agencyId: string;
};

async function main() {
  console.log(
    `\nStaff domain in effect: @${allowedAdminEmailDomain()} ` +
      `(override with ALLOWED_ADMIN_EMAIL_DOMAIN)\n`,
  );

  const members: MemberRow[] = await prisma.agencyMember.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      clerkId: true,
      agencyId: true,
    },
  });

  // Group members by agency and split staff vs non-staff.
  const byAgency = new Map<
    string,
    { staff: MemberRow[]; nonStaff: MemberRow[] }
  >();
  for (const m of members) {
    const g = byAgency.get(m.agencyId) ?? { staff: [], nonStaff: [] };
    (isAllowedStaffEmail(m.email) ? g.staff : g.nonStaff).push(m);
    byAgency.set(m.agencyId, g);
  }

  // Fully-stale agencies (no staff member at all) → delete the whole agency.
  const agencyIdsToDelete: string[] = [];
  // Non-staff members inside otherwise-staffed agencies → delete just the member.
  const membersToDelete: MemberRow[] = [];

  for (const [agencyId, g] of byAgency) {
    if (g.nonStaff.length === 0) continue; // clean agency, skip
    if (g.staff.length === 0) agencyIdsToDelete.push(agencyId);
    else membersToDelete.push(...g.nonStaff);
  }

  // ── Report: agencies that would be deleted entirely ──────────────────────────
  const agencies = await prisma.agency.findMany({
    where: { id: { in: agencyIdsToDelete } },
    select: { id: true, name: true, email: true, createdAt: true },
  });

  console.log("═".repeat(72));
  console.log(`AGENCIES TO DELETE ENTIRELY (cascades all their data): ${agencies.length}`);
  console.log("═".repeat(72));
  for (const a of agencies) {
    const [hotels, content, events] = await Promise.all([
      prisma.hotelClient.count({ where: { agencyId: a.id } }),
      prisma.contentPiece.count({ where: { agencyId: a.id } }),
      prisma.trackingEvent.count({ where: { agencyId: a.id } }),
    ]);
    const g = byAgency.get(a.id)!;
    console.log(
      `\n  Agency  ${a.id}\n` +
        `    name:       ${a.name}\n` +
        `    email:      ${a.email}\n` +
        `    createdAt:  ${a.createdAt.toISOString()}\n` +
        `    members:    ${g.nonStaff.length} (all non-staff) → ` +
        g.nonStaff.map((m) => `${m.email} [${m.role}]`).join(", ") +
        `\n    cascades:   ${hotels} hotel(s), ${content} content piece(s), ` +
        `${events} tracking event(s), and all related rows`,
    );
  }
  if (agencies.length === 0) console.log("  (none)");

  // ── Report: individual non-staff members in otherwise-staffed agencies ───────
  console.log("\n" + "═".repeat(72));
  console.log(
    `NON-STAFF MEMBERS TO REMOVE (agency kept — it still has staff): ${membersToDelete.length}`,
  );
  console.log("═".repeat(72));
  for (const m of membersToDelete) {
    console.log(
      `  member ${m.id}  ${m.email} [${m.role}]  in agency ${m.agencyId}`,
    );
  }
  if (membersToDelete.length === 0) console.log("  (none)");

  // ── Act only with --confirm ──────────────────────────────────────────────────
  if (!CONFIRM) {
    console.log(
      "\nDRY RUN — nothing was deleted. Re-run with --confirm to apply:\n" +
        "  npx tsx scripts/delete-stale-nonstaff-agencies.ts --confirm\n",
    );
    return;
  }

  console.log("\n--confirm passed — deleting now…");
  await prisma.$transaction(async (tx) => {
    if (membersToDelete.length) {
      const res = await tx.agencyMember.deleteMany({
        where: { id: { in: membersToDelete.map((m) => m.id) } },
      });
      console.log(`  removed ${res.count} non-staff member row(s)`);
    }
    for (const id of agencyIdsToDelete) {
      await tx.agency.delete({ where: { id } }); // cascades
      console.log(`  deleted agency ${id} (cascaded)`);
    }
  });
  console.log("Done.\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
