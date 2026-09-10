import { TRACKER_LAYOUTS } from "@/lib/ops-tracker/layouts";

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES BUILT FROM THE REAL TRACKER LAYOUTS.
//
// Both properties live in ONE workbook on two tabs, and the tabs are shaped
// differently — different title-block heights, a band header on one of them,
// different column counts, and a second table off to the right on 3Hills. These
// reproduce both, including the parts that are wrong in the real sheets (the KPI
// cards that disagree with their own columns, the partially-filled recent rows,
// the missing August days), because those are what the import has to survive.
//
// Shared by the layout suite, which pins the location rule against them, and the
// ingest suite, which pushes them through the endpoint.
// ─────────────────────────────────────────────────────────────────────────────

export const CBH_LAYOUT = TRACKER_LAYOUTS.cbh_v1;
export const TH_LAYOUT = TRACKER_LAYOUTS.three_hills_v1;

export const blank = (n: number): string[] => Array(n).fill("");

/** A row that starts at column A (index 0) and places `cells` from column B. */
export const atColumnB = (cells: readonly (string | number)[], trailing: readonly string[] = []): string[] =>
  ["", ...cells.map(String), ...trailing];

export const CBH_HEADER = [
  "Date", "CBH Enquiry", "Repeat", "Rm Nts Confirmed", "Junk / Spam", "Sold Out",
  "Inhouse", "Low Budget", "Less Room", "WhatsApp Leads", "WhatsApp Confirmed",
  "Total Calls Received", "Total Leads", "Conversion Rate",
];

export const TH_HEADER = [
  "Date", "3Hills Enquiry", "Repeat", "Rm Nts Confirmed", "Junk / Spam", "Sold Out",
  "Inhouse", "Low Budget Less Room", "WhatsApp Leads", "WhatsApp Confirmed",
  "Total Calls Received", "Conversion Rate",
];

/**
 * CBH's dates, as the sheet really runs them: 30 rows ending 8 September, with
 * NO ROWS AT ALL for 21-23 and 29 August. An absent row is a day the property
 * did not record — not a zero, and not a gap the importer should fill.
 */
export const CBH_MISSING = new Set(["2026-08-21", "2026-08-22", "2026-08-23", "2026-08-29"]);

export function cbhDates(): string[] {
  const out: string[] = [];
  for (let d = new Date(Date.UTC(2026, 7, 6)); out.length < 30; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (!CBH_MISSING.has(iso)) out.push(iso);
  }
  return out;
}

