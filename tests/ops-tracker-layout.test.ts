import { describe, expect, test } from "vitest";

import { TRACKER_LAYOUTS, normaliseHeader } from "@/lib/ops-tracker/layouts";
import { DATE_COLUMN_INDEX, columnLetter, locateTrackerTable } from "@/lib/ops-tracker/locate";
import { parseTrackerPayload } from "@/lib/ops-tracker/parse";
import {
  CBH_MISSING,
  atColumnB,
  blank,
  cbhGrid,
  thGrid,
  thGridLegacy12Col,
} from "./helpers/tracker-fixtures";
import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// FINDING THE TABLE INSIDE A HAND-MAINTAINED SHEET.
//
// Both properties live in ONE workbook on two tabs, "CBH" and "3Hills", and the
// tabs are shaped differently:
//
//   CBH     title block rows 1-8,  header row 9,   data 10-39,
//           Total 40, Average 41,  columns B..O (14)
//   3Hills  title block rows 1-9,  BAND header 10, real header 11,
//           data 12-46, Total 47, Average 48, columns B..M (12),
//           plus a MONTHLY PERFORMANCE OVERVIEW table in O..T, one blank column
//           (N) away
//
// No row offset is right for both, and an offset that is right today is wrong
// the first time somebody inserts a row. The fixtures below reproduce both
// layouts so the ONE rule can be pinned against both, step by step.
//
// The failure this guards against is not a crash. It is a confident import of
// numbers under the wrong column names — which looks exactly like a healthy one.
// ─────────────────────────────────────────────────────────────────────────────

const CBH = TRACKER_LAYOUTS.cbh_v1;
const TH = TRACKER_LAYOUTS.three_hills_v1;

// ── 1 · The first data row is found by scanning column B for a date ─────────

describe("1. the first data row is the first row with a real date in column B", () => {
  test("CBH: row 10, stepping over an 8-row title block", () => {
    const got = locateTrackerTable(cbhGrid(), CBH);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // 0-based index 9 is spreadsheet row 10.
    expect(got.table.firstDataRowIndex).toBe(9);
  });

  test("3Hills: row 12, stepping over a 9-row title block AND a band header", () => {
    const got = locateTrackerTable(thGrid(), TH);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.table.firstDataRowIndex).toBe(11);
  });

  test("the KPI card numbers in the title block never look like a date", () => {
    // "248", "66", "14.5%" and "31 Jul to 5 Sep" all sit in column B above the
    // table. If any of them parsed as a date the scan would stop on a card.
    const got = locateTrackerTable(cbhGrid(), CBH);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.table.rows.map((r) => r[0])).not.toContain("248");
  });

  test("a tab with no dates at all is REFUSED, not imported as zero rows", () => {
    // An empty tab, a renamed tab and a tab whose dates are text all present
    // this way. Reporting a successful import of nothing is the one response
    // that would let the report go stale without anybody noticing.
    const titleOnly = cbhGrid().slice(0, 9);
    const got = locateTrackerTable(titleOnly, CBH);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.step).toBe(1);
    expect(got.reason).toMatch(/ZERO rows/);
  });
});

// ── 2 · The header is the row immediately above ─────────────────────────────

describe("2. the header row is the one directly above the first data row", () => {
  test("CBH picks row 9", () => {
    const got = locateTrackerTable(cbhGrid(), CBH);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.table.headerRowIndex).toBe(8);
    expect(got.table.header[0]).toBe("Date");
    expect(got.table.header[1]).toBe("CBH Enquiry");
  });

  test("3Hills picks row 11 — the REAL header, not the band above it", () => {
    const got = locateTrackerTable(thGrid(), TH);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.table.headerRowIndex).toBe(10);
    expect(got.table.header[1]).toBe("3Hills Enquiry");
  });

  test("the band header would have been found first by a text search, and is not the header", () => {
    // Proves the trap is real rather than hypothetical: row 10 contains "DATE",
    // so "find the row containing DATE" lands one row high.
    const grid = thGrid();
    const firstRowSayingDate = grid.findIndex((r) =>
      r.some((c) => normaliseHeader(c) === "date"),
    );
    expect(firstRowSayingDate).toBe(9);          // the band, one row too high

    const got = locateTrackerTable(grid, TH);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.table.headerRowIndex).toBe(10);   // the rule lands on the real one
  });
});

