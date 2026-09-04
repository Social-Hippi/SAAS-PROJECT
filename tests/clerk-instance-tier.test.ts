import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// CLERK INSTANCE TIER GATE.
//
// A Clerk DEVELOPMENT instance (pk_test_ / sk_test_) is not merely a different
// key. clerk-js renders a persistent orange "Development mode" badge on every
// <SignIn/>, <SignUp/> and <UserButton/> — so the first screen a hotel owner or
// agency sees announces that the product is unfinished — and the instance is
// dev-rate-limited, which this app is already sensitive to (see the role-lookup
// cache in proxy.ts: "on a dev instance the limit makes the whole app hang").
//
// The gate must be precise in BOTH directions:
//   • it must block a real production deploy, and
//   • it must NOT block Vercel preview builds or local development, which
//     legitimately run NODE_ENV=production / dev keys and would otherwise all
//     start failing.
// ─────────────────────────────────────────────────────────────────────────────

/** Enough env to clear every check that runs BEFORE the tier gate. */
const BASE_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  AUTH_SECRET: "test-auth-secret",
  ENCRYPTION_KEY: "a".repeat(64),
  NEXT_PUBLIC_APP_URL: "https://hoteltrack.in",
  STRICT_ENV_VALIDATION: "",
  // Provider groups are fully unset → warn-only, never fatal (see PROVIDERS).
};

async function bootWith(env: Record<string, string | undefined>): Promise<void> {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...env })) {
    vi.stubEnv(k, v ?? "");
  }
  const mod = await import("@/lib/env-validation");
  mod.validatePlatformEnv();
}

const LIVE = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_realkey",
  CLERK_SECRET_KEY: "sk_live_realkey",
};
const DEV = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_devkey",
  CLERK_SECRET_KEY: "sk_test_devkey",
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("blocks a real production deploy", () => {
  it("throws when the publishable key is a dev instance", async () => {
    await expect(
      bootWith({ NODE_ENV: "production", VERCEL_ENV: "production", ...DEV }),
    ).rejects.toThrow(/Clerk DEVELOPMENT instance/);
  });

  it("names BOTH offending vars so the fix is unambiguous", async () => {
    await expect(
      bootWith({ NODE_ENV: "production", VERCEL_ENV: "production", ...DEV }),
    ).rejects.toThrow(/NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY/);
  });

  it("throws even when only the SECRET key is a dev instance", async () => {
    await expect(
      bootWith({
        NODE_ENV: "production",
        VERCEL_ENV: "production",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_realkey",
        CLERK_SECRET_KEY: "sk_test_devkey",
      }),
    ).rejects.toThrow(/CLERK_SECRET_KEY/);
  });

  it("explains the REDEPLOY requirement (NEXT_PUBLIC_ is inlined at build time)", async () => {
    await expect(
      bootWith({ NODE_ENV: "production", VERCEL_ENV: "production", ...DEV }),
    ).rejects.toThrow(/REDEPLOY/);
  });

  it("treats an absent VERCEL_ENV as production (fail closed)", async () => {
    await expect(
      bootWith({ NODE_ENV: "production", VERCEL_ENV: undefined, ...DEV }),
    ).rejects.toThrow(/Clerk DEVELOPMENT instance/);
  });
});

describe("does not block legitimate non-production environments", () => {
  it("allows a Vercel PREVIEW build on the dev instance (warns instead)", async () => {
    // Preview deploys also run NODE_ENV=production. Throwing here would break
    // every PR deploy, which is why the gate keys on VERCEL_ENV as well.
    await expect(
      bootWith({ NODE_ENV: "production", VERCEL_ENV: "preview", ...DEV }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Clerk DEVELOPMENT instance"));
  });

  it("allows local development on the dev instance (warns instead)", async () => {
    await expect(
      bootWith({ NODE_ENV: "development", VERCEL_ENV: "development", ...DEV }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Clerk DEVELOPMENT instance"));
  });

  it("allows an explicit opt-out for a staging env that intends the dev instance", async () => {
    await expect(
      bootWith({
        NODE_ENV: "production",
        VERCEL_ENV: "production",
        ALLOW_CLERK_DEV_INSTANCE: "1",
        ...DEV,
      }),
    ).resolves.toBeUndefined();
    // Still warns — an opt-out silences the failure, not the fact.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Clerk DEVELOPMENT instance"));
  });
});

describe("stays silent on a correctly configured production deploy", () => {
  it("does not throw and does not warn on live keys", async () => {
    await expect(
      bootWith({ NODE_ENV: "production", VERCEL_ENV: "production", ...LIVE }),
    ).resolves.toBeUndefined();
    const clerkWarnings = warn.mock.calls
      .flat()
      .filter((a: unknown) => typeof a === "string" && a.includes("Clerk DEVELOPMENT"));
    expect(clerkWarnings).toHaveLength(0);
  });
});
