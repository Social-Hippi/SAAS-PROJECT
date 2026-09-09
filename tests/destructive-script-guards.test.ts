import { describe, expect, test } from "vitest";

// NOT imported from the script: it calls main() on import, so a test that
// pulled it in would RUN the deletions.
import { databaseHost, destructiveRunRefusal, isLocalDatabase } from "@/lib/db-environment";
import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// A SCRIPT THAT DELETES HOTELS MUST BE INCAPABLE OF RUNNING AGAINST PRODUCTION.
//
// cleanup-demo-data.ts deletes hotels (cascading their snapshots, reports,
// content and share links) and rewrites agency history. It used to pick its
// target with findFirst({ where: { name } }) — and agency names are not unique,
// because this very script created the collision by renaming one agency to
// "Social Hippi" while another already had that name.
//
// Refusing to GUESS was not enough. Two independent conditions must now both
// hold before it touches anything, and neither involves a name.
// ─────────────────────────────────────────────────────────────────────────────

describe("1. the guard fails CLOSED — only local is allowed", () => {
  const noOverride = {} as NodeJS.ProcessEnv;

  test("the REAL production endpoint is refused", () => {
    // The regression this replaces: the first version matched a hardcoded
    // endpoint id taken from a stale comment in .env.local, and production is a
    // different endpoint entirely. Against the live URL it returned "not
    // production" and would have let the deletions run.
    const REAL = "postgresql://u:p@ep-mute-night-apvo5dg4.c-7.us-east-1.aws.neon.tech/neondb";
    expect(isLocalDatabase(REAL)).toBe(false);
    expect(destructiveRunRefusal(REAL, noOverride)).toMatch(/not a local database/);
  });

  test("an endpoint nobody has heard of yet is refused", () => {
    // The point of inverting the rule: being wrong costs a refusal, not data.
    expect(destructiveRunRefusal("postgresql://u:p@ep-brand-new-branch.neon.tech/db", noOverride))
      .toMatch(/not a local database/);
  });

  test("an absent or unparseable URL is refused, not treated as safe", () => {
    expect(isLocalDatabase(undefined)).toBe(false);
    expect(destructiveRunRefusal(undefined, noOverride)).toBeTruthy();
    expect(destructiveRunRefusal("not a url", noOverride)).toBeTruthy();
  });

  test("local databases are allowed", () => {
    for (const url of [
      "postgresql://me@localhost:5432/hoteltrack",
      "postgresql://me@127.0.0.1:5432/hoteltrack",
    ]) {
      expect(isLocalDatabase(url), url).toBe(true);
      expect(destructiveRunRefusal(url, noOverride), url).toBeNull();
    }
  });

  test("a deliberate remote run needs an explicit environment opt-in", () => {
    const remote = "postgresql://u:p@staging.example.com/db";
    expect(destructiveRunRefusal(remote, noOverride)).toBeTruthy();
    expect(destructiveRunRefusal(remote, { ALLOW_DESTRUCTIVE_ON_REMOTE: "1" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  test("the hostname is extracted for the refusal message, without the port", () => {
    expect(databaseHost("postgresql://u:p@db.example.com:5432/x?sslmode=require")).toBe("db.example.com");
    expect(databaseHost("postgresql://me@localhost:5432/hoteltrack")).toBe("localhost");
  });
});

describe("2. both guards run before any database work", () => {
  const src = readCode("scripts/cleanup-demo-data.ts");

  test("the production check and the id check precede the first query", () => {
    const prodGuard = src.indexOf("destructiveRunRefusal(process.env.DATABASE_URL)");
    const idGuard = src.indexOf("if (!agencyId)");
    const firstQuery = src.indexOf("prisma.agency.findUnique");
    expect(prodGuard).toBeGreaterThan(-1);
    expect(idGuard).toBeGreaterThan(-1);
    expect(firstQuery).toBeGreaterThan(prodGuard);
    expect(firstQuery).toBeGreaterThan(idGuard);
  });

  test("each refusal exits non-zero and says nothing was deleted", () => {
    expect(src).toMatch(/REFUSING TO RUN: \$\{refusal\}/);
    expect(src).toMatch(/REFUSING TO RUN: pass --agency-id/);
    const refusals = src.split("REFUSING TO RUN").length - 1;
    expect(refusals).toBe(2);
    expect(src.match(/Nothing was read and nothing was deleted/g)?.length).toBe(2);
    // And the guard is the fail-closed one, not an endpoint allowlist.
    expect(src).not.toContain("isProductionDatabase");
    expect(src).toContain("process.exit(1)");
  });

  test("it reads DATABASE_URL through load-env, not dotenv/config", () => {
    // .env is empty in this repo, so "dotenv/config" left DATABASE_URL
    // undefined — and a production guard that cannot see the connection string
    // is not a guard.
    expect(src).toContain('import "./load-env"');
    expect(src).not.toContain('import "dotenv/config"');
  });
});
