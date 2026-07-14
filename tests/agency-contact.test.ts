import "dotenv/config";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Agency Contact Info feature. Two layers:
//   • Pure (no DB): validation/normalization helpers + banner/gate logic. These
//     run anywhere.
//   • DB-backed (live Postgres): the settings + signup save actions, tenant
//     isolation, the new-signup gate, and that a hotel surfaces its OWNING
//     agency's contact. Scoped inside their own beforeAll so the pure tests
//     still run when the DB is unreachable.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  member: null as null | Record<string, unknown>,
  role: "agency_admin" as string | undefined,
}));
vi.mock("@/lib/auth", () => ({
  getCurrentMember: async () => h.member,
  getPlatformRole: async () => h.role,
  // Mirror the real helper: only an admin member resolves; else null.
  requireAdmin: async () => (h.member && (h.member as { role?: string }).role === "admin" ? h.member : null),
}));
// revalidatePath needs a Next request store that doesn't exist under vitest.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  validateMobile,
  validateWhatsapp,
  whatsappDigits,
  validateEmail,
  validateUrl,
  validateAddress,
  validateAgencyContact,
} from "@/lib/agency-validation";
import {
  FEATURE_DEPLOYED_AT,
  isContactInfoMissing,
  isContactInfoComplete,
  isContactInfoEmpty,
  mustCompleteContactInfo,
  shouldShowContactBanner,
  type AgencyContact,
} from "@/lib/agency-contact";

// ── Pure: validation + normalization ─────────────────────────────────────────

describe("validateMobile / validateWhatsapp", () => {
  test("normalizes every accepted Indian format to +91XXXXXXXXXX", () => {
    const expected = "+919876543210";
    expect(validateMobile("+919876543210")).toBe(expected);
    expect(validateMobile("919876543210")).toBe(expected);
    expect(validateMobile("09876543210")).toBe(expected);
    expect(validateMobile("9876543210")).toBe(expected);
    expect(validateMobile("+91 98765 43210")).toBe(expected);
    expect(validateMobile("098765-43210")).toBe(expected);
    expect(validateMobile("(0)98765 43210")).toBe(expected);
    expect(validateWhatsapp("+91 98765 43210")).toBe(expected);
  });

  test("rejects invalid numbers", () => {
    expect(validateMobile("12345")).toBeNull(); // too short
    expect(validateMobile("98765 4321")).toBeNull(); // 9 digits
    expect(validateMobile("12345678901")).toBeNull(); // 11 digits, no 0 prefix
    expect(validateMobile("5876543210")).toBeNull(); // first digit < 6
    expect(validateMobile("abcd543210")).toBeNull(); // letters
    expect(validateMobile("")).toBeNull();
  });

  test("whatsappDigits strips to country+number", () => {
    expect(whatsappDigits("+919876543210")).toBe("919876543210");
  });
});

describe("validateEmail", () => {
  test("accepts valid", () => {
    expect(validateEmail("hello@agency.com")).toBe(true);
    expect(validateEmail("a.b+c@sub.domain.co.in")).toBe(true);
  });
  test("rejects typos", () => {
    expect(validateEmail("no-at-sign.com")).toBe(false);
    expect(validateEmail("missing@domain")).toBe(false); // no dotted domain
    expect(validateEmail("spaces in@email.com")).toBe(false);
    expect(validateEmail("")).toBe(false);
  });
});

describe("validateUrl", () => {
  test("auto-prepends https:// and normalizes", () => {
    expect(validateUrl("example.com")).toBe("https://example.com");
    expect(validateUrl("www.agency.in")).toBe("https://www.agency.in");
    expect(validateUrl("http://agency.in")).toBe("http://agency.in");
    expect(validateUrl("https://agency.in/path")).toBe("https://agency.in/path");
  });
  test("rejects invalid", () => {
    expect(validateUrl("not a url")).toBeNull();
    expect(validateUrl("localhost")).toBeNull(); // no dotted host
    expect(validateUrl("")).toBeNull();
  });
});

describe("validateAddress", () => {
  test("length bounds (10–500), newlines allowed", () => {
    expect(validateAddress("123 MG Road, Bengaluru")).toBe(true);
    expect(validateAddress("line one\nline two, 560001")).toBe(true);
    expect(validateAddress("too short")).toBe(false); // 9 chars
    expect(validateAddress("x".repeat(501))).toBe(false);
  });
});

