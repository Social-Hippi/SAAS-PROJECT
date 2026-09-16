import * as XLSX from "xlsx";

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
function parseDate(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]),
  );
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
    const d = parseDate(row.updated_at);
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
): ImportResult {
  const wb = XLSX.read(file, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = sheet
    ? (XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false }) as Record<string, unknown>[])
    : [];

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

    const ctwaClid = str(row[HEADERS.ctwaClid]);
    const sourceId = str(row[HEADERS.sourceId]);
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
      createdAt: parseDate(row[HEADERS.createdAt]),
      stageUpdatedAt: parseDate(row[HEADERS.stageUpdatedAt]),
      confirmedAt: confirmedAtFromHistory(row[HEADERS.history], confirmedStageName),
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
