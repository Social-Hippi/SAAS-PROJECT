import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// EVERY SCHEDULED CRON MUST BE REACHABLE.
//
// /api/google-ads/sync was scheduled in vercel.json (daily, 15 5 * * *) and
// absent from isPublicRoute. Clerk answered the session-less cron with a 307 to
// /sign-in BEFORE the route's own CRON_SECRET check could run, and Vercel logged
// the 307 as a delivered invocation — so the job never ran in production and
// nothing reported an error. It shipped that way.
//
// The two lists are edited in different files for different reasons: someone
// adds a schedule to vercel.json, someone else maintains an auth allowlist in
// proxy.ts. Nothing but this test connects them.
//
// This asserts reachability ONLY. Whether a route then authenticates its caller
// is the route's own business — each of these checks a CRON_SECRET bearer token
// itself, which is exactly why they may be public.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = join(__dirname, "..");

const CRON_PATHS: string[] = (
  JSON.parse(readFileSync(join(REPO_ROOT, "vercel.json"), "utf8")) as {
    crons?: { path: string }[];
  }
).crons?.map((c) => c.path) ?? [];

/** The string literals inside `createRouteMatcher([...])` for isPublicRoute. */
function publicRoutePatterns(proxySource: string): string[] {
  const marker = "const isPublicRoute = createRouteMatcher([";
  const start = proxySource.indexOf(marker);
  if (start === -1) throw new Error("isPublicRoute array not found in proxy.ts");
  const end = proxySource.indexOf("]);", start);
  if (end === -1) throw new Error("isPublicRoute array is not terminated");
  return [...proxySource.slice(start + marker.length, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Does `pattern` make `path` public?
 *
 * DELIBERATELY STRICTER THAN A PREFIX TEST. isPublicRoute contains "/", so
 * `path.startsWith(pattern)` is true for EVERY path — a naive matcher reports
 * every cron reachable and this test goes green against a proxy that blocks all
 * of them. That failure is silent and total, so the rule is:
 *
 *   • a plain pattern matches its path EXACTLY;
 *   • a "(.*)"-suffixed pattern matches its base, or the base followed by "/".
 *
 * The trailing "/" matters as much as the rest: without it "/h(.*)" would claim
 * "/hotel". Clerk's own matcher is looser than this — it would accept both — but
 * a test that can only err toward FAILING is the one worth having here.
 */
function matches(pattern: string, path: string): boolean {
  if (pattern.endsWith("(.*)")) {
    const base = pattern.slice(0, -"(.*)".length);
    return path === base || path.startsWith(`${base}/`);
  }
  return path === pattern;
}

const PUBLIC_PATTERNS = publicRoutePatterns(readCode("proxy.ts"));

describe("every vercel.json cron path is public in proxy.ts", () => {
  test("both lists were actually parsed", () => {
    // A parse that silently yields [] would make every assertion below vacuous.
    expect(CRON_PATHS.length).toBeGreaterThan(0);
    expect(PUBLIC_PATTERNS.length).toBeGreaterThan(0);
    expect(PUBLIC_PATTERNS).toContain("/");
  });

  test.each(CRON_PATHS)("%s is reachable without a session", (path) => {
    const hit = PUBLIC_PATTERNS.find((p) => matches(p, path));
    expect(
      hit,
      `${path} is scheduled in vercel.json but no isPublicRoute entry matches it. ` +
        `Clerk will 307 the cron to /sign-in before its CRON_SECRET check runs, and ` +
        `Vercel will log that redirect as a successful invocation.`,
    ).toBeDefined();
  });
});

describe("the matcher itself cannot rot into a prefix test", () => {
  // If these ever pass, the assertions above stop meaning anything.
  test('"/" does not make every path public', () => {
    expect(matches("/", "/api/google-ads/sync")).toBe(false);
    expect(matches("/", "/")).toBe(true);
  });

  test("a wildcard matches its own base and children, not a longer sibling", () => {
    expect(matches("/h(.*)", "/h")).toBe(true);
    expect(matches("/h(.*)", "/h/abc123")).toBe(true);
    expect(matches("/h(.*)", "/hotel")).toBe(false);
  });

  test("a plain pattern matches only itself", () => {
    expect(matches("/privacy-policy", "/privacy-policy")).toBe(true);
    expect(matches("/privacy-policy", "/privacy-policy/v2")).toBe(false);
  });
});
