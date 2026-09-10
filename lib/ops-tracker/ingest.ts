import "server-only";

import { timingSafeEqual } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { sanitizeForSpreadsheet } from "@/lib/xlsx";
import { TRACKER_LAYOUTS, isTrackerLayoutId } from "@/lib/ops-tracker/layouts";
import { locateTrackerTable } from "@/lib/ops-tracker/locate";
import { parseTrackerPayload, type RejectedRow } from "@/lib/ops-tracker/parse";

// ─────────────────────────────────────────────────────────────────────────────
// OPERATIONS TRACKER INGEST — push, not poll.
//
// The client-facing report must not depend on a Google document being reachable
// at render time, and an edit must land in seconds rather than on a daily batch.
// So a bound Apps Script POSTs the rows here on an installable onChange trigger,
// the sheet stays private (no publish-to-web, no service account, no OAuth), and
// the report reads only ManualLeadDaily.
//
// IDEMPOTENCY IS THE REAL PROTECTION, not debouncing. onChange fires on every
// keystroke commit, so the same payload arrives repeatedly by design. Every write
// is an upsert on the source's own natural key (sheet, tab, date), so replaying
// an identical payload changes nothing — which is what makes it safe to skip a
// lock and accept the duplicate traffic.
//
// ROUTING. (spreadsheetId, tabName) identifies a PropertySegment, which carries
// the hotel, the agency and the column layout. An unmapped tab is a
// configuration gap, not an error: nothing is written, the response says so, and
// the report states that a tab is unmapped rather than quietly dropping it.
// ─────────────────────────────────────────────────────────────────────────────

/** Above this the payload is refused outright rather than partially processed. */
export const MAX_ROWS_PER_PAYLOAD = 2000;

export type IngestOutcome = {
  status: number;
  body: {
    ok: boolean;
    tab?: string;
    segment?: string | null;
    rowsReceived?: number;
    rowsAccepted?: number;
    rowsRejected?: number;
    rejected?: RejectedRow[];
    error?: string;
    unknownColumns?: string[];
    missingFields?: string[];
  };
};

/**
 * Constant-time secret comparison.
 *
 * Length is compared first and separately — timingSafeEqual throws on unequal
 * lengths, and the length of a secret is not the part worth protecting.
 */
export function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type TrackerPayload = {
  spreadsheetId?: unknown;
  tab?: unknown;
  /**
   * The whole sheet grid, row 0 = spreadsheet row 1, column 0 = column A,
   * titles and totals and side tables included. PREFERRED: the server locates
   * the table inside it (lib/ops-tracker/locate.ts), so the rule that decides
   * where the table starts exists once, on this side, and is testable.
   */
  grid?: unknown;
  /** Pre-located header + rows. Accepted, but the sender is then the authority
   *  on where the table began, and a sender that gets that wrong cannot be
   *  caught here. Used by nothing we ship. */
  header?: unknown;
  rows?: unknown;
  sentAt?: unknown;
};

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((c) => String(c ?? ""));
}

/**
 * Validate, parse and upsert one workbook tab.
 *
 * Never throws for bad input — every failure is a described status. A row
 * problem rejects that row and the batch continues; a sheet-shape problem
 * rejects the batch, because a changed header means no row's mapping is
 * trustworthy.
 */
