import "server-only";

import { prisma } from "@/lib/prisma";
import { fetchTrackerCsv } from "@/lib/ops-tracker/csv-source";
import { ingestTrackerPayload } from "@/lib/ops-tracker/ingest";

// Scheduled reconciliation for the operations tracker.
//
// The Apps Script push is the primary path and lands within seconds. This runs
// the SAME import independently, so a dropped webhook — a failed trigger, a
// revoked authorisation, someone deleting the script — cannot mean permanently
// stale data. It reads the published CSV, which is slower and needs the workbook
// published; when it cannot read, it reports that rather than leaving the
// impression the data is current.
//
// Shared by the cron route and the admin "run it now" button, so the two can
// never drift into doing different things.

export type SegmentSyncResult = {
  segment: string;
  spreadsheetId: string;
  tab: string;
  ok: boolean;
  rowsAccepted?: number;
  rowsRejected?: number;
  error?: string;
};

export type ReconcileResult = {
  segmentsConsidered: number;
  results: SegmentSyncResult[];
  ranAt: string;
};

export async function reconcileOpsTrackers(
  fetchImpl: typeof fetch = fetch,
): Promise<ReconcileResult> {
  const segments = await prisma.propertySegment.findMany({
    where: {
      isActive: true,
      sourceSheetId: { not: null },
      sourceTabName: { not: null },
    },
    select: { name: true, sourceSheetId: true, sourceTabName: true },
    orderBy: { displayOrder: "asc" },
  });

  const results: SegmentSyncResult[] = [];

  for (const seg of segments) {
    const spreadsheetId = seg.sourceSheetId!;
    const tab = seg.sourceTabName!;

    const csv = await fetchTrackerCsv(spreadsheetId, tab, fetchImpl);
    if (!csv.ok) {
      results.push({ segment: seg.name, spreadsheetId, tab, ok: false, error: csv.reason });
      continue;
    }

    try {
      // Straight through the same validate-and-upsert path as the webhook, so
      // reconciliation cannot accept anything the push would have refused.
      const outcome = await ingestTrackerPayload({
        spreadsheetId,
        tab,
        // The raw grid, so the SAME locate-and-validate rule runs here as on the
        // webhook. Handing over a pre-split header would make this path the
        // authority on where the table starts, and the two paths could then
        // disagree about which rows are data.
        grid: csv.grid,
      });
      results.push({
        segment: seg.name,
        spreadsheetId,
        tab,
        ok: outcome.body.ok,
        rowsAccepted: outcome.body.rowsAccepted,
        rowsRejected: outcome.body.rowsRejected,
        error: outcome.body.error,
      });
    } catch (err) {
      results.push({
        segment: seg.name,
        spreadsheetId,
        tab,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { segmentsConsidered: segments.length, results, ranAt: new Date().toISOString() };
}
