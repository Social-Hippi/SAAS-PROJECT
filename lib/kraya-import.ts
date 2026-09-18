import * as XLSX from "xlsx";

import { utcFromWallClock } from "@/lib/timezone";
import type { KrayaLead } from "@/lib/kraya-webhook";

// ─────────────────────────────────────────────────────────────────────────────
// Reading Kraya's own lead export.
//
// TWO JOBS, and the second is the one that justifies the file existing.
//
//   1. BACKFILL. Kraya's API is POST-only — both documented endpoints push data
//      INTO Kraya, and there is no way to read leads back out. So the webhook
//      starts from empty and every lead that existed before it was switched on
//      is unreachable by any other means.
//
//   2. RECONCILIATION. Kraya retries a failed delivery twice and then drops it
//      permanently. With no read endpoint there is no catch-up query, so a
//      deploy at the wrong moment loses leads silently. Re-importing the export
//      is the only way to notice and repair that — the same role the published-
//      CSV reader plays for the operations tracker.
//
// COLUMNS ARE MATCHED BY HEADER NAME, never by position. The export's column
// order reflects whichever custom attributes the hotel has configured, and it
// changes the moment they add one.
//
// THE EXPORT CARRIES TIMESTAMPS THE WEBHOOK DOES NOT. `Stage pipeline history`
// is a JSON audit trail of every stage transition, so an imported booking can be
// dated to when it was actually confirmed rather than when we heard about it.
// That makes this the more accurate source for anything historical.
// ─────────────────────────────────────────────────────────────────────────────

/** A lead read from the export, plus the dates only the export carries. */
export type ImportedLead = KrayaLead & {
  createdAt: Date | null;
  stageUpdatedAt: Date | null;
  /** When the lead first entered `confirmedStageName`, from the history. */
  confirmedAt: Date | null;
};

export type ImportResult = {
  rows: number;
  leads: ImportedLead[];
  /** Rows skipped, with why — surfaced rather than silently dropped. */
  skipped: { row: number; reason: string }[];
};

/**
 * Cell references whose EXACT digits matter, read from the sheet XML rather than
 * from the parsed cell.
 *
 * A Meta ad id is an 18-digit number, and Kraya's export writes it as a NUMERIC
 * cell. Both of the obvious ways to read that lose it:
 *
 *   formatted text  ->  "1.20242E+17"        Excel renders General format as
 *                                            scientific past 11 digits
 *   parsed value    ->  120241573189260240   the true id ends 234; 1.2e17 is far
 *                                            past Number.MAX_SAFE_INTEGER, so the
 *                                            last digits are rounded away
 *
 * Neither is recoverable, and neither errors — the id simply becomes a different
 * id, quietly, and joins to no campaign. The raw XML holds the digits exactly, so
 * for these columns that is what is read.
 *
 * Ids arriving from the WEBHOOK are unaffected: JSON carries them as strings.
 * This is purely an artefact of the spreadsheet round-trip.
 */
function exactNumericCells(rawSheetXml: string): Map<string, string> {
  const out = new Map<string, string>();
  // Numeric cells only: a shared-string cell carries t="s" and its <v> is an
  // index into the string table, not the value.
  const re = /<c r="([A-Z]+\d+)"(?![^>]*\bt=")[^>]*><v>([^<]+)<\/v>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawSheetXml)) !== null) {
    if (/^\d+$/.test(m[2])) out.set(m[1], m[2]);
  }
  return out;
}

/** Columns read from the XML for exact digits rather than from the parsed cell. */
const EXACT_COLUMNS = new Set(["wa_ref_source_id", "wa_ref_ctwa_clid"]);

const HEADERS = {
  phone: "Phone number",
  email: "Email",
  stage: "Stage name",
  pipeline: "Pipeline name",
  createdAt: "Created at",
  stageUpdatedAt: "Stage updated at",
  history: "Stage pipeline history",
  ctwaClid: "wa_ref_ctwa_clid",
  sourceId: "wa_ref_source_id",
  sourceType: "wa_ref_source_type",
  sourceUrl: "wa_ref_source_url",
  headline: "wa_ref_headline",
} as const;

