import { prisma } from "@/lib/prisma";
import { SyncNowForm, type SyncableHotel } from "./SyncNowForm";
import { OpsTrackerForm } from "./OpsTrackerForm";

// Super-admin manual Meta sync. Lists hotels across ALL agencies — this is the
// platform owner's cross-tenant view (the proxy + admin layout gate /admin to
// super_admin; the action additionally requires ADMIN_PASSWORD). Useful for
// demos and testing before the daily cron has run.

export const dynamic = "force-dynamic";

export default async function AdminSyncNowPage() {
  const rows = await prisma.hotelClient.findMany({
    select: {
      id: true,
      name: true,
      metaAdAccountId: true,
      lastSyncedAt: true,
      agency: { select: { name: true } },
    },
    orderBy: [{ agency: { name: "asc" } }, { name: "asc" }],
  });

  const hotels: SyncableHotel[] = rows.map((h) => ({
    id: h.id,
    name: h.name,
    agencyName: h.agency.name,
    mapped: h.metaAdAccountId != null,
    lastSyncedAt: h.lastSyncedAt?.toISOString() ?? null,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Manual Meta sync</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Pull a hotel&apos;s trailing ads data right now instead of waiting for
          the daily cron. Hotels without a mapped ad account can&apos;t be
          synced.
        </p>
      </div>

      <SyncNowForm hotels={hotels} />

      <div className="border-t border-line pt-6">
        <h2 className="text-sm font-medium text-ink">Operations trackers</h2>
        <p className="mt-1 text-sm text-ink-tertiary">
          Re-import every configured property workbook now. The bound Apps Script
          already pushes on every edit and a daily cron reconciles; this is for
          when a sheet has just been corrected and you do not want to wait.
        </p>
        <div className="mt-3">
          <OpsTrackerForm />
        </div>
      </div>

      <div>
        <h2 className="text-sm font-medium text-ink-tertiary">Last synced</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {hotels.map((h) => (
            <li key={h.id} className="text-ink-secondary">
              {h.agencyName} / {h.name} —{" "}
              {h.lastSyncedAt
                ? new Date(h.lastSyncedAt).toLocaleString()
                : "never"}
              {!h.mapped && " (no ad account mapped)"}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
