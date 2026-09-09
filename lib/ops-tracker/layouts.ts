// ─────────────────────────────────────────────────────────────────────────────
// OPERATIONS TRACKER COLUMN LAYOUTS.
//
// There are TWO workbooks, one per property, and they do not share a schema.
// Pretending otherwise is how a column silently lands in the wrong field:
//
//   • the enquiry column is named for the property — "CBH Enquiry" vs
//     "3Hills Enquiry";
//   • Coffeeberry Hills splits Low Budget and Less Room into two columns, while
//     Three Hills combines them into one "Low Budget Less Room". The combined
//     value is stored as its OWN field. Splitting it in half, or copying it into
//     both, would be inventing two numbers from one;
//   • Three Hills has no "Total Leads" column at all. Anything computed from it
//     is unavailable for that property — not substituted with Total Calls
//     Received, which is a different quantity.
//
// UNKNOWN COLUMNS REJECT THE WHOLE PAYLOAD, not the row. A header we do not
// recognise means the sheet's shape changed, so no row's mapping can be trusted
// — accepting the rows we happen to recognise would write mismapped numbers and
// report success. A per-row failure is a per-row rejection; a per-SHEET failure
// is a batch rejection.
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical fields on ManualLeadDaily that a sheet column can target. */
export type TrackerField =
  | "date"
  | "enquiries"
  | "repeatContacts"
  | "roomNightsConfirmed"
  | "junkSpam"
  | "soldOut"
  | "inhouse"
  | "lowBudget"
  | "lessRoom"
  | "lowBudgetLessRoom"
  | "whatsappLeads"
  | "whatsappConfirmed"
  | "totalCallsReceived"
  | "storedTotalLeads"
  | "storedConversionRate";

/** Fields that are counts of things and must be non-negative integers. */
export const COUNT_FIELDS = [
  "enquiries",
  "repeatContacts",
  "roomNightsConfirmed",
  "junkSpam",
  "soldOut",
  "inhouse",
  "lowBudget",
  "lessRoom",
  "lowBudgetLessRoom",
  "whatsappLeads",
  "whatsappConfirmed",
  "totalCallsReceived",
  "storedTotalLeads",
] as const satisfies readonly TrackerField[];

export type TrackerLayoutId = "cbh_v1" | "three_hills_v1";

export type TrackerLayout = {
  id: TrackerLayoutId;
  label: string;
  /** normalised header text -> canonical field. */
  columns: Record<string, TrackerField>;
  /** Headers that must be present for the layout to be considered a match. */
  required: readonly TrackerField[];
};

/**
 * Normalise a header cell so trivial punctuation and spacing differences do not
 * read as an unknown column: "Junk / Spam", "Junk/Spam" and "junk  /  spam" are
 * the same column. Deliberately conservative — it collapses whitespace and
 * strips spaces around a slash, and nothing else. It does NOT strip the property
 * name out of "CBH Enquiry", because that difference is real and is exactly what
 * the layout exists to record.
 */
export function normaliseHeader(raw: string): string {
  return String(raw ?? "")
    .replace(/ /g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ");
}

const CBH_COLUMNS: Record<string, TrackerField> = {
  "date": "date",
  "cbh enquiry": "enquiries",
  "repeat": "repeatContacts",
  "rm nts confirmed": "roomNightsConfirmed",
  "junk/spam": "junkSpam",
  "sold out": "soldOut",
  "inhouse": "inhouse",
  "low budget": "lowBudget",
  "less room": "lessRoom",
  "whatsapp leads": "whatsappLeads",
  "whatsapp confirmed": "whatsappConfirmed",
  "total calls received": "totalCallsReceived",
  "total leads": "storedTotalLeads",
  "conversion rate": "storedConversionRate",
};

const THREE_HILLS_COLUMNS: Record<string, TrackerField> = {
  "date": "date",
  "3hills enquiry": "enquiries",
  "repeat": "repeatContacts",
  "rm nts confirmed": "roomNightsConfirmed",
  "junk/spam": "junkSpam",
  "sold out": "soldOut",
  "inhouse": "inhouse",
  // Combined at source. Stored whole; never split into lowBudget + lessRoom.
  "low budget less room": "lowBudgetLessRoom",
  "whatsapp leads": "whatsappLeads",
  "whatsapp confirmed": "whatsappConfirmed",
  "total calls received": "totalCallsReceived",
  // NOTE: no "total leads" column exists for this property.
  "conversion rate": "storedConversionRate",
};

export const TRACKER_LAYOUTS: Record<TrackerLayoutId, TrackerLayout> = {
  cbh_v1: {
    id: "cbh_v1",
    label: "Coffeeberry Hills — Call Reports Tracker",
    columns: CBH_COLUMNS,
    required: ["date", "enquiries", "totalCallsReceived"],
  },
  three_hills_v1: {
    id: "three_hills_v1",
    label: "Three Hills — tracker",
    columns: THREE_HILLS_COLUMNS,
    required: ["date", "enquiries", "totalCallsReceived"],
  },
};

export function isTrackerLayoutId(v: unknown): v is TrackerLayoutId {
  return typeof v === "string" && v in TRACKER_LAYOUTS;
}

export type HeaderMapping =
  | { ok: true; layout: TrackerLayout; fieldByIndex: (TrackerField | null)[] }
  | { ok: false; reason: string; unknownColumns: string[]; missingFields: string[] };

/**
 * Map a header row onto a layout's fields.
 *
 * Fails when the sheet carries a column the layout does not know, or is missing
 * one the layout requires. Both are sheet-shape changes, and both must stop the
 * batch rather than silently produce a partially-mapped import.
 */
export function mapHeader(header: readonly string[], layout: TrackerLayout): HeaderMapping {
  const fieldByIndex: (TrackerField | null)[] = [];
  const unknownColumns: string[] = [];
  const seen = new Set<TrackerField>();

  for (const cell of header) {
    const key = normaliseHeader(cell);
    if (key === "") {
      // A trailing blank header is a spreadsheet artefact, not a column.
      fieldByIndex.push(null);
      continue;
    }
    const field = layout.columns[key];
    if (!field) {
      unknownColumns.push(String(cell));
      fieldByIndex.push(null);
      continue;
    }
    fieldByIndex.push(field);
    seen.add(field);
  }

  const missingFields = layout.required.filter((f) => !seen.has(f));

  if (unknownColumns.length > 0 || missingFields.length > 0) {
    const parts: string[] = [];
    if (unknownColumns.length > 0) {
      parts.push(`unrecognised column(s): ${unknownColumns.join(", ")}`);
    }
    if (missingFields.length > 0) {
      parts.push(`missing required column(s): ${missingFields.join(", ")}`);
    }
    return {
      ok: false,
      reason: `Sheet shape does not match layout "${layout.id}" — ${parts.join("; ")}. ` +
        `No rows were imported: a changed sheet shape means no row's mapping can be trusted.`,
      unknownColumns,
      missingFields,
    };
  }

  return { ok: true, layout, fieldByIndex };
}
