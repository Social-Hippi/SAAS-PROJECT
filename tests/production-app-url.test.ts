// Production-readiness guards around the public app URL and the tracking
// snippet that is built from it.
//
// Two regressions are covered here, both of which shipped a hotel a snippet
// that silently recorded nothing:
//   1. The welcome email emitted `data-ht-site="…"` with no `?id=` — but
//      public/t.js only ever reads the siteId from the `id` query param, so the
//      script aborted on load (`if (!siteId) return`).
//   2. NEXT_PUBLIC_APP_URL was unvalidated, so a production build with the var
//      missing baked `http://localhost:3000` into that same email.

import { afterEach, describe, expect, it, vi } from "vitest";
import { appUrlProblem } from "@/lib/env-validation";
import { hotelWelcomeEmail } from "@/lib/hotel-invite";

// Minimum env for validatePlatformEnv() to get PAST the always-required
// invariants and the Clerk gate, so the app-URL check is what we're exercising.
const BASE_ENV: Record<string, string> = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  AUTH_SECRET: "test-auth-secret",
  ENCRYPTION_KEY: "a".repeat(64),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_x",
  CLERK_SECRET_KEY: "sk_test_x",
  // These are deliberately DEV-instance keys (they only need to be non-empty to
  // clear the Clerk presence gate). Opt out of the separate Clerk instance-TIER
  // gate so these cases exercise the app-URL check and nothing else — that gate
  // has its own coverage in tests/clerk-instance-tier.test.ts.
  ALLOW_CLERK_DEV_INSTANCE: "1",
};

/** Runs validatePlatformEnv() with a fresh module registry under `env`. */
async function bootWith(env: Record<string, string>): Promise<void> {
  vi.resetModules();
  vi.stubEnv("STRICT_ENV_VALIDATION", "");
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...env })) vi.stubEnv(k, v);
  const mod = await import("@/lib/env-validation");
  mod.validatePlatformEnv();
}

describe("appUrlProblem", () => {
  it("accepts a real production origin", () => {
    expect(appUrlProblem("https://hoteltrack.in")).toBeNull();
    expect(appUrlProblem("https://hoteltrack.in/")).toBeNull();
    expect(appUrlProblem("https://www.hoteltrack.in")).toBeNull();
  });

  it("rejects an empty or whitespace value", () => {
    expect(appUrlProblem("")).toMatch(/empty/);
    expect(appUrlProblem("   ")).toMatch(/empty/);
  });

  it("rejects a non-absolute URL", () => {
    expect(appUrlProblem("hoteltrack.in")).toMatch(/absolute/);
    expect(appUrlProblem("/t.js")).toMatch(/absolute/);
  });

  it("rejects plain http", () => {
    expect(appUrlProblem("http://hoteltrack.in")).toMatch(/https/);
  });

  it("rejects local addresses — the localhost-in-a-real-email regression", () => {
    expect(appUrlProblem("http://localhost:3000")).toMatch(/https|local/);
    expect(appUrlProblem("https://localhost:3000")).toMatch(/local/);
    expect(appUrlProblem("https://127.0.0.1:3000")).toMatch(/local/);
  });

  it("rejects a preview deployment origin", () => {
    expect(appUrlProblem("https://hoteltrack-git-main.vercel.app")).toMatch(/preview/);
  });

  it("rejects the placeholder domain", () => {
    expect(appUrlProblem("https://your-domain.com")).toMatch(/placeholder/);
  });
});

describe("validatePlatformEnv app-URL gate (production)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to boot a production server with NEXT_PUBLIC_APP_URL unset", async () => {
    await expect(bootWith({ NEXT_PUBLIC_APP_URL: "" })).rejects.toThrow(
      /NEXT_PUBLIC_APP_URL .*empty/,
    );
  });

  it("refuses to boot with a localhost origin — the regression that shipped localhost to a hotel", async () => {
    await expect(bootWith({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" })).rejects.toThrow(
      /NEXT_PUBLIC_APP_URL/,
    );
  });

  it("refuses to boot with the placeholder domain", async () => {
    await expect(bootWith({ NEXT_PUBLIC_APP_URL: "https://your-domain.com" })).rejects.toThrow(
      /placeholder/,
    );
  });

  it("boots with a valid production origin", async () => {
    await expect(bootWith({ NEXT_PUBLIC_APP_URL: "https://hoteltrack.in" })).resolves.toBeUndefined();
  });

  it("does not gate non-production environments", async () => {
    await expect(
      bootWith({ NODE_ENV: "development", NEXT_PUBLIC_APP_URL: "http://localhost:3000" }),
    ).resolves.toBeUndefined();
  });
});

describe("hotelWelcomeEmail tracking snippet", () => {
  const mail = hotelWelcomeEmail({
    agencyName: "Social Hippi",
    hotelName: "Aster Holidays",
    hotelClientId: "hc_123",
    siteId: "site_abc123",
    agencyContact: null,
  });

  it("carries the siteId in the id query param, which is the only place t.js reads it", () => {
    // Entity-encoded because the snippet is rendered inside a <pre> block.
    expect(mail.html).toContain("/t.js?id=site_abc123");
  });

  it("does not use the data-ht-site attribute, which public/t.js never reads", () => {
    expect(mail.html).not.toContain("data-ht-site");
  });

  it("matches the tag shape the agency UI hands out", () => {
    expect(mail.html).toMatch(/&lt;script src="[^"]+\/t\.js\?id=site_abc123" async&gt;&lt;\/script&gt;/);
  });
});
