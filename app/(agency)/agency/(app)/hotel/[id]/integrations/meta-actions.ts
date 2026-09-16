"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { syncHotelAds } from "@/lib/meta-sync";

// Server action for the Meta Ads card's "Sync now" button.
//
// WHY THIS EXISTS. GA4, Google Ads and Instagram each had a manual sync; Meta
// Ads did not, so its only path was the 02:00 UTC cron. That gap mattered the
// day a write bug was fixed: the repair could not be applied until the next
// night, and nobody could confirm the fix had worked in the meantime.
//
// A 30-day window rather than the cron's 7. This button is reached for when
// something looks wrong, and re-pulling a month is one paginated Insights call —
// cheap next to being unable to repair a gap wider than a week.

export type MetaSyncState = { error: string | null; ok: boolean; message?: string };

const WINDOW_DAYS = 30;

export async function syncMetaNow(
  _prev: MetaSyncState,
  formData: FormData,
): Promise<MetaSyncState> {
  const member = await requireAdmin();
  if (!member) return { error: "Only an agency admin can manage integrations.", ok: false };

  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();

  // syncHotelAds scopes its own queries by the hotel's agencyId, but it takes an
  // id on trust — its doc says the CALLER must be authorized. This lookup is that
  // authorization: agencyScoped resolves nothing for another agency's hotel.
  const owned = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true },
  });
  if (!owned) return { error: "That hotel wasn't found for your agency.", ok: false };

  const res = await syncHotelAds(owned.id, WINDOW_DAYS);

  revalidatePath(`/agency/hotel/${owned.id}/integrations`);
  revalidatePath(`/agency/hotel/${owned.id}`);

  if (!res.ok) return { error: res.error ?? "Sync failed.", ok: false };
  return {
    error: null,
    ok: true,
    message: `${res.snapshotsWritten ?? 0} day${res.snapshotsWritten === 1 ? "" : "s"} refreshed`,
  };
}
