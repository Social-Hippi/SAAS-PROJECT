import { afterEach, describe, expect, test } from "vitest";
import { isAllowedStaffEmail, allowedAdminEmailDomain } from "@/lib/access";

// Pure unit test (no DB) for the staff email-domain allowlist that gates who may
// hold agency/admin access. This is the authoritative rule enforced server-side in
// createAgencyForCurrentUser; here we lock its exact matching behaviour.

describe("isAllowedStaffEmail / allowedAdminEmailDomain", () => {
  const orig = process.env.ALLOWED_ADMIN_EMAIL_DOMAIN;
  afterEach(() => {
    if (orig === undefined) delete process.env.ALLOWED_ADMIN_EMAIL_DOMAIN;
    else process.env.ALLOWED_ADMIN_EMAIL_DOMAIN = orig;
  });

  test("defaults to socialhippi.com when the env var is unset", () => {
    delete process.env.ALLOWED_ADMIN_EMAIL_DOMAIN;
    expect(allowedAdminEmailDomain()).toBe("socialhippi.com");
    expect(isAllowedStaffEmail("ashrith@socialhippi.com")).toBe(true);
    expect(isAllowedStaffEmail("  ASHRITH@SocialHippi.com  ")).toBe(true); // trimmed + case-insensitive
  });

  test("rejects non-staff, look-alike, and malformed emails", () => {
    delete process.env.ALLOWED_ADMIN_EMAIL_DOMAIN;
    expect(isAllowedStaffEmail("someone@gmail.com")).toBe(false);
    expect(isAllowedStaffEmail("x@socialhippi.com.evil.com")).toBe(false); // suffix look-alike
    expect(isAllowedStaffEmail("x@evilsocialhippi.com")).toBe(false);
    expect(isAllowedStaffEmail("x@sub.socialhippi.com")).toBe(false); // subdomain is NOT the domain
    expect(isAllowedStaffEmail("")).toBe(false);
    expect(isAllowedStaffEmail(null)).toBe(false);
    expect(isAllowedStaffEmail(undefined)).toBe(false);
    expect(isAllowedStaffEmail("no-at-sign")).toBe(false);
  });

  test("honours a custom ALLOWED_ADMIN_EMAIL_DOMAIN (with or without a leading @)", () => {
    process.env.ALLOWED_ADMIN_EMAIL_DOMAIN = "@example.org";
    expect(allowedAdminEmailDomain()).toBe("example.org");
    expect(isAllowedStaffEmail("a@example.org")).toBe(true);
    expect(isAllowedStaffEmail("a@socialhippi.com")).toBe(false);
  });
});
