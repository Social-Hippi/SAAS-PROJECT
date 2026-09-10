import { normaliseHeader, type TrackerLayout } from "@/lib/ops-tracker/layouts";
import { parseTrackerDate } from "@/lib/ops-tracker/parse";

// ─────────────────────────────────────────────────────────────────────────────
// FINDING THE TABLE INSIDE THE SHEET.
//
// The two tracker tabs live in one workbook and do NOT share a shape:
//
//   CBH     title block rows 1-8,  header row 9,             data 10-39,
//           Total 40, Average 41, columns B..O (14)
//   3Hills  title block rows 1-9,  BAND header row 10,
//           real header row 11,    data 12-46,
//           Total 47, Average 48, columns B..M (12),
//           plus a separate MONTHLY PERFORMANCE OVERVIEW table in O..T with one
//           blank column (N) between it and the tracker
//
// So there is no row offset that is correct for both, and any offset written
// down today is wrong the first time somebody inserts a row above the table —
// which, on a hand-maintained sheet, is a Tuesday.
//
// ONE RULE, DERIVED FROM THE DATA ITSELF, applied to both:
//
//   1. Scan down column B for the first cell that parses as a real date. That
//      row is the first data row.
//   2. The header row is the row immediately ABOVE it. This picks row 9 for CBH
//      and row 11 for 3Hills, and steps over 3Hills' band header — which also
//      contains the word "DATE" and would fool any text search for it.
//   3. Read columns rightward from the Date column, stopping at the first EMPTY
//      header cell. That yields B..O for CBH and B..M for 3Hills, and the blank
//      column N is what keeps the MONTHLY PERFORMANCE OVERVIEW side table out.
//   4. Read data rows downward until the first row whose column B is not a valid
//      date. That stops before Total and Average without naming them.
//   5. Assert the resulting column set against the layout and REJECT THE WHOLE
//      TAB if it does not match.
//
// Step 5 is the one that makes the other four safe. Detection that guesses well
// is worse than detection that guesses badly, because it fails quietly: shifted
// columns import as confident numbers under the wrong field names. Nothing here
// falls back to a default when it is unsure — it refuses the tab and says which
// step failed.
//
// WHY NOT getDataRange() AS-IS. It answers with the whole populated rectangle,
// A1 to the last cell holding anything. On CBH that is the title block plus the
// KPI cards plus Total and Average; on 3Hills it also drags in the side table
// eight columns to the right. Treating its first row as the header gives a title
// cell, and treating every row as data gives Totals as a day. It is the right
// call to GET the grid and the wrong thing to trust the edges of.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Column B, zero-indexed. Both tabs indent the table by one column, and column A
 * is a spacer. This is the single positional assumption in the whole rule, and
 * step 5 is what catches it if it ever stops holding: a table that moved to
 * column A yields a header set that does not match the layout, and the tab is
 * rejected with the mismatch named rather than imported from the wrong offset.
 */
export const DATE_COLUMN_INDEX = 1;

export type LocatedTable = {
  /** 0-based row index in the grid. Add 1 for the row number a person sees. */
  headerRowIndex: number;
  firstDataRowIndex: number;
  /** Inclusive. */
  lastDataRowIndex: number;
  dateColumnIndex: number;
  /** Inclusive. */
  lastColumnIndex: number;
  header: string[];
  rows: string[][];
};

export type LocateResult =
  | { ok: true; table: LocatedTable }
  | { ok: false; step: 1 | 2 | 3 | 4 | 5; reason: string };