export async function ingestTrackerPayload(payload: TrackerPayload): Promise<IngestOutcome> {
  const spreadsheetId = typeof payload.spreadsheetId === "string" ? payload.spreadsheetId.trim() : "";
  const tab = typeof payload.tab === "string" ? payload.tab.trim() : "";
  const grid = Array.isArray(payload.grid) ? (payload.grid as unknown[][]) : null;
  const header = asStringArray(payload.header);
  const rawRows = Array.isArray(payload.rows) ? payload.rows : null;

  if (!spreadsheetId || !tab) {
    return { status: 400, body: { ok: false, error: "spreadsheetId and tab are required." } };
  }
  if (!grid && (!header || header.length === 0)) {
    return {
      status: 400,
      body: { ok: false, error: "either a grid, or a header row with rows, is required." },
    };
  }
  if (!grid && !rawRows) {
    return { status: 400, body: { ok: false, error: "rows must be an array." } };
  }

  const incomingRowCount = grid ? grid.length : rawRows!.length;
  if (incomingRowCount > MAX_ROWS_PER_PAYLOAD) {
    return {
      status: 413,
      body: {
        ok: false,
        error: `payload has ${incomingRowCount} rows; the cap is ${MAX_ROWS_PER_PAYLOAD}.`,
      },
    };
  }

  const segment = await prisma.propertySegment.findFirst({
    where: { sourceSheetId: spreadsheetId, sourceTabName: tab },
    select: {
      id: true,
      name: true,
      agencyId: true,
      hotelClientId: true,
      trackerLayout: true,
      isActive: true,
    },
  });

  if (!segment) {
    // Not an error the sender can fix, and not something to fail loudly over —
    // but nothing is written, and the caller is told exactly why.
    return {
      status: 404,
      body: {
        ok: false,
        tab,
        segment: null,
        error:
          `No property segment is configured for spreadsheet "${spreadsheetId}" tab "${tab}". ` +
          `Nothing was imported. Map the tab to a property in the admin surface.`,
      },
    };
  }

  const layoutId = segment.trackerLayout;
  if (!isTrackerLayoutId(layoutId)) {
    return {
      status: 409,
      body: {
        ok: false,
        tab,
        segment: segment.name,
        error:
          `Property segment "${segment.name}" has no valid tracker layout configured ` +
          `(found ${JSON.stringify(segment.trackerLayout)}). Nothing was imported.`,
      },
    };
  }

  const layout = TRACKER_LAYOUTS[layoutId];

  // Where does the table start? Only the layout knows what a correct answer
  // looks like, which is why this happens AFTER the segment lookup rather than
  // at the payload boundary: locating and validating are the same act, and a
  // located table that does not match its layout is a rejected tab.
  let tableHeader: string[];
  let tableRows: unknown[][];

  if (grid) {
    const located = locateTrackerTable(grid, layout);
    if (!located.ok) {
      return {
        status: 422,
        body: {
          ok: false,
          tab,
          segment: segment.name,
          error: `Could not read tab "${tab}" (step ${located.step}). ${located.reason}`,
          rowsReceived: grid.length,
          rowsAccepted: 0,
          rowsRejected: 0,
        },
      };
    }
    tableHeader = located.table.header;
    tableRows = located.table.rows;
  } else {
    tableHeader = header!;
    tableRows = rawRows as unknown[][];
  }

  const parsed = parseTrackerPayload(tableHeader, tableRows, layout);

  if (!parsed.ok) {
    return {
      status: 422,
      body: {
        ok: false,
        tab,
        segment: segment.name,
        error: parsed.reason,
        unknownColumns: parsed.unknownColumns,
        missingFields: parsed.missingFields,
        rowsReceived: tableRows.length,
        rowsAccepted: 0,
        rowsRejected: tableRows.length,
      },
    };
  }

  for (const row of parsed.rows) {
    // Every raw cell is neutralised before storage. sourceRow is echoed back into
    // CSV and XLSX exports, and a cell beginning = + - @ is executed as a formula
    // by Excel and Sheets on open — the sheet is the untrusted input here.
    const sourceRow = sanitizeForSpreadsheet(row.sourceRow) as Record<string, string>;
    const v = row.values;

    const data = {
      agencyId: segment.agencyId,
      hotelClientId: segment.hotelClientId,
      propertySegmentId: segment.id,
      enquiries: v.enquiries ?? null,
      repeatContacts: v.repeatContacts ?? null,
      roomNightsConfirmed: v.roomNightsConfirmed ?? null,
      junkSpam: v.junkSpam ?? null,
      soldOut: v.soldOut ?? null,
      inhouse: v.inhouse ?? null,
      lowBudget: v.lowBudget ?? null,
      lessRoom: v.lessRoom ?? null,
      lowBudgetLessRoom: v.lowBudgetLessRoom ?? null,
      whatsappLeads: v.whatsappLeads ?? null,
      whatsappConfirmed: v.whatsappConfirmed ?? null,
      totalCallsReceived: v.totalCallsReceived ?? null,
      storedTotalLeads: v.storedTotalLeads ?? null,
      storedConversionRate: v.storedConversionRate ?? null,
      sourceRow,
      importedAt: new Date(),
    };

    await prisma.manualLeadDaily.upsert({
      where: {
        sourceSheetId_sourceTabName_date: {
          sourceSheetId: spreadsheetId,
          sourceTabName: tab,
          // A bare calendar date: @db.Date, so UTC midnight is the storage
          // convention and carries no timezone claim of its own.
          date: new Date(`${row.date}T00:00:00.000Z`),
        },
      },
      create: {
        ...data,
        sourceSheetId: spreadsheetId,
        sourceTabName: tab,
        date: new Date(`${row.date}T00:00:00.000Z`),
      },
      update: data,
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      tab,
      segment: segment.name,
      rowsReceived: tableRows.length,
      rowsAccepted: parsed.rows.length,
      rowsRejected: parsed.rejected.length,
      rejected: parsed.rejected,
    },
  };
}