// ── 3 · Columns run rightward to the first empty header cell ────────────────

describe("3. the column span stops at the first empty header cell", () => {
  test("CBH spans B..O — 14 columns", () => {
    const got = locateTrackerTable(cbhGrid(), CBH);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.table.dateColumnIndex).toBe(DATE_COLUMN_INDEX);
    expect(columnLetter(got.table.dateColumnIndex)).toBe("B");
    expect(columnLetter(got.table.lastColumnIndex)).toBe("O");
    expect(got.table.header).toHaveLength(14);
  });

  test("3Hills spans B..N — 13 columns", () => {
    const got = locateTrackerTable(thGrid(), TH);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(columnLetter(got.table.lastColumnIndex)).toBe("N");
    expect(got.table.header).toHaveLength(13);
  });

  test("3Hills' MONTHLY PERFORMANCE OVERVIEW side table is excluded entirely", () => {
    const got = locateTrackerTable(thGrid(), TH);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.table.header.join(" | ")).not.toMatch(/MONTHLY PERFORMANCE/i);
    // And none of its cells leaked into a data row.
    for (const row of got.table.rows) {
      expect(row).toHaveLength(13);
      expect(row).not.toContain("August");
      expect(row).not.toContain("46.5%");
    }
  });

  test("the blank column past N is what separates them — it is load-bearing", () => {
    const grid = thGrid();
    // Column O (index 14) is the gap. Fill it and the side table is no longer
    // separated from the tracker.
    grid[10]![14] = "bridged";
    const got = locateTrackerTable(grid, TH);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.step).toBe(5); // caught as a column-set mismatch, not imported
  });
});

// ── 4 · Data stops at the first row without a date ──────────────────────────

describe("4. data rows stop before Total and Average", () => {
  test("CBH reads rows 10-39 and stops at the Total row", () => {
    const got = locateTrackerTable(cbhGrid(), CBH);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.table.lastDataRowIndex).toBe(38);   // spreadsheet row 39
    expect(got.table.rows).toHaveLength(30);
    const firstCells = got.table.rows.map((r) => r[0]);
    expect(firstCells).not.toContain("Total");
    expect(firstCells).not.toContain("Average");
  });

  test("3Hills reads rows 12-46 and stops at its Total row", () => {
    const got = locateTrackerTable(thGrid(), TH);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.table.lastDataRowIndex).toBe(45);   // spreadsheet row 46
    expect(got.table.rows).toHaveLength(35);
  });

  test("Total's 643 never becomes a day's Total Leads", () => {
    const got = locateTrackerTable(cbhGrid(), CBH);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const parsed = parseTrackerPayload(got.table.header, got.table.rows, CBH);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows.map((r) => r.values.storedTotalLeads)).not.toContain(643);
  });

  test("a dated row BELOW a break is refused rather than silently dropped", () => {
    // A blank separator row inside the data block would stop step 4 early. The
    // rows above it would import, the rows below would vanish, and the result
    // would be indistinguishable from the property not recording those days.
    const grid = cbhGrid();
    grid.splice(20, 0, blank(15));
    const got = locateTrackerTable(grid, CBH);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.step).toBe(4);
    expect(got.reason).toMatch(/silently dropped/);
  });
});

// ── 5 · The column set must match the layout, or the tab is rejected ────────