/**
 * An ad id that survived the spreadsheet intact, or null.
 *
 * "1.20242E+17" is what an 18-digit id looks like after Excel's General format
 * has been applied, and the digits behind it are gone. Storing it would attach
 * the conversation to an ad that does not exist — a WRONG attribution, which is
 * worse than none, because nothing downstream could tell it was wrong.
 */
function exactId(v: unknown): string | null {
  const t = v == null ? "" : String(v).trim();
  if (t.length === 0) return null;
  // Scientific notation, or anything else that is not the id itself.
  if (!/^[A-Za-z0-9_-]+$/.test(t)) return null;
  if (/^\d+(\.\d+)?[Ee][+-]?\d+$/.test(t)) return null;
  return t;
}

const str = (v: unknown): string | null => {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length > 0 ? t : null;
};

/**
 * "2026-08-17 12:52:01" — Kraya writes a local wall-clock time with no zone.
 *
 * Read as UTC deliberately. Guessing a zone would shift every timestamp by hours
 * in one direction or the other, and a booking dated to the wrong day is worse
 * than one dated consistently. The property's own timezone is applied later, at
 * the reporting boundary, exactly as platform data is.
 */
/**
 * The timezone Kraya writes export times in when a caller does not say.
 *
 * Kraya writes "2026-09-17 07:22:18" — local wall-clock time with NO offset.
 * For these Indian properties that local time is IST. Reading it as UTC, as
 * this parser once did, stored every imported time 5 h 30 min LATE: a stage the
 * webhook recorded at 01:52:18 UTC came back from the export as 07:22:18 UTC,
 * and 257 leads that first messaged between 6:30 pm and midnight were dated to
 * the following day. Callers pass the property's own timezone; this is only the
 * fallback.
 */
export const KRAYA_EXPORT_DEFAULT_TIMEZONE = "Asia/Kolkata";

function parseDate(v: unknown, tz: string): Date | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  // Wall-clock time in `tz`, converted to the instant it names — DST-safe.
  const d = utcFromWallClock(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], 0, tz);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * When the lead FIRST reached the confirmed stage, from its own history.
 *
 * First rather than last: a lead moved out of "Booking Confirmed" and back again
 * was booked on the earlier date. Returns null when the history is absent or
 * unparseable — the caller then falls back to the stage-updated time rather than
 * discarding the booking.
 */
export function confirmedAtFromHistory(
  historyJson: unknown,
  confirmedStageName: string | null,
  tz: string = KRAYA_EXPORT_DEFAULT_TIMEZONE,
): Date | null {
  const raw = str(historyJson);
  if (!raw || !confirmedStageName) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const entries = (parsed as { stage_history?: unknown })?.stage_history;
  if (!Array.isArray(entries)) return null;

  const wanted = confirmedStageName.trim().toLowerCase();
  const dates: Date[] = [];
  for (const e of entries) {
    if (e == null || typeof e !== "object") continue;
    const row = e as Record<string, unknown>;
    if (str(row.updated)?.trim().toLowerCase() !== wanted) continue;
    const d = parseDate(row.updated_at, tz);
    if (d) dates.push(d);
  }
  if (dates.length === 0) return null;
  return dates.reduce((min, d) => (d < min ? d : min));
}

/**
 * Parse a Kraya lead export.
 *
 * `confirmedStageName` is needed only to date confirmations from the history;
 * every lead is returned regardless of stage.
 */