describe("validateAgencyContact (combined)", () => {
  const good = {
    mobile: "9876543210",
    contactEmail: "hi@agency.com",
    whatsappNumber: "+91 98765 43210",
    address: "123 MG Road, Bengaluru 560001",
    websiteUrl: "agency.in",
  };

  test("normalizes all fields on success", () => {
    const r = validateAgencyContact(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.mobile).toBe("+919876543210");
      expect(r.data.whatsappNumber).toBe("+919876543210");
      expect(r.data.websiteUrl).toBe("https://agency.in");
      expect(r.data.contactEmail).toBe("hi@agency.com");
    }
  });

  test("returns per-field errors for bad input", () => {
    const r = validateAgencyContact({ ...good, mobile: "123", websiteUrl: "nope", contactEmail: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.mobile).toBeTruthy();
      expect(r.errors.websiteUrl).toBeTruthy();
      expect(r.errors.contactEmail).toBeTruthy();
      expect(r.errors.address).toBeUndefined(); // address was valid
    }
  });
});

// ── Pure: banner / gate logic ────────────────────────────────────────────────

const FILLED: AgencyContact = {
  mobile: "+919876543210",
  contactEmail: "hi@agency.com",
  address: "123 MG Road, Bengaluru",
  websiteUrl: "https://agency.in",
  whatsappNumber: "+919876543210",
};
const EMPTY: AgencyContact = {
  mobile: null,
  contactEmail: null,
  address: null,
  websiteUrl: null,
  whatsappNumber: null,
};
const before = new Date(FEATURE_DEPLOYED_AT.getTime() - 86_400_000);
const after = new Date(FEATURE_DEPLOYED_AT.getTime() + 86_400_000);

describe("contact-info state helpers", () => {
  test("missing / complete / empty", () => {
    expect(isContactInfoEmpty(EMPTY)).toBe(true);
    expect(isContactInfoMissing(EMPTY)).toBe(true);
    expect(isContactInfoComplete(EMPTY)).toBe(false);
    expect(isContactInfoComplete(FILLED)).toBe(true);
    expect(isContactInfoMissing({ ...FILLED, address: null })).toBe(true);
    expect(isContactInfoEmpty({ ...FILLED, address: null })).toBe(false);
  });

  test("existing (pre-deploy) agency sees the banner until all 5 are filled", () => {
    expect(shouldShowContactBanner({ ...EMPTY, createdAt: before })).toBe(true);
    expect(shouldShowContactBanner({ ...FILLED, address: null, createdAt: before })).toBe(true);
    expect(shouldShowContactBanner({ ...FILLED, createdAt: before })).toBe(false);
  });

  test("new (post-deploy) agency is gated, never bannered", () => {
    expect(mustCompleteContactInfo({ ...EMPTY, createdAt: after })).toBe(true);
    expect(shouldShowContactBanner({ ...EMPTY, createdAt: after })).toBe(false); // gated instead
    expect(mustCompleteContactInfo({ ...FILLED, createdAt: after })).toBe(false); // mobile set
    expect(mustCompleteContactInfo({ ...EMPTY, createdAt: before })).toBe(false); // pre-deploy
  });
});

// ── DB-backed: actions, isolation, gate, owning-agency contact ────────────────

const PREFIX = "TEST_AC_";