describe("5. a column-set mismatch rejects the whole tab", () => {
  test("both real layouts pass their own assertion", () => {
    expect(locateTrackerTable(cbhGrid(), CBH).ok).toBe(true);
    expect(locateTrackerTable(thGrid(), TH).ok).toBe(true);
  });

  test("the WRONG 12-column 3Hills shape is refused whole — the live regression", () => {
    // Exactly what the live tab met on its first push: a layout built for 12
    // columns with Low Budget and Less Room combined, against a real header of
    // 13 with them separate.
    //
    // ELEVEN of the thirteen columns were still individually recognisable. A
    // check that only asked "do I know this header?" would have mapped those and
    // shifted everything after the combined column — filing Less Room's numbers
    // under WhatsApp Leads, and so on down the row, for every day on the tab.
    // The whole-tab refusal is what turned a month of mislabelled dispositions
    // into a 422 and a corrected spec.
    const got = locateTrackerTable(thGridLegacy12Col(), TH);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.step).toBe(5);
    expect(got.reason).toMatch(/expects 13 columns \(B\.\.N\)/);
    expect(got.reason).toMatch(/spans 12 \(B\.\.M\)/);
  });

  test("the real 13-column shape passes where the 12-column one fails", () => {
    // The pair is the point: same tab, same fixture builder, one column apart.
    expect(locateTrackerTable(thGrid(), TH).ok).toBe(true);
    expect(locateTrackerTable(thGridLegacy12Col(), TH).ok).toBe(false);
  });

  test("each tab is rejected against the OTHER tab's layout", () => {
    // The two differ by more than a name: 14 columns vs 12, split vs combined
    // Low Budget / Less Room, and Total Leads existing on only one.
    const a = locateTrackerTable(cbhGrid(), TH);
    const b = locateTrackerTable(thGrid(), CBH);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok) expect(a.step).toBe(5);
    if (!b.ok) expect(b.step).toBe(5);
  });

  test("two columns SWAPPED is caught, though every header is individually known", () => {
    // This is the case a header-recognition check cannot see: no column is
    // unfamiliar, so nothing is 'unknown' — but every value after the swap lands
    // in the wrong field.
    const grid = cbhGrid();
    const h = grid[8]!;
    [h[8], h[9]] = [h[9]!, h[8]!];   // Low Budget <-> Less Room
    const got = locateTrackerTable(grid, CBH);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.step).toBe(5);
    expect(got.reason).toMatch(/low budget/);
  });

  test("an inserted column is caught, and the message names the span it found", () => {
    const grid = cbhGrid();
    grid[8]!.splice(3, 0, "New Column");
    grid.slice(9, 39).forEach((r) => r.splice(3, 0, "0"));
    const got = locateTrackerTable(grid, CBH);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.step).toBe(5);
    expect(got.reason).toMatch(/expects 14 columns \(B\.\.O\)/);
    expect(got.reason).toMatch(/spans 15 \(B\.\.P\)/);
    expect(got.reason).toContain("New Column");   // the header is quoted back
  });

  test("a RENAMED column is caught, and the message names the position", () => {
    // Same column count, so this is the case that reaches the position check.
    const grid = cbhGrid();
    grid[8]![12] = "Total Enquiries";             // was "Total Calls Received"
    const got = locateTrackerTable(grid, CBH);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.step).toBe(5);
    expect(got.reason).toContain("column M");
    expect(got.reason).toContain("total calls received");
    expect(got.reason).toContain("Total Enquiries");
  });

  test("a stray date in the title block cannot cause a silent misread", () => {
    // Step 1 stops on the stray date, five rows above the real table. What
    // catches it is step 4, not step 5: reading down from the stray row hits a
    // non-date immediately, and the real data is then sitting BELOW the break —
    // the exact silent-truncation shape the guard exists for. Either way the tab
    // is refused with a reason, which is the property that matters.
    const grid = cbhGrid();
    grid[3] = atColumnB(["2026-08-01", "99"]);
    const got = locateTrackerTable(grid, CBH);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.step).toBe(4);
    expect(got.reason).toMatch(/silently dropped/);
  });
});

// ── The data realities the sheets actually carry ────────────────────────────

describe("6. missing dates are unrecorded; partial rows import what exists", () => {
  test("CBH's absent days are absent, not zero", () => {
    const got = locateTrackerTable(cbhGrid(), CBH);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const parsed = parseTrackerPayload(got.table.header, got.table.rows, CBH);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const dates = new Set(parsed.rows.map((r) => r.date));
    for (const missing of CBH_MISSING) expect(dates.has(missing)).toBe(false);
    // No row was invented to fill the gap.
    expect(parsed.rows).toHaveLength(30);
  });

  test("6-8 Sep import their counts and leave Total Leads unavailable", () => {
    const got = locateTrackerTable(cbhGrid(), CBH);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const parsed = parseTrackerPayload(got.table.header, got.table.rows, CBH);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const partial = parsed.rows.filter((r) => r.date >= "2026-09-06");
    expect(partial).toHaveLength(3);
    for (const row of partial) {
      expect(row.values.enquiries).toBe(8);              // what exists is imported
      expect(row.values.totalCallsReceived).toBe(9);
      expect(row.values.storedTotalLeads).toBeNull();    // what does not is null
      expect(row.values.storedConversionRate).toBeNull();
    }
    expect(parsed.rejected).toEqual([]);                 // a partial row is not an error
  });
});