export function parseKrayaExport(
  file: ArrayBuffer | Buffer,
  confirmedStageName: string | null,
  /** The property's timezone — the one Kraya's wall-clock times are written in. */
  timezone: string = KRAYA_EXPORT_DEFAULT_TIMEZONE,
): ImportResult {
  // bookFiles keeps the original part contents, which is the only place an
  // 18-digit ad id survives intact — see exactNumericCells above.
  const wb = XLSX.read(file, { type: "buffer", bookFiles: true }) as unknown as {
    Sheets: Record<string, XLSX.WorkSheet>;
    SheetNames: string[];
    files?: Record<string, { content?: unknown }>;
  };
  const sheet = wb.Sheets[wb.SheetNames[0]];

  let exact = new Map<string, string>();
  try {
    const key = Object.keys(wb.files ?? {}).find((k) => /worksheets\/sheet1\.xml$/.test(k));
    const content = key ? wb.files![key]?.content : undefined;
    const xml =
      typeof content === "string"
        ? content
        : Buffer.isBuffer(content)
          ? content.toString("utf8")
          : null;
    if (xml) exact = exactNumericCells(xml);
  } catch {
    // Fall back to the parsed values. An id may then be scientific notation,
    // which the ingest rejects rather than storing as a different ad.
  }

  const rows = sheet
    ? (XLSX.utils.sheet_to_json(sheet, {
        defval: null,
        raw: false,
        // Cell refs are needed to look an exact value back up, and sheet_to_json
        // does not report them — so the row NUMBER is tracked instead. Data
        // begins on row 2, under the header.
      }) as Record<string, unknown>[])
    : [];

  // header name -> column letter, so an exact lookup knows which cell to read.
  const columnOf = new Map<string, string>();
  if (sheet && sheet["!ref"]) {
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const letter = XLSX.utils.encode_col(c);
      const header = sheet[`${letter}1`] as { v?: unknown } | undefined;
      const name = header?.v == null ? null : String(header.v).trim();
      if (name) columnOf.set(name, letter);
    }
  }

  /** The exact digits for an EXACT_COLUMNS cell, else the parsed value. */
  const readExact = (header: string, rowNumber: number, parsed: unknown): unknown => {
    if (!EXACT_COLUMNS.has(header)) return parsed;
    const letter = columnOf.get(header);
    if (!letter) return parsed;
    return exact.get(`${letter}${rowNumber}`) ?? parsed;
  };

  const leads: ImportedLead[] = [];
  const skipped: ImportResult["skipped"] = [];

  rows.forEach((row, i) => {
    const phone = str(row[HEADERS.phone]);
    if (!phone) {
      // Kraya's own model keys on phone, so a row without one cannot be
      // identified, deduplicated, or matched to a booking.
      skipped.push({ row: i + 2, reason: "no phone number" });
      return;
    }

    // Row 2 is the first data row, under the header.
    const rowNumber = i + 2;
    const ctwaClid = exactId(readExact(HEADERS.ctwaClid, rowNumber, row[HEADERS.ctwaClid]));
    const sourceId = exactId(readExact(HEADERS.sourceId, rowNumber, row[HEADERS.sourceId]));
    const stage = str(row[HEADERS.stage]);

    leads.push({
      // The export carries no lead id. Kraya deduplicates by phone and so do we,
      // so the phone IS the identity here — the webhook supplies the real id
      // later and the same conversation row picks it up.
      leadId: `export:${phone}`,
      phone,
      email: str(row[HEADERS.email]),
      stage,
      pipeline: str(row[HEADERS.pipeline]),
      eventType: null,
      referral:
        ctwaClid ?? sourceId
          ? {
              ctwaClid,
              sourceId,
              sourceType: str(row[HEADERS.sourceType]),
              sourceUrl: str(row[HEADERS.sourceUrl]),
              headline: str(row[HEADERS.headline]),
            }
          : null,
      createdAt: parseDate(row[HEADERS.createdAt], timezone),
      stageUpdatedAt: parseDate(row[HEADERS.stageUpdatedAt], timezone),
      confirmedAt: confirmedAtFromHistory(row[HEADERS.history], confirmedStageName, timezone),
    });
  });

  return { rows: rows.length, leads, skipped };
}

/** Distinct stage names in an export, most frequent first. */
export function stageNamesIn(result: ImportResult): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const l of result.leads) {
    if (!l.stage) continue;
    counts.set(l.stage, (counts.get(l.stage) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}
