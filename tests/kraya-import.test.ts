import { readFileSync, existsSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import { confirmedAtFromHistory, parseKrayaExport, stageNamesIn } from "@/lib/kraya-import";

// ─────────────────────────────────────────────────────────────────────────────
// Reading Kraya's lead export.
//
// This file does two jobs, and the second is why it is not a one-off script.
//
//   BACKFILL — Kraya's API is POST-only. Both endpoints push data INTO Kraya and
//   none reads leads out, so the webhook starts from empty and everything that
//   existed before it was enabled is unreachable by any other route.
//
//   RECONCILIATION — Kraya retries a failed delivery twice, then drops it
//   permanently. With no read endpoint there is no catch-up query, so a deploy
//   at the wrong moment loses leads silently and re-importing is the only repair.
//
// The export also carries timestamps the webhook does not, which is what lets an
// imported booking be dated to when it was actually confirmed.
// ─────────────────────────────────────────────────────────────────────────────

const IMPORT = readCode("lib/kraya-import.ts");
const ROUTE = readCode("app/api/integrations/kraya/import/route.ts");
const INGEST = readCode("lib/kraya-ingest.ts");

const HISTORY = JSON.stringify({
  stage_history: [
    { updated: "New Lead", previous: "No Stage", updated_at: "2026-08-17 12:52:01" },
    { updated: "Booking Confirmed", previous: "New Lead", updated_at: "2026-08-18 18:32:54" },
    { updated: "Inhouse", previous: "Booking Confirmed", updated_at: "2026-09-02 09:00:00" },
    { updated: "Booking Confirmed", previous: "Inhouse", updated_at: "2026-09-10 11:00:00" },
  ],
});

describe("1. dating a booking from its own history", () => {
  test("uses the FIRST time it reached the stage", () => {
    // A lead moved out of the confirmed stage and back again was booked on the
    // earlier date; the later one is a correction, not a second booking.
    // "2026-08-18 18:32:54" is IST wall-clock time, so the instant is 13:02:54
    // UTC. This assertion used to expect 18:32:54Z — it pinned the bug that
    // stored every imported time 5 h 30 min late.
    expect(confirmedAtFromHistory(HISTORY, "Booking Confirmed")?.toISOString()).toBe(
      "2026-08-18T13:02:54.000Z",
    );
  });

  test("matches the stage name case-insensitively", () => {
    expect(confirmedAtFromHistory(HISTORY, "booking confirmed")).not.toBeNull();
  });

  test.each([
    ["absent history", null],
    ["not JSON", "{oops"],
    ["no stage_history key", '{"other":[]}'],
    ["stage never reached", HISTORY],
  ])("%s yields null rather than a wrong date", (label, h) => {
    const stage = label === "stage never reached" ? "Won" : "Booking Confirmed";
    expect(confirmedAtFromHistory(h, stage)).toBeNull();
  });

  test("no confirmed stage configured means no date", () => {
    expect(confirmedAtFromHistory(HISTORY, null)).toBeNull();
  });
});

describe("2. the parser's rules", () => {
  test("columns are matched by header name, never by position", () => {
    // Export column order follows whichever custom attributes the hotel has
    // configured, and changes the moment they add one.
    expect(IMPORT).toMatch(/const HEADERS = \{/);
    expect(IMPORT).toMatch(/phone: "Phone number"/);
    expect(IMPORT).toMatch(/sourceId: "wa_ref_source_id"/);
  });

  test("a row with no phone is skipped WITH a reason, not dropped", () => {
    // Kraya's own model keys on phone; a row without one cannot be identified,
    // deduplicated, or matched to a booking.
    expect(IMPORT).toMatch(/reason: "no phone number"/);
  });

  test("timestamps are read in the property's timezone, not as UTC", () => {
    // Kraya writes local wall-clock with no zone. This once read it as UTC and
    // left the timezone to "the report edge" — which only works if every Kraya
    // time comes from an export. The webhook stamps real instants, and the two
    // are compared (which stage is newer; did the first message precede the
    // booking), so a stored export time must be the real instant too. Read as
    // UTC, an IST property's times were stored 5 h 30 min late.
    expect(IMPORT).not.toMatch(/Date\.UTC\(\+m\[1\]/);
    expect(IMPORT).toMatch(/utcFromWallClock\(/);
  });
});

describe("3. the same booking must not arrive twice", () => {
  test("bookings are keyed on the phone hash, not Kraya's lead id", () => {
    // The webhook knows the numeric lead id; the export carries none. Keying on
    // the id would file one guest's booking twice and a backfill would silently
    // double every confirmed booking it touched.
    expect(INGEST).toMatch(/const externalBookingId = phoneHash;/);
    expect(INGEST).not.toMatch(/externalBookingId: lead\.leadId/);
  });

  test("a second import updates the existing booking rather than adding one", () => {
    // Asserted on the branch itself, not on a comment claiming it: readCode
    // strips comments precisely so prose cannot satisfy a source assertion.
    expect(INGEST).toMatch(/if \(priorBooking\) \{[\s\S]{0,160}scopedBooking\.update/);
    expect(INGEST).toMatch(/booking = "updated"/);
  });
});

describe("4. the import route", () => {
  test("is session-authenticated and agency-scoped, unlike the webhook", () => {
    expect(ROUTE).toContain("requireAdmin");
    expect(ROUTE).toMatch(/agencyScoped\(prisma\.hotelClient\)/);
  });

  test("refuses before Kraya is connected", () => {
    // Without the confirmed-stage setting the import would quietly produce no
    // bookings at all.
    expect(ROUTE).toMatch(/Connect Kraya first/);
  });

  test("one bad row does not abandon the rest", () => {
    expect(ROUTE).toMatch(/failed \+= 1/);
  });

  test("a booking with unreadable history still imports", () => {
    // Dropping it to avoid an imprecise date would understate the total.
    expect(ROUTE).toMatch(/lead\.confirmedAt \?\? lead\.stageUpdatedAt/);
  });
});

// ── Against the real exports, when they are present ────────────────────────
//
// These are the actual files from Aster's Kraya account. Skipped where absent,
// so the suite still runs on a machine that does not have them.

const FIXTURES = [
  ["3Hills", "/Users/apple/Downloads/leads-20260916121432.xlsx", 492, 57, 57],
  ["Coffeeberry", "/Users/apple/Downloads/leads-20260916122018.xlsx", 546, 22, 64],
] as const;

describe("5. real Kraya exports", () => {
  for (const [name, path, rows, withAd, confirmed] of FIXTURES) {
    const run = existsSync(path) ? test : test.skip;

    run(`${name}: every row parses`, () => {
      const r = parseKrayaExport(readFileSync(path), "Booking Confirmed");
      expect(r.rows).toBe(rows);
      expect(r.leads).toHaveLength(rows);
      expect(r.skipped).toHaveLength(0);
    });

    run(`${name}: the ad id comes through on every ad-sourced lead`, () => {
      const r = parseKrayaExport(readFileSync(path), "Booking Confirmed");
      const ads = r.leads.filter((l) => l.referral);
      expect(ads).toHaveLength(withAd);
      // ctwa_clid names the CLICK; only source_id names the AD, which is what
      // joins to campaign spend.
      expect(ads.every((l) => l.referral?.sourceId)).toBe(true);
    });

    run(`${name}: every confirmed booking is dated from its history`, () => {
      const r = parseKrayaExport(readFileSync(path), "Booking Confirmed");
      const conf = r.leads.filter((l) => l.stage === "Booking Confirmed");
      expect(conf).toHaveLength(confirmed);
      expect(conf.every((l) => l.confirmedAt != null)).toBe(true);
    });

    run(`${name}: stage names are returned verbatim`, () => {
      const r = parseKrayaExport(readFileSync(path), "Booking Confirmed");
      const names = stageNamesIn(r).map((s) => s.name);
      expect(names.length).toBeGreaterThan(10);
      // The two pipelines genuinely spell these differently; neither is mapped.
      expect(names.some((n) => /^Sold out/.test(n))).toBe(true);
    });
  }
});

// ── 6. The ad id must survive the spreadsheet ──────────────────────────────
//
// A Meta ad id is 18 digits, and Kraya's export writes it as a NUMERIC cell.
// Both ordinary ways of reading that destroy it, silently:
//
//   formatted text  ->  "1.20242E+17"        Excel's General format renders
//                                            anything past 11 digits in
//                                            scientific notation
//   parsed value    ->  120241573189260240   the true id ends 234; 1.2e17 is far
//                                            past Number.MAX_SAFE_INTEGER, so the
//                                            final digits are rounded away
//
// Neither errors. The id simply becomes a DIFFERENT id and joins to no campaign
// — and this reached production: 80 conversations were imported carrying
// "1.20251E+17" before it was caught. Ids from the webhook were unaffected,
// because JSON carries them as strings.

describe("6. ad ids survive the export round-trip", () => {
  test.each(FIXTURES.map(([n, p]) => [n, p] as const))(
    "%s: every stored ad id is full digits, never scientific notation",
    (_name, path) => {
      if (!existsSync(path)) return;
      const r = parseKrayaExport(readFileSync(path), "Booking Confirmed");
      const ids = r.leads.map((l) => l.referral?.sourceId).filter(Boolean) as string[];
      for (const id of ids) {
        expect(id).toMatch(/^\d{10,}$/);
        expect(id).not.toMatch(/[Ee]\+/);
      }
    },
  );

  test("the exact digits are read from the sheet XML, not the parsed cell", () => {
    expect(IMPORT).toMatch(/bookFiles: true/);
    expect(IMPORT).toMatch(/function exactNumericCells/);
    // Shared-string cells hold an INDEX in <v>, not a value, so they must not be
    // harvested as though they were numbers.
    expect(IMPORT).toMatch(/\(\?!\[\^>\]\*\\b?t="\)/);
  });

  test("a corrupted id is dropped rather than stored as a different ad", () => {
    // Wrong attribution is worse than none: nothing downstream could tell.
    expect(IMPORT).toMatch(/function exactId/);
    expect(IMPORT).toMatch(/Ee\]\[\+-\]/);
  });
});

describe("7. the page reflects what was just imported", () => {
  test("the import revalidates the integrations page", () => {
    // The import is a fetch() to a route handler, so nothing revalidates on its
    // behalf. Without this the confirmed-stage dropdown keeps offering the
    // handful of stages that had arrived by webhook, and an operator who has
    // just imported 4,000 leads cannot find the stage they imported.
    expect(ROUTE).toMatch(/revalidatePath\(`\/agency\/hotel\/\$\{hotel\.id\}\/integrations`\)/);
  });
});
