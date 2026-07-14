import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// ACCESS LOCKDOWN — hotel self-signup and hotel logins are RETIRED. This suite
// (formerly "hotel self-signup") now proves:
//   • the invite-code LIB still generates/regenerates/disables codes (unchanged), but
//   • completeHotelSignup hard-refuses — a valid, active code creates NO hotel and
//     NO Clerk account, and
//   • the hotel-owner dashboard gate (resolveHotelForViewer) + owner edit action
//     deny everyone, even a legitimately-linked owner.
// Clerk's Backend SDK + auth() are mocked. A live DB holds the fixtures.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  userId: null as string | null,
  existingEmail: false,
  created: [] as { id: string; role: unknown }[],
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: h.userId }),
  clerkClient: async () => ({
    users: {
      getUserList: async () => ({ totalCount: h.existingEmail ? 1 : 0, data: [] }),
      createUser: async (args: { publicMetadata?: { role?: unknown } }) => {
        const id = `user_${randomUUID()}`;
        h.created.push({ id, role: args.publicMetadata?.role });
        return { id };
      },
      updateUserMetadata: async () => ({}),
    },
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prisma } from "@/lib/prisma";
import { ensureInviteCode, regenerateInviteCode, setInviteCodeStatus } from "@/lib/hotel-invite";
import { completeHotelSignup, type HotelSignupInput } from "@/app/join/[inviteCode]/actions";
import { resolveHotelForViewer } from "@/lib/hotel-auth";
import { updateHotelDetails } from "@/app/hotel/[hotelClientId]/dashboard/actions";

const PREFIX = "TEST_SS_";

function validInput(inviteCode: string, over: Partial<HotelSignupInput> = {}): HotelSignupInput {
  return {
    inviteCode,
    hotelName: "Test Hotel",
    websiteUrl: "testhotel.com",
    contactName: "Owner Name",
    ownerEmail: `owner-${randomUUID()}@hotel.test`,
    password: "supersecret123",
    ownerPhone: "9876543210",
    address: "123 MG Road, Bengaluru 560001",
    whatsappNumber: "9876543210",
    roomCount: "20",
    channelManager: "djubo",
    otaCommissionRate: "15",
    ...over,
  };
}

let agencyA: string, agencyB: string;
let memberAClerk: string, memberBClerk: string;

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const A = await prisma.agency.create({ data: { name: `${PREFIX}Social Hippi`, email: `${PREFIX}a@x.test`, subscriptionStatus: "active" } });
  const B = await prisma.agency.create({ data: { name: `${PREFIX}Other Agency`, email: `${PREFIX}b@x.test`, subscriptionStatus: "active" } });
  agencyA = A.id; agencyB = B.id;
  memberAClerk = `user_A_${randomUUID()}`;
  memberBClerk = `user_B_${randomUUID()}`;
  await prisma.agencyMember.create({ data: { agencyId: A.id, clerkId: memberAClerk, email: "a@m.test", name: "A", role: "admin" } });
  await prisma.agencyMember.create({ data: { agencyId: B.id, clerkId: memberBClerk, email: "b@m.test", name: "B", role: "admin" } });
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

beforeEach(() => { h.userId = null; h.existingEmail = false; });

describe("invite codes (lib still works)", () => {
  test("ensureInviteCode generates SLUG-XXXXXXXX and is idempotent", async () => {
    const first = await ensureInviteCode(agencyA);
    expect(first.code).toMatch(/^[A-Z0-9-]+-[A-Z0-9]{8}$/);
    expect(first.code).toContain("SOCIAL-HIPPI");
    const second = await ensureInviteCode(agencyA);
    expect(second.code).toBe(first.code); // unchanged
  });

  test("codes are unique across agencies", async () => {
    const a = await ensureInviteCode(agencyA);
    const b = await ensureInviteCode(agencyB);
    expect(a.code).not.toBe(b.code);
  });

  test("regenerate + enable/disable still work at the lib level", async () => {
    const before = await ensureInviteCode(agencyA);
    const next = await regenerateInviteCode(agencyA);
    expect(next).not.toBe(before.code);
    await setInviteCodeStatus(agencyA, "DISABLED");
    await setInviteCodeStatus(agencyA, "ACTIVE");
  });
});

describe("ACCESS LOCKDOWN — completeHotelSignup is disabled", () => {
  test("a valid, active invite code creates NO hotel and NO Clerk account", async () => {
    const { code } = await ensureInviteCode(agencyA);
    const before = await prisma.hotelClient.count({ where: { agencyId: agencyA } });
    const createdBefore = h.created.length;

    const res = await completeHotelSignup(validInput(code));

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no longer available|contact your agency/i);
    // Nothing was written to the DB and no Clerk user was created.
    const after = await prisma.hotelClient.count({ where: { agencyId: agencyA } });
    expect(after).toBe(before);
    expect(h.created.length).toBe(createdBefore);
  });
});

describe("ACCESS LOCKDOWN — hotel-owner dashboard gate denies everyone", () => {
  let hotelId: string;
  const ownerClerk = `user_owner_${randomUUID()}`;

  beforeAll(async () => {
    // Signup is disabled, so link an owner directly to prove the dashboard gate
    // denies even a legitimately-linked hotel_client owner.
    const hotel = await prisma.hotelClient.create({
      data: {
        agencyId: agencyA, name: `${PREFIX}Retired`, websiteUrl: "https://h.example",
        contactName: "C", contactEmail: "c@t.local", siteId: `${PREFIX}s-${randomUUID()}`,
        conversionMethod: "both", createdByUserId: ownerClerk, otaCommissionRate: "15.00",
      },
    });
    hotelId = hotel.id;
  });

  test("the linked owner is DENIED (dashboard retired)", async () => {
    h.userId = ownerClerk;
    expect(await resolveHotelForViewer(hotelId)).toBeNull();
  });

  test("an agency member of the owning agency is DENIED too", async () => {
    h.userId = memberAClerk;
    expect(await resolveHotelForViewer(hotelId)).toBeNull();
  });

  test("a member of a DIFFERENT agency is DENIED", async () => {
    h.userId = memberBClerk;
    expect(await resolveHotelForViewer(hotelId)).toBeNull();
  });

  test("the owner edit action is rejected, and nothing is written", async () => {
    h.userId = ownerClerk;
    const denied = await updateHotelDetails(hotelId, {
      contactName: "Should Not Save", contactEmail: "x@x.com", contactPhone: "9876543210",
      whatsappNumber: "9876543210", address: "123 MG Road, City 560001", otaCommissionRate: "20", channelManager: "eZee",
    });
    expect(denied.ok).toBe(false);
    const hotel = await prisma.hotelClient.findUnique({ where: { id: hotelId }, select: { contactName: true } });
    expect(hotel?.contactName).not.toBe("Should Not Save");
  });
});