/** 0 -> "A", 1 -> "B", 26 -> "AA". For error messages a person has to act on. */
export function columnLetter(index: number): string {
  let n = index;
  let out = "";
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

const cellText = (v: unknown): string => String(v ?? "").replace(/ /g, " ").trim();

/**
 * Locate the tracker table within a raw sheet grid.
 *
 * `grid` is the sheet as delivered — row 0 is spreadsheet row 1, column 0 is
 * column A — including every title, band, KPI card, total and side table. This
 * function decides which rectangle of it is the tracker, or refuses.
 */
export function locateTrackerTable(
  grid: readonly (readonly unknown[])[],
  layout: TrackerLayout,
  opts: { dayFirst?: boolean; dateColumnIndex?: number } = {},
): LocateResult {
  const dateCol = opts.dateColumnIndex ?? DATE_COLUMN_INDEX;
  const dayFirst = opts.dayFirst ?? true;
  const col = columnLetter(dateCol);

  const hasDate = (row: readonly unknown[] | undefined): boolean =>
    parseTrackerDate(row?.[dateCol], dayFirst) !== null;

  // ── 1 · The first row carrying a real date in column B is the first data row.
  //
  // A date is used as the signal rather than a header word because a date is
  // the one thing a title block, a KPI card and a band header never contain.
  let firstDataRowIndex = -1;
  for (let r = 0; r < grid.length; r++) {
    if (hasDate(grid[r])) {
      firstDataRowIndex = r;
      break;
    }
  }
  if (firstDataRowIndex === -1) {
    return {
      ok: false,
      step: 1,
      reason:
        `No row has a readable date in column ${col}, so the tracker table could not be ` +
        `found. Nothing was imported. This is what an empty tab, a renamed tab, or a ` +
        `tab whose dates are text rather than dates looks like — all three import ZERO ` +
        `rows, which is why this is refused rather than reported as a successful import ` +
        `of nothing.`,
    };
  }

  // ── 2 · The header is the row immediately above. Not searched for by name:
  // 3Hills' band header (row 10) also says "DATE", and a text search finds it
  // first, one row too high, shifting every column by the band's own layout.
  const headerRowIndex = firstDataRowIndex - 1;
  if (headerRowIndex < 0) {
    return {
      ok: false,
      step: 2,
      reason:
        `The first dated row is row 1, so there is no header row above it. Nothing was ` +
        `imported — without a header no column can be mapped to a field.`,
    };
  }
  const headerRow = grid[headerRowIndex] ?? [];

  // ── 3 · Rightward from the Date column to the first EMPTY header cell.
  //
  // The blank column between the tracker and 3Hills' MONTHLY PERFORMANCE
  // OVERVIEW is load-bearing: it is the boundary. Reading to the end of the row
  // instead would pull that table's columns in as tracker fields.
  let lastColumnIndex = dateCol - 1;
  for (let c = dateCol; c < headerRow.length; c++) {
    if (cellText(headerRow[c]) === "") break;
    lastColumnIndex = c;
  }
  if (lastColumnIndex < dateCol) {
    return {
      ok: false,
      step: 3,
      reason:
        `The header cell at ${col}${headerRowIndex + 1}, directly above the first dated ` +
        `row, is empty. Nothing was imported.`,
    };
  }

  const header = headerRow
    .slice(dateCol, lastColumnIndex + 1)
    .map((c) => cellText(c));

  // ── 4 · Downward to the first row without a date in column B. Total and
  // Average stop it by being what they are, not by being recognised by name.
  let lastDataRowIndex = firstDataRowIndex;
  for (let r = firstDataRowIndex; r < grid.length; r++) {
    if (!hasDate(grid[r])) break;
    lastDataRowIndex = r;
  }

  // A dated row BELOW the stop is a gap inside the data block — a blank
  // separator row, or a spacer somebody added mid-August. Step 4 would stop at
  // it and import the rows above while silently dropping every row below, which
  // reads as a successful partial import and is indistinguishable from the
  // property simply not having recorded those days. Refuse instead.
  //
  // This is NOT about missing dates. CBH has no rows at all for 21-23 and 29
  // August and that is fine — an absent row is an unrecorded day. This is about
  // a row that IS there, below a break, that would be thrown away unmentioned.
  for (let r = lastDataRowIndex + 1; r < grid.length; r++) {
    if (!hasDate(grid[r])) continue;
    return {
      ok: false,
      step: 4,
      reason:
        `The data block breaks at row ${lastDataRowIndex + 2} but another dated row ` +
        `appears at row ${r + 1}. Importing would have taken rows ` +
        `${firstDataRowIndex + 1}-${lastDataRowIndex + 1} and silently dropped ` +
        `everything below the break. Nothing was imported. Remove the blank or ` +
        `non-dated row inside the table, or split the tab.`,
    };
  }

  // ── 5 · The column set must be the one this layout describes, in order.
  const expected = layout.expectedHeader;
  const got = header.map(normaliseHeader);
  if (got.length !== expected.length) {
    return {
      ok: false,
      step: 5,
      reason:
        `Layout "${layout.id}" expects ${expected.length} columns ` +
        `(${col}..${columnLetter(dateCol + expected.length - 1)}) but the header at row ` +
        `${headerRowIndex + 1} spans ${got.length} ` +
        `(${col}..${columnLetter(lastColumnIndex)}): [${header.join(" | ")}]. ` +
        `The whole tab was rejected — a changed column set means no row's mapping can ` +
        `be trusted, and importing the columns that still line up would write shifted ` +
        `numbers under the right-looking names.`,
    };
  }
  const firstMismatch = got.findIndex((h, i) => h !== expected[i]);
  if (firstMismatch !== -1) {
    return {
      ok: false,
      step: 5,
      reason:
        `Layout "${layout.id}" expects column ` +
        `${columnLetter(dateCol + firstMismatch)} to be "${expected[firstMismatch]}" but the ` +
        `header at row ${headerRowIndex + 1} has "${header[firstMismatch]}". The whole tab ` +
        `was rejected — a column that moved shifts every column after it, and importing ` +
        `would write those numbers under the wrong field names.`,
    };
  }

  const rows = grid
    .slice(firstDataRowIndex, lastDataRowIndex + 1)
    .map((r) => {
      const out: string[] = [];
      for (let c = dateCol; c <= lastColumnIndex; c++) out.push(cellText(r[c]));
      return out;
    });

  return {
    ok: true,
    table: {
      headerRowIndex,
      firstDataRowIndex,
      lastDataRowIndex,
      dateColumnIndex: dateCol,
      lastColumnIndex,
      header,
      rows,
    },
  };
}
