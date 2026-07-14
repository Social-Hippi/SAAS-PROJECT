import "dotenv/config";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Staff-domain gate on the READ path (regression test for the access-lockdown
// gap). The domain rule used to run ONLY at agency creation
// (createAgencyForCurrentUser), so a member PROVISIONED IN A PREVIOUS SESSION
// whose email is not a Social Hippi staff address could still log in and read
// agency data. The fix moves the authoritative check into getAgencyContext(),
// which every agency-scoped read/write funnels through.
//
// This test proves the fix at the read path specifically: we SEED a real Agency
// + AgencyMember with a NON-socialhippi email (exactly the stale row a student
// account created), simulate that member being "logged in", and assert that
// getAgencyContext() THROWS and that an agency-scoped query is denied — even
// though the row already exists. A staff member seeded alongside still passes,
// proving valid @socialhippi.com members are not locked out.
// ─────────────────────────────────────────────────────────────────────────────

// Mock the Clerk-backed auth module so we control "who is logged in" without a
// real session. `h.member` is what getCurrentMember() returns — the read path
// under test reads member.email from it.
const h = vi.hoisted(() => ({
  member: null as null | Record<string, unknown>,
  role: "agency_admin" as string | undefined,
}));
vi.mock("@/lib/auth", () => ({
  getCurrentMember: async () => h.member,
  getPlatformRole: async () => h.role,
}));

// Imported AFTER the mock is registered (vi.mock is hoisted).
import { prisma } from "@/lib/prisma";
import { getAgencyContext, agencyScoped, TenantAuthError } from "@/lib/tenant";

const PREFIX = "TEST_STAFFGATE_";

// Pin the allowed domain so this test is deterministic regardless of any
// ALLOWED_ADMIN_EMAIL_DOMAIN in the runner's environment.
const savedDomain = process.env.ALLOWED_ADMIN_EMAIL_DOMAIN;

type Seeded = {
  agencyId: string;
  staffMember: Record<string, unknown>;
  nonStaffMember: Record<string, unknown>;
};
let fx: Seeded;

async function seed(): Promise<Seeded> {
  const agency = await prisma.agency.create({
    data: {
      name: `${PREFIX}Agency`,
      email: `${PREFIX.toLowerCase()}agency@socialhippi.com`,
      subscriptionStatus: "active",
    },
    select: { id: true },
  });

  // A stale, pre-existing member whose email is NOT a Social Hippi staff address
  // (the exact situation the fix targets — provisioned before the lockdown).
  const nonStaffMember = await prisma.agencyMember.create({
    data: {
      agencyId: agency.id,
      clerkId: `${PREFIX}clerk-nonstaff-${Date.now()}`,
      email: "student@gmail.com",
      name: "Stale Non-Staff",
      role: "admin",
    },
    include: { agency: true },
  });

  // A valid staff member in the same agency — must still be allowed through.
  const staffMember = await prisma.agencyMember.create({
    data: {
      agencyId: agency.id,
      clerkId: `${PREFIX}clerk-staff-${Date.now()}`,
      email: "ashrith@socialhippi.com",
      name: "Valid Staff",
      role: "admin",
    },
    include: { agency: true },
  });

  return {
    agencyId: agency.id,
    staffMember: staffMember as unknown as Record<string, unknown>,
    nonStaffMember: nonStaffMember as unknown as Record<string, unknown>,
  };
}

beforeAll(async () => {
  process.env.ALLOWED_ADMIN_EMAIL_DOMAIN = "socialhippi.com";
  fx = await seed();
});

afterAll(async () => {
  // Cascade removes the members with the agency.
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  if (savedDomain === undefined) delete process.env.ALLOWED_ADMIN_EMAIL_DOMAIN;
  else process.env.ALLOWED_ADMIN_EMAIL_DOMAIN = savedDomain;
});

describe("staff-domain gate is enforced on the read path (getAgencyContext)", () => {
  test("a PRE-EXISTING non-staff member is DENIED by getAgencyContext()", async () => {
    h.member = fx.nonStaffMember; // "log in" as the stale gmail member

    await expect(getAgencyContext()).rejects.toThrowError(TenantAuthError);
    await expect(getAgencyContext()).rejects.toThrow(
      /restricted to Social Hippi staff/i,
    );
  });

  test("the same non-staff member cannot read agency data via agencyScoped()", async () => {
    h.member = fx.nonStaffMember;

    // Every agency-scoped read funnels through getAgencyContext → this rejects,
    // so no rows are ever returned to a non-staff member.
    await expect(
      agencyScoped(prisma.hotelClient).findMany(),
    ).rejects.toThrowError(TenantAuthError);
  });

  test("a valid @socialhippi.com member is NOT locked out", async () => {
    h.member = fx.staffMember; // "log in" as the valid staff member

    const ctx = await getAgencyContext();
    expect(ctx.agencyId).toBe(fx.agencyId);
    expect(ctx.memberId).toBe(fx.staffMember.id);
    expect(ctx.role).toBe("admin");
  });
});