describe("DB-backed", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let saveAgencyContact: typeof import("@/app/(agency)/agency/(app)/settings/actions").saveAgencyContact;
  let saveAgencyContactSignup: typeof import("@/app/(agency)/agency/onboarding/contact/actions").saveAgencyContactSignup;

  let agencyA: string;
  let agencyB: string;
  let hotelA: string;
  let memberA: Record<string, unknown>;
  let memberB: Record<string, unknown>;

  const loginAs = (m: Record<string, unknown> | null) => { h.member = m; };

  function form(o: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(o)) fd.set(k, v);
    return fd;
  }
  const validForm = () =>
    form({
      mobile: "9876543210",
      contactEmail: "reach@socialhippi.test",
      whatsappNumber: "9876543210",
      address: "123 MG Road, Bengaluru 560001",
      websiteUrl: "socialhippi.test",
    });

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ saveAgencyContact } = await import("@/app/(agency)/agency/(app)/settings/actions"));
    ({ saveAgencyContactSignup } = await import("@/app/(agency)/agency/onboarding/contact/actions"));

    await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
    const A = await prisma.agency.create({ data: { name: `${PREFIX}A`, email: `${PREFIX}a@x.test`, subscriptionStatus: "active" } });
    const B = await prisma.agency.create({ data: { name: `${PREFIX}B`, email: `${PREFIX}b@x.test`, subscriptionStatus: "active" } });
    agencyA = A.id;
    agencyB = B.id;
    const mA = await prisma.agencyMember.create({ data: { agencyId: A.id, clerkId: `${PREFIX}a-${Date.now()}`, email: "a@m.test", name: "A", role: "admin" } });
    const mB = await prisma.agencyMember.create({ data: { agencyId: B.id, clerkId: `${PREFIX}b-${Date.now()}`, email: "b@m.test", name: "B", role: "admin" } });
    memberA = { id: mA.id, agencyId: A.id, email: "a@socialhippi.com", role: "admin" };
    memberB = { id: mB.id, agencyId: B.id, email: "b@socialhippi.com", role: "admin" };
    const hA = await prisma.hotelClient.create({ data: { agencyId: A.id, name: `${PREFIX}HotelA`, websiteUrl: "https://h.example", contactName: "C", contactEmail: "c@t.local", siteId: `${PREFIX}s-${Date.now()}`, conversionMethod: "both" } });
    hotelA = hA.id;
  });

  afterAll(async () => {
    await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  });

  test("settings action saves + normalizes each field", async () => {
    loginAs(memberA);
    const res = await saveAgencyContact({ ok: false }, validForm());
    expect(res.ok).toBe(true);
    const a = await prisma.agency.findUnique({ where: { id: agencyA } });
    expect(a?.mobile).toBe("+919876543210");
    expect(a?.whatsappNumber).toBe("+919876543210");
    expect(a?.contactEmail).toBe("reach@socialhippi.test");
    expect(a?.websiteUrl).toBe("https://socialhippi.test");
    expect(a?.address).toContain("MG Road");
  });

  test("invalid input is rejected with per-field errors (nothing saved)", async () => {
    loginAs(memberB);
    const res = await saveAgencyContact({ ok: false }, form({
      mobile: "123", contactEmail: "bad", whatsappNumber: "123", address: "short", websiteUrl: "nope",
    }));
    expect(res.ok).toBe(false);
    expect(res.errors?.mobile).toBeTruthy();
    const b = await prisma.agency.findUnique({ where: { id: agencyB } });
    expect(b?.mobile).toBeNull(); // unchanged
  });

  test("tenant isolation: B saving never touches A", async () => {
    loginAs(memberB);
    await saveAgencyContact({ ok: false }, form({
      mobile: "9000000000", contactEmail: "b@b.test", whatsappNumber: "9000000000",
      address: "B address line, City 110001", websiteUrl: "b.test",
    }));
    const a = await prisma.agency.findUnique({ where: { id: agencyA } });
    const b = await prisma.agency.findUnique({ where: { id: agencyB } });
    expect(b?.mobile).toBe("+919000000000");
    expect(a?.mobile).toBe("+919876543210"); // A's value from the earlier test, untouched
  });

  test("signup action persists and returns redirectTo", async () => {
    const C = await prisma.agency.create({ data: { name: `${PREFIX}C`, email: `${PREFIX}c@x.test`, subscriptionStatus: "inactive" } });
    const mC = await prisma.agencyMember.create({ data: { agencyId: C.id, clerkId: `${PREFIX}c-${Date.now()}`, email: "c@m.test", name: "C", role: "admin" } });
    loginAs({ id: mC.id, agencyId: C.id, email: "c@socialhippi.com", role: "admin" });
    const res = await saveAgencyContactSignup({ ok: false }, validForm());
    expect(res.ok).toBe(true);
    expect(res.redirectTo).toBe("/agency/dashboard");
    const c = await prisma.agency.findUnique({ where: { id: C.id } });
    expect(c?.mobile).toBe("+919876543210");
  });

  test("new-signup gate flips once contact info is saved", async () => {
    const D = await prisma.agency.create({
      data: { name: `${PREFIX}D`, email: `${PREFIX}d@x.test`, createdAt: after },
    });
    const fresh = await prisma.agency.findUnique({ where: { id: D.id } });
    expect(mustCompleteContactInfo(fresh!)).toBe(true);
    await prisma.agency.update({ where: { id: D.id }, data: { mobile: "+919876543210" } });
    const done = await prisma.agency.findUnique({ where: { id: D.id } });
    expect(mustCompleteContactInfo(done!)).toBe(false);
  });

  test("a hotel surfaces its OWNING agency's contact (not the viewer's)", async () => {
    // A has contact info; the hotel belongs to A, so reading hotel→agency yields A's contact.
    const hotel = await prisma.hotelClient.findUnique({
      where: { id: hotelA },
      select: { agency: { select: { id: true, mobile: true, name: true } } },
    });
    expect(hotel?.agency.id).toBe(agencyA);
    expect(hotel?.agency.mobile).toBe("+919876543210");
    expect(hotel?.agency.mobile).not.toBe("+919000000000"); // not B's
  });
});
