import {
  COUNT_FIELDS,
  mapHeader,
  type TrackerField,
  type TrackerLayout,
} from "@/lib/ops-tracker/layouts";

// ─────────────────────────────────────────────────────────────────────────────
// Parsing an operations-tracker payload.
//
// These are hand-maintained spreadsheets. Every value arriving here has been
// typed by a person, so the parser's job is to be strict at the boundary and
// specific about what it rejected — a silently coerced cell becomes a number on
// a client's report with nothing recording that it was a guess.
//
// EMPTY IS NOT ZERO. A blank cell means the property did not record that figure
// for that day. It is stored as null and rendered as unavailable. Coercing it to
// 0 would turn "we did not write it down" into "it did not happen", which is the
// single most misleading thing this importer could do.
// ─────────────────────────────────────────────────────────────────────────────

export type ParsedRow = {
  /** YYYY-MM-DD, the property's own calendar date as recorded in the sheet. */
  date: string;
  values: Partial<Record<Exclude<TrackerField, "date">, number | null>>;
  /** The raw row exactly as received, for tracing a disputed figure. */
  sourceRow: Record<string, string>;
};

export type RejectedRow = {
  /** 1-based row number within the data rows, as a person would count in Sheets. */
  rowNumber: number;
  reason: string;
  /** The date cell as received, when there was one — helps locate the row. */
  rawDate?: string;
};

export type ParseResult =
  | { ok: true; rows: ParsedRow[]; rejected: RejectedRow[] }
  | { ok: false; reason: string; unknownColumns: string[]; missingFields: string[] };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY_DATE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Parse a tracker date cell to YYYY-MM-DD.
 *
 * ISO is the contract. The bundled Apps Script formats the DATE VALUE of the
 * cell to yyyy-MM-dd before sending, rather than shipping getDisplayValues() as
 * the brief's reference script did — a display string is locale-dependent, and
 * "05/09/2026" is 5 September or 9 May depending on a spreadsheet setting nobody
 * remembers changing. Formatting at the source removes the ambiguity entirely
 * instead of guessing at this end.
 *
 * D/M/Y is accepted as a fallback for the published-CSV reconciliation path,
 * which only ever sees display strings. `dayFirst` defaults true because the
 * workbook is Indian; where the value is genuinely ambiguous (both parts <= 12)
 * that assumption decides it, and it is recorded under Open Decisions. A value in
 * neither shape is rejected rather than interpreted.
 */
export function parseTrackerDate(raw: unknown, dayFirst = true): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const iso = ISO_DATE.exec(text);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return isRealDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
  }

  const dmy = DMY_DATE.exec(text);
  if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    const y = Number(dmy[3]);
    // When one part exceeds 12 the order is proven, whatever the flag says.
    const [d, m] = a > 12 ? [a, b] : b > 12 ? [b, a] : dayFirst ? [a, b] : [b, a];
    return isRealDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
  }

  return null;
}

/** Blank → null (not recorded). A number → the number. Anything else → invalid. */
function parseCount(raw: unknown): { ok: true; value: number | null } | { ok: false; reason: string } {
  const text = String(raw ?? "").trim();
  if (text === "" || text === "-" || text === "—") return { ok: true, value: null };

  const cleaned = text.replace(/,/g, "").replace(/\s/g, "");
  if (!/^-?\d+(\.0+)?$/.test(cleaned)) {
    return { ok: false, reason: `"${text}" is not a whole number` };
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { ok: false, reason: `"${text}" is not a finite number` };
  if (n < 0) return { ok: false, reason: `"${text}" is negative; counts cannot be below zero` };
  return { ok: true, value: Math.round(n) };
}

/**
 * The stored Conversion Rate cell. Audited, never rendered — the two tabs
 * compute it by different formulas and neither is a conversion rate (see
 * lib/ops-tracker/metrics.ts). Normalised to a fraction so the two are at least
 * comparable when auditing.
 */
function parseRate(raw: unknown): { ok: true; value: number | null } | { ok: false; reason: string } {
  const text = String(raw ?? "").trim();
  if (text === "" || text === "-" || text === "—") return { ok: true, value: null };

  const isPercent = text.includes("%");
  const cleaned = text.replace(/%/g, "").replace(/,/g, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { ok: false, reason: `conversion rate "${text}" is not a number` };
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { ok: false, reason: `conversion rate "${text}" is not finite` };
  // A bare "0.75" is already a fraction; "75%" and "75" are percentages.
  const fraction = isPercent || n > 1 ? n / 100 : n;
  return { ok: true, value: Math.round(fraction * 10_000) / 10_000 };
}

const COUNT_SET = new Set<string>(COUNT_FIELDS);

/**
 * Parse a whole payload against a layout.
 *
 * A header problem fails the BATCH (the sheet's shape changed, so nothing can be
 * trusted). A row problem fails only that ROW, with a reason, and the rest of the
 * batch continues — one mistyped cell must never cost five weeks of history.
 */
export function parseTrackerPayload(
  header: readonly string[],
  rows: readonly (readonly unknown[])[],
  layout: TrackerLayout,
  opts: { dayFirst?: boolean } = {},
): ParseResult {
  const mapping = mapHeader(header, layout);
  if (!mapping.ok) {
    return {
      ok: false,
      reason: mapping.reason,
      unknownColumns: mapping.unknownColumns,
      missingFields: mapping.missingFields,
    };
  }

  const accepted: ParsedRow[] = [];
  const rejected: RejectedRow[] = [];
  const seenDates = new Map<string, number>();

  rows.forEach((row, i) => {
    const rowNumber = i + 1;
    const sourceRow: Record<string, string> = {};
    header.forEach((h, idx) => {
      const key = String(h ?? "").trim();
      if (key) sourceRow[key] = String(row[idx] ?? "");
    });

    // Entirely blank rows are spreadsheet padding, not data. Skipped silently:
    // reporting them as rejections would bury the real problems in noise.
    if (row.every((c) => String(c ?? "").trim() === "")) return;

    const dateIdx = mapping.fieldByIndex.indexOf("date");
    const rawDate = dateIdx >= 0 ? String(row[dateIdx] ?? "").trim() : "";
    const date = parseTrackerDate(rawDate, opts.dayFirst ?? true);
    if (!date) {
      rejected.push({
        rowNumber,
        rawDate,
        reason: rawDate
          ? `date "${rawDate}" is not a recognised date (expected YYYY-MM-DD)`
          : "row has no date",
      });
      return;
    }

    // A duplicated date inside one payload is a sheet error, not an import
    // error. Rejecting the later one keeps the import deterministic instead of
    // letting row order decide which figure survives.
    const priorRow = seenDates.get(date);
    if (priorRow != null) {
      rejected.push({
        rowNumber,
        rawDate,
        reason: `date ${date} already appears in this payload at row ${priorRow}`,
      });
      return;
    }

    const values: ParsedRow["values"] = {};
    let rowError: string | null = null;

    mapping.fieldByIndex.forEach((field, idx) => {
      if (!field || field === "date" || rowError) return;
      const raw = row[idx];
      const parsed = COUNT_SET.has(field) ? parseCount(raw) : parseRate(raw);
      if (!parsed.ok) {
        rowError = `${field}: ${parsed.reason}`;
        return;
      }
      values[field as Exclude<TrackerField, "date">] = parsed.value;
    });

    if (rowError) {
      rejected.push({ rowNumber, rawDate, reason: rowError });
      return;
    }

    seenDates.set(date, rowNumber);
    accepted.push({ date, values, sourceRow });
  });

  return { ok: true, rows: accepted, rejected };
}
