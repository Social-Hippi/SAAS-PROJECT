"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { runGa4Sync } from "@/lib/ga4-sync";

// Server actions for the GA4 (OAuth) integration card. Connecting happens via the
// /api/auth/ga4/start redirect; these cover sync-now, disconnect, and choosing a
// property when the user has more than one. All multi-tenant: the hotel/connection
// is mutated through the agency-scoped delegate.

// `notice` is the third outcome, distinct from ok/error: the sync itself
// succeeded but wrote nothing, so the UI must not claim success. Optional so
// existing callers constructing { error, ok } keep compiling.
export type Ga4ActionState = { error: string | null; ok: boolean; notice?: string | null };

// Shown when GA4 answered normally but had no rows for the window — a brand-new
// property, a property with no traffic yet, or the wrong property picked. This
// is not an error, so it must not read as one; it is also not success, so it
// must not render "Synced ✓".
const NO_DATA_NOTICE =
  "Connected successfully, but no GA4 data was found for the selected date range.";

async function ownHotelId(hotelId: string): Promise<string | null> {
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true },
  });
  return hotel?.id ?? null;
}

function revalidate(hotelId: string) {
  revalidatePath(`/agency/hotel/${hotelId}/integrations`);
  revalidatePath(`/agency/hotel/${hotelId}`);
}

/** Manually triggers a GA4 sync for one hotel (the "Sync now" button). */
export async function syncGa4Now(_prev: Ga4ActionState, formData: FormData): Promise<Ga4ActionState> {
  const member = await requireAdmin();
  if (!member) return { error: "Only an agency admin can manage integrations.", ok: false };

  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const id = await ownHotelId(hotelId);
  if (!id) return { error: "That hotel wasn't found for your agency.", ok: false };

  const res = await runGa4Sync({ agencyId: member.agencyId, hotelClientId: id });
  revalidate(id);
  // Single-hotel scope, so any recorded error is THIS hotel's — report it even
  // if the connection also counted as synced.
  if (res.errors.length > 0) {
    return { error: res.errors[0].error, ok: false };
  }
  if (res.processed === 0) {
    return { error: "No active GA4 property to sync. Pick a property first.", ok: false };
  }
  // The connection synced cleanly but GA4 returned zero rows for every report,
  // so no Ga4Snapshot was written. Reporting success here is what made a
  // misconfigured property look healthy.
  if (res.daysSynced === 0) {
    return { error: null, ok: false, notice: NO_DATA_NOTICE };
  }
  return { error: null, ok: true };
}

/** Disconnects GA4 for a hotel — deletes the connection (encrypted tokens go with it). */
export async function disconnectGa4(formData: FormData): Promise<void> {
  const member = await requireAdmin();
  if (!member) return;
  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const id = await ownHotelId(hotelId);
  if (!id) return;

  await agencyScoped(prisma.ga4Connection).deleteMany({ where: { hotelClientId: id } });
  revalidate(id);
}

/** Selects which GA4 property to use (when the account has more than one). */
export async function selectGa4Property(_prev: Ga4ActionState, formData: FormData): Promise<Ga4ActionState> {
  const member = await requireAdmin();
  if (!member) return { error: "Only an agency admin can manage integrations.", ok: false };

  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const propertyId = ((formData.get("propertyId") as string | null) ?? "").trim();
  const propertyName = ((formData.get("propertyName") as string | null) ?? "").trim() || null;
  if (!propertyId) return { error: "Pick a property.", ok: false };

  const id = await ownHotelId(hotelId);
  if (!id) return { error: "That hotel wasn't found for your agency.", ok: false };

  await agencyScoped(prisma.ga4Connection).updateMany({
    where: { hotelClientId: id },
    data: { propertyId, propertyName, status: "ACTIVE", lastSyncError: null },
  });

  // Kick off a first sync so the dashboard fills immediately. Surface the same
  // three outcomes as "Sync now" — picking a property that turns out to hold no
  // data must not report a bare success.
  const res = await runGa4Sync({ agencyId: member.agencyId, hotelClientId: id });
  revalidate(id);
  if (res.errors.length > 0) return { error: res.errors[0].error, ok: false };
  if (res.daysSynced === 0) return { error: null, ok: false, notice: NO_DATA_NOTICE };
  return { error: null, ok: true };
}
