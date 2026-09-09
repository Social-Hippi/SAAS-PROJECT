import { describe, expect, test } from "vitest";

// NOT imported from the script: it calls main() on import, so a test that
// pulled it in would RUN the deletions.
import { databaseHost, isProductionDatabase } from "@/lib/db-environment";
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

describe("1. the production database is recognised", () => {
  test("both the pooled and direct production hosts are caught", () => {
    // They differ only by a `-pooler` infix, so the endpoint id is matched.
    expect(isProductionDatabase("postgresql://u:p@ep-sweet-river-apbl49f2-pooler.c-7.us-east-1.aws.neon.tech/neondb")).toBe(true);
    expect(isProductionDatabase("postgresql://u:p@ep-sweet-river-apbl49f2.c-7.us-east-1.aws.neon.tech/neondb")).toBe(true);
  });

  test("a local or other database is not", () => {
    expect(isProductionDatabase("postgresql://me@localhost:5432/hoteltrack")).toBe(false);
    expect(isProductionDatabase("postgresql://u:p@ep-some-other-branch.neon.tech/neondb")).toBe(false);
  });

  test("an absent or unparseable URL is not mistaken for safe-and-known", () => {
    // It reports "not production", and the missing --agency-id guard still
    // stops the run — the two conditions are independent on purpose.
    expect(isProductionDatabase(undefined)).toBe(false);
    expect(databaseHost(undefined)).toBe("");
    expect(databaseHost("not a url")).toBe("");
  });

  test("the hostname is extracted for the refusal message, without the port", () => {
    expect(databaseHost("postgresql://u:p@db.example.com:5432/x?sslmode=require")).toBe("db.example.com");
    expect(databaseHost("postgresql://me@localhost:5432/hoteltrack")).toBe("localhost");
  });
});

describe("2. both guards run before any database work", () => {
  const src = readCode("scripts/cleanup-demo-data.ts");

  test("the production check and the id check precede the first query", () => {
    const prodGuard = src.indexOf("isProductionDatabase(process.env.DATABASE_URL)");
    const idGuard = src.indexOf("if (!agencyId)");
    const firstQuery = src.indexOf("prisma.agency.findUnique");
    expect(prodGuard).toBeGreaterThan(-1);
    expect(idGuard).toBeGreaterThan(-1);
    expect(firstQuery).toBeGreaterThan(prodGuard);
    expect(firstQuery).toBeGreaterThan(idGuard);
  });

  test("each refusal exits non-zero and says nothing was deleted", () => {
    expect(src).toMatch(/REFUSING TO RUN: DATABASE_URL points at the production database/);
    expect(src).toMatch(/REFUSING TO RUN: pass --agency-id/);
    const refusals = src.split("REFUSING TO RUN").length - 1;
    expect(refusals).toBe(2);
    expect(src.match(/Nothing was read and nothing was deleted/g)?.length).toBe(2);
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
