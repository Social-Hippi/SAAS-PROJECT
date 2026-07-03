"use client";

import { useState } from "react";

// "Generate Report" menu. All three formats are produced SERVER-SIDE from the
// hotel's real data (no DOM screenshot): the PDF is a branded, owner-friendly
// performance report; Excel/CSV are raw-data exports. Each is a plain download
// link to its API route, which enforces that the hotel belongs to the caller's
// agency before generating.

export function ReportMenu({
  hotelId,
  from,
  to,
}: {
  hotelId: string;
  from: string;
  to: string;
}) {
  const [open, setOpen] = useState(false);

  const q = `hotelId=${encodeURIComponent(hotelId)}&from=${from}&to=${to}`;
  const pdfHref = `/api/reports/pdf?${q}`;
  const excelHref = `/api/reports/excel?${q}`;
  const csvHref = `/api/reports/csv?${q}`;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover"
      >
        Generate Report ▾
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-2 w-56 overflow-hidden rounded-lg border border-line bg-elevated shadow-[0_10px_40px_rgba(0,0,0,0.5)]">
          <a
            href={pdfHref}
            onClick={() => setOpen(false)}
            className="block w-full px-4 py-2.5 text-left text-sm text-ink-secondary hover:bg-line-strong"
          >
            PDF report
            <span className="block text-xs text-ink-tertiary">Full performance report · owner-friendly</span>
          </a>
          <a
            href={excelHref}
            onClick={() => setOpen(false)}
            className="block w-full border-t border-line px-4 py-2.5 text-left text-sm text-ink-secondary hover:bg-line-strong"
          >
            Excel export
            <span className="block text-xs text-ink-tertiary">4 sheets · raw data</span>
          </a>
          <a
            href={csvHref}
            onClick={() => setOpen(false)}
            className="block w-full border-t border-line px-4 py-2.5 text-left text-sm text-ink-secondary hover:bg-line-strong"
          >
            CSV export
            <span className="block text-xs text-ink-tertiary">Event log · one flat file</span>
          </a>
        </div>
      )}
    </div>
  );
}
