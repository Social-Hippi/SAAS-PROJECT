import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import { KRAYA_EXPORT_DEFAULT_TIMEZONE, confirmedAtFromHistory } from "@/lib/kraya-import";

// ─────────────────────────────────────────────────────────────────────────────
// Kraya export times are the property's LOCAL wall-clock time.
//
// The export writes "2026-09-17 07:22:18" with no offset. Read as UTC it stored
// every imported time 5 h 30 min late for an IST property: a booking Kraya's
// webhook reported at 01:52:18 UTC came back from the export as 07:22:18 UTC,
// and 257 leads that messaged between 6:30 pm and midnight were dated to the
// following day.
// ─────────────────────────────────────────────────────────────────────────────

const IMPORT = readCode("lib/kraya-import.ts");
const ROUTE = readCode("app/api/integrations/kraya/import/route.ts");

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const REPAIR = readFileSync(
  join(
    MIGRATIONS,
    readdirSync(MIGRATIONS).find((d) => d.endsWith("_kraya_export_times_to_property_timezone"))!,
    "migration.sql",
  ),
  "utf8",
);

const history = (at: string) =>
  JSON.stringify({ stage_history: [{ updated: "Booking Confirmed", previous: "New Lead", updated_at: at }] });

describe("1. an export time names a moment in the property's timezone", () => {
  test("IST wall-clock is read as IST, not UTC", () => {
    // The real case: the webhook recorded 01:52:18 UTC.
    expect(
      confirmedAtFromHistory(history("2026-09-17 07:22:18"), "Booking Confirmed", "Asia/Kolkata")?.toISOString(),
    ).toBe("2026-09-17T01:52:18.000Z");
  });

  test("an evening IST time stays on its own day", () => {
    // 9 pm IST on 10 Sep is 15:30 UTC on 10 Sep — not 11 Sep.
    expect(
      confirmedAtFromHistory(history("2026-09-10 21:00:00"), "Booking Confirmed", "Asia/Kolkata")?.toISOString(),
    ).toBe("2026-09-10T15:30:00.000Z");
  });

  test("the timezone is the property's, so a non-IST property is read in its own", () => {
    expect(
      confirmedAtFromHistory(history("2026-01-15 09:00:00"), "Booking Confirmed", "Asia/Dubai")?.toISOString(),
    ).toBe("2026-01-15T05:00:00.000Z");
  });

  test("with no timezone given, the fallback is IST", () => {
    expect(KRAYA_EXPORT_DEFAULT_TIMEZONE).toBe("Asia/Kolkata");
    expect(confirmedAtFromHistory(history("2026-09-17 07:22:18"), "Booking Confirmed")?.toISOString()).toBe(
      "2026-09-17T01:52:18.000Z",
    );
  });
});

describe("2. the import passes the property's timezone all the way through", () => {
  test("no export date is parsed without a timezone", () => {
    expect(IMPORT).not.toMatch(/Date\.UTC\(\+m\[1\]/);
    expect(IMPORT).toMatch(/utcFromWallClock\(\+m\[1\], \+m\[2\], \+m\[3\], \+m\[4\], \+m\[5\], \+m\[6\], 0, tz\)/);
    expect(IMPORT).toMatch(/createdAt: parseDate\(row\[HEADERS\.createdAt\], timezone\)/);
    expect(IMPORT).toMatch(/stageUpdatedAt: parseDate\(row\[HEADERS\.stageUpdatedAt\], timezone\)/);
    expect(IMPORT).toMatch(/confirmedAtFromHistory\(row\[HEADERS\.history\], confirmedStageName, timezone\)/);
    expect(IMPORT).toMatch(/const d = parseDate\(row\.updated_at, tz\);/);
  });

  test("the upload route reads the hotel's timezone and hands it to the parser", () => {
    expect(ROUTE).toMatch(/select: \{ id: true, agencyId: true, timezone: true \}/);
    expect(ROUTE).toMatch(/safeTimeZone\(hotel\.timezone\)/);
  });
});

describe("3. the one-time repair", () => {
  test("touches only export-derived values — whole seconds — never a webhook's", () => {
    for (const col of ["firstMessageAt", "lastMessageAt"]) {
      expect(REPAIR).toContain(`date_trunc('second', c."${col}") = c."${col}"`);
    }
    expect(REPAIR).toContain(`date_trunc('second', b."bookedAt") = b."bookedAt"`);
  });

  test("converts through each property's own timezone, not a fixed offset", () => {
    expect(REPAIR).toContain(`(c."firstMessageAt" AT TIME ZONE h."timezone") AT TIME ZONE 'UTC'`);
    expect(REPAIR).toContain(`(c."lastMessageAt" AT TIME ZONE h."timezone") AT TIME ZONE 'UTC'`);
    expect(REPAIR).toContain(`(b."bookedAt" AT TIME ZONE h."timezone") AT TIME ZONE 'UTC'`);
    expect(REPAIR).not.toMatch(/interval\s+'5/i);
  });

  test("is limited to Kraya data", () => {
    expect(REPAIR).toMatch(/c\."krayaLeadId" IS NOT NULL\s+AND c\."connectionId" IS NULL/);
    expect(REPAIR).toMatch(/b\."provider" = 'kraya'/);
    // Nothing else is rewritten.
    const tables = [...REPAIR.matchAll(/^UPDATE "(\w+)"/gm)].map((m) => m[1]);
    expect(new Set(tables)).toEqual(new Set(["WhatsAppConversation", "Booking"]));
  });
});