export function thDates(): string[] {
  const out: string[] = [];
  for (let d = new Date(Date.UTC(2026, 7, 5)); out.length < 35; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * CBH as it really is. Rows 1-8 are the title block INCLUDING the KPI cards —
 * "Total Call Enquiries 248" against a CBH Enquiry column totalling 189 (the card
 * is Enquiry + Repeat, 189 + 59), and a subtitle claiming 31 Jul to 5 Sep while
 * the data runs to the 8th. Both are wrong about what they claim to be, both are
 * in the sheet, and neither may reach the import.
 */
export function cbhGrid(): string[][] {
  const grid: string[][] = [
    atColumnB(["ASTER | CALL REPORTS TRACKER"]),
    atColumnB(["Coffeeberry Hills"]),
    atColumnB(["Total Call Enquiries", "248"]),
    atColumnB(["Total Room Nights", "66"]),
    atColumnB(["Conversion Rate", "14.5%"]),
    atColumnB(["31 Jul to 5 Sep"]),
    blank(3),
    atColumnB(["Daily log"]),
    atColumnB(CBH_HEADER),                                    // row 9
  ];

  for (const date of cbhDates()) {                            // rows 10-39
    // 6-8 September are PARTIALLY FILLED in the real sheet: counts present,
    // Total Leads and Conversion Rate not yet written in.
    const partial = date >= "2026-09-06";
    grid.push(
      atColumnB([
        date, "8", "2", "5", "1", "0", "1", "2", "1", "4", "2", "9",
        partial ? "" : "12",
        partial ? "" : "58.3%",
      ]),
    );
  }

  // THE TOTAL ROW IS OBSERVED, read straight off the sheet — not derived, and not
  // back-calculated from the card's percentage.
  //
  // That distinction cost a bug already. Total Leads is 643. Working backwards
  // from the card's 14.5% gives 641, because 93/643 = 14.46% and 93/641 = 14.51%
  // both display as 14.5% — the rounding cannot tell them apart. A fixture built
  // on 641 passes every test here and disagrees with the sheet on the first real
  // reconciliation. Where a value can be read, read it.
  //
  // The row also confirms the column mapping independently: the "Total Call
  // Enquiries 248" card is CBH Enquiry 189 + Repeat 59. That only adds up if
  // Repeat really is the third column, which is why the card is worth keeping in
  // the fixture — as evidence, not as a number to import.
  //
  // The daily rows above are uniform filler and deliberately do NOT sum to this
  // row. Nothing reads it: its only job here is to be the non-dated row that
  // stops the data scan.
  grid.push(atColumnB(
    ["Total", "189", "59", "66", "50", "79", "71", "48", "41", "405", "27", "515", "643", "14.5%"],
  ));
  // Derived from the totals over 30 data rows, for internal consistency only.
  grid.push(atColumnB(
    ["Average", "6.3", "2.0", "2.2", "1.7", "2.6", "2.4", "1.6", "1.4", "13.5", "0.9", "17.2", "21.4", ""],
  ));
  return grid;
}

/**
 * 3Hills as it really is: an extra title row, a BAND header above the real one,
 * and a second table starting at column O with the blank column N between.
 *
 * The band header is the trap. It contains the word "DATE", so any search for a
 * header row by text finds it FIRST — one row too high — and every column then
 * reads one position off its true meaning.
 */
export function thGrid(): string[][] {
  const side = (cells: readonly string[]): string[] => ["", ...cells]; // blank N, then O..T

  const grid: string[][] = [
    atColumnB(["ASTER | CALL REPORTS TRACKER"]),
    atColumnB(["Three Hills"]),
    atColumnB(["Total Calls Received", "241"]),
    atColumnB(["Total Room Nights", "112"]),
    atColumnB(["Conversion Rate", "46.5%"]),
    atColumnB(["Aug - Sep 2026"]),
    blank(3),
    blank(3),
    atColumnB(["Daily log"]),
    // row 10 — BAND header. Says "DATE". Is not the header.
    atColumnB(["DATE", "ENQUIRY BREAKDOWN", "", "", "", "", "", "", "WHATSAPP", "", "TOTALS", ""]),
    // row 11 — the real header, plus the side table's own header in O..T
    atColumnB(TH_HEADER, side(["MONTHLY PERFORMANCE OVERVIEW", "", "", "", "", ""])),
  ];

  const dates = thDates();
  dates.forEach((date, i) => {                                // rows 12-46
    const row = atColumnB([date, "6", "1", "3", "2", "0", "1", "3", "2", "1", "9", "33.3%"]);
    // The side table occupies the same rows, eight columns to the right.
    if (i < 2) {
      row.push(...side(["August", "241", "112", "46.5%", "", ""]));
    }
    grid.push(row);
  });

  // Real here: Rm Nts Confirmed 112 and Total Calls Received 241, which are what
  // make 112 / 241 the 46.5% on this tab's card — a different formula from CBH's,
  // and not a conversion rate either.
  grid.push(atColumnB(["Total", "150", "38", "112", "31", "7", "19", "62", "44", "21", "241", ""]));
  grid.push(atColumnB(["Average", "4.3", "1.1", "3.2", "0.9", "0.2", "0.5", "1.8", "1.3", "0.6", "6.9", ""]));
  return grid;
}
