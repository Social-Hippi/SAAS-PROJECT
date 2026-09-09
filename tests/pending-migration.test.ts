import { describe, expect, test, vi } from "vitest";

import { whenMigrated } from "@/lib/missing-table";
import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// A PENDING MIGRATION MUST NOT BE AN OUTAGE.
//
// Migrations here are applied by hand, separately from the deploy. So there is
// always a window where the CODE knows about a table the DATABASE does not — a
// preview deployment pointed at the production database, or a deploy that lands
// before someone runs the migration.
//
// That window took the whole dashboard down on this branch: every hotel page
// answered "Something went wrong loading this page", because loading a hotel
// called prisma.propertySegment.findMany() and Prisma threw P2021. A NEW,
// OPTIONAL FEATURE MUST NEVER TAKE DOWN THE PAGE IT WAS ADDED TO.
// ─────────────────────────────────────────────────────────────────────────────

const prismaError = (code: string) => Object.assign(new Error(`Prisma ${code}`), { code });

describe("1. whenMigrated swallows exactly the schema-behind errors", () => {
  test("a missing TABLE yields the fallback", async () => {
    const out = await whenMigrated("segments", ["fallback"], async () => {
      throw prismaError("P2021");
    });
    expect(out).toEqual(["fallback"]);
  });

  test("a missing COLUMN yields the fallback", async () => {
    const out = await whenMigrated("segments", [], async () => {
      throw prismaError("P2022");
    });
    expect(out).toEqual([]);
  });

  test("a successful query is passed straight through", async () => {
    const out = await whenMigrated("segments", [], async () => [1, 2, 3]);
    expect(out).toEqual([1, 2, 3]);
  });
});

describe("2. it does NOT hide real faults", () => {
  test("a connection failure still throws", async () => {
    await expect(
      whenMigrated("segments", [], async () => {
        throw prismaError("P1001"); // cannot reach the database
      }),
    ).rejects.toThrow();
  });

  test("a constraint violation still throws", async () => {
    await expect(
      whenMigrated("segments", [], async () => {
        throw prismaError("P2002"); // unique constraint
      }),
    ).rejects.toThrow();
  });

  test("a plain error with no code still throws", async () => {
    await expect(
      whenMigrated("segments", [], async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  test("a pending migration is LOGGED, not silently absorbed", async () => {
    // Somebody has to go and run the migration. Absorbing it without a trace
    // would turn this into the silent failure it exists to prevent.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await whenMigrated("operations tracker", [], async () => {
      throw prismaError("P2021");
    });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain("MIGRATION-PENDING");
    expect(String(warn.mock.calls[0]?.[1])).toContain("operations tracker");
    warn.mockRestore();
  });
});

describe("3. every client-facing query on a new table is guarded", () => {
  test("the dashboard's segment lookup cannot throw on a pending migration", () => {
    const src = readCode("components/dashboard/FullHotelDashboard.tsx");
    const at = src.indexOf("prisma.propertySegment");
    expect(at).toBeGreaterThan(-1);
    // The guard must WRAP the call, so look backwards from it.
    expect(src.slice(Math.max(0, at - 400), at)).toContain("whenMigrated");
  });

  test("every contact-report query on a new table is wrapped", () => {
    const src = readCode("lib/metrics/contact-report.ts");
    for (const model of ["prisma.manualLeadDaily", "prisma.propertySegment"]) {
      let from = 0;
      for (;;) {
        const at = src.indexOf(model, from);
        if (at === -1) break;
        expect(src.slice(Math.max(0, at - 400), at), `${model} @ ${at}`).toContain("whenMigrated");
        from = at + model.length;
      }
    }
  });

  test("the INGEST path is deliberately NOT guarded", () => {
    // Silently accepting a payload with nowhere to store it would be worse than
    // refusing it: the sheet's owner would believe the data had landed.
    const src = readCode("lib/ops-tracker/ingest.ts");
    expect(src).not.toContain("whenMigrated");
  });
});
