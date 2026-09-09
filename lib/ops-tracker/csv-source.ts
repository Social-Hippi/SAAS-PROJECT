import "server-only";

// ─────────────────────────────────────────────────────────────────────────────
// PUBLISHED-CSV READER — the reconciliation backstop, never the primary path.
//
// The Apps Script push is the real ingest: it reads the sheet through the Sheets
// runtime, so the workbook stays private and an edit lands within seconds. This
// reader exists only so a DROPPED WEBHOOK cannot mean permanently stale data —
// the scheduled job re-imports independently and self-heals.
//
// Its limitations are real and are reported rather than hidden:
//
//   • it requires the workbook to be published to the web or link-readable. If
//     it is not, this returns a described failure and the report says the
//     reconciliation could not run — it does not fall back to stale numbers
//     pretending to be fresh;
//   • Google's published-CSV endpoint can trail a live edit by several minutes,
//     which is exactly why it is not the primary path;
//   • it yields DISPLAY strings, so dates arrive locale-formatted. The push path
//     avoids this entirely by formatting the underlying date value to ISO before
//     sending; here the parser's D/M/Y fallback applies.
// ─────────────────────────────────────────────────────────────────────────────

/** The gviz CSV endpoint for one named tab. */
export function publishedCsvUrl(spreadsheetId: string, tabName: string): string {
  const id = encodeURIComponent(spreadsheetId);
  const sheet = encodeURIComponent(tabName);
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${sheet}`;
}

/**
 * RFC 4180 CSV parse: quoted fields, doubled quotes inside them, embedded commas
 * and newlines. Written here rather than pulled in, because the only other
 * option in the tree (lib/csv.ts) writes CSV and does not read it, and a parser
 * this small is cheaper to own than to depend on.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Strip a BOM, which Google sometimes prepends and which would otherwise
  // become part of the first header cell and make it an unknown column.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export type CsvFetchResult =
  | { ok: true; header: string[]; rows: string[][] }
  | { ok: false; reason: string };

/**
 * Fetch and parse one tab. Never throws — a failure here must degrade to a
 * reported reconciliation failure, not a 500 on a scheduled job.
 */
export async function fetchTrackerCsv(
  spreadsheetId: string,
  tabName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CsvFetchResult> {
  let res: Response;
  try {
    res = await fetchImpl(publishedCsvUrl(spreadsheetId, tabName), {
      redirect: "follow",
      headers: { accept: "text/csv,text/plain;q=0.9" },
    });
  } catch (err) {
    return { ok: false, reason: `could not reach the published CSV endpoint: ${String(err)}` };
  }

  if (!res.ok) {
    return {
      ok: false,
      reason:
        `published CSV endpoint returned ${res.status}. The workbook is probably not ` +
        `published to the web — the Apps Script push remains the primary path, and this ` +
        `reconciliation could not run.`,
    };
  }

  const text = await res.text();

  // A private sheet answers 200 with an HTML sign-in page rather than an error.
  // Treating that as CSV would parse the login markup into "rows".
  const head = text.slice(0, 200).toLowerCase();
  if (head.includes("<html") || head.includes("<!doctype")) {
    return {
      ok: false,
      reason:
        "published CSV endpoint returned an HTML page, not CSV — the workbook is not " +
        "readable without a Google session, so this reconciliation could not run.",
    };
  }

  const parsed = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (parsed.length === 0) return { ok: false, reason: "published CSV was empty" };

  const [header, ...rows] = parsed;
  return { ok: true, header, rows };
}