// ── The layout declarations cannot drift from each other ────────────────────

describe("7. layout invariants", () => {
  test("every expected header maps to a field, and every field is expected", () => {
    for (const layout of Object.values(TRACKER_LAYOUTS)) {
      expect([...layout.expectedHeader].sort()).toEqual(Object.keys(layout.columns).sort());
      for (const key of layout.expectedHeader) {
        expect(normaliseHeader(key), `${layout.id}: "${key}" is not normalised`).toBe(key);
      }
    }
  });

  test("CBH has 14 columns, 3Hills 13 — Total Leads is the ONLY difference", () => {
    expect(CBH.expectedHeader).toHaveLength(14);
    expect(TH.expectedHeader).toHaveLength(13);
    expect(CBH.expectedHeader).toContain("total leads");
    expect(TH.expectedHeader).not.toContain("total leads");
    // 3Hills is CBH minus Total Leads and nothing else — so removing that one
    // column from CBH's header must yield 3Hills', apart from the property-named
    // enquiry column.
    const cbhWithoutTotalLeads = CBH.expectedHeader
      .filter((h) => h !== "total leads")
      .map((h) => (h === "cbh enquiry" ? "enquiry" : h));
    const th = TH.expectedHeader.map((h) => (h === "3hills enquiry" ? "enquiry" : h));
    expect(th).toEqual(cbhWithoutTotalLeads);
  });

  test("BOTH tabs keep Low Budget and Less Room as separate columns", () => {
    // 3Hills was believed to combine them. It does not. Nothing maps to a
    // combined field any more, on either tab.
    for (const layout of [CBH, TH]) {
      expect(layout.expectedHeader).toContain("low budget");
      expect(layout.expectedHeader).toContain("less room");
      expect(layout.expectedHeader).not.toContain("low budget less room");
      expect(Object.values(layout.columns)).toContain("lowBudget");
      expect(Object.values(layout.columns)).toContain("lessRoom");
      expect(Object.values(layout.columns)).not.toContain("lowBudgetLessRoom");
    }
  });
});

// ── The routing config, pinned against the names on the tab strip ───────────

describe("8. the workbook and tab names in the seed config", () => {
  const seed = readCode("scripts/seed-property-segments.ts");

  test("both properties point at ONE spreadsheet", () => {
    expect(seed).toContain('const TRACKER_SPREADSHEET_ID = "1udjgKPY6i5piW627rwV_bWDvp5mjquHTNn_b4I7_QD0"');
    expect(seed.match(/sourceSheetId: TRACKER_SPREADSHEET_ID/g)).toHaveLength(2);
  });

  test('the tabs are "CBH" and "3Hills", exactly', () => {
    expect(seed).toContain('sourceTabName: "CBH"');
    expect(seed).toContain('sourceTabName: "3Hills"');
  });

  test("the names that matched nothing are gone", () => {
    // "Aster | Call Reports Tracker" is the FILE name; "3hills tracker" is a tab
    // in a different file. Both would have routed to no segment and imported
    // zero rows without erroring.
    expect(seed).not.toContain("Aster | Call Reports Tracker");
    expect(seed).not.toContain("3hills tracker");
    expect(seed).not.toContain("143UeHzcX7kJalj1-ar838cPiYt_9CaR3nbsUSW7pw7U");
  });
});

// ── The Apps Script is not reachable by vitest; pin its contract in source ──

describe("9. the bundled Apps Script", () => {
  const gs = readCode("docs/ops-tracker/apps-script.gs");

  test("it pushes both tabs from the one bound workbook", () => {
    expect(gs).toContain("var TABS = ['CBH', '3Hills']");
  });

  test("a missing or renamed tab THROWS rather than logging and returning", () => {
    // Only a thrown error fires the trigger's failure notification. Logging and
    // returning leaves a green run and a report that quietly stops updating.
    expect(gs).toMatch(/if \(!sheet\) \{[\s\S]*?throw new Error/);
  });

  test("it sends the raw grid and does not decide where the table starts", () => {
    expect(gs).toContain("grid: grid");
    // No header/row splitting on that side: the rule lives in locate.ts.
    expect(gs).not.toMatch(/header:\s*(header|display\[0\])/);
  });
});
