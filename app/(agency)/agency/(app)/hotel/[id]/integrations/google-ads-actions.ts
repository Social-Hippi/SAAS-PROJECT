"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { getTokenForApiCall } from "@/lib/token-access";
import { listCustomersWithDetails } from "@/lib/google-ads";
import { runGoogleAdsSync } from "@/lib/google-ads-sync";

// Server actions for the Google Ads (OAuth) integration card. Connecting happens
// via the /api/auth/google-ads/start redirect; these cover disconnect and choosing
// which Ads customer account to track when the user can access more than one.
// (Sync-now arrives in STEP 2 alongside the daily sync.) All multi-tenant: the
// hotel/connection is mutated through the agency-scoped delegate.

export type GoogleAdsActionState = { error: string | null; ok: boolean };

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

/** Manually triggers a Google Ads sync for one hotel (the "Sync now" button). */
export async function syncGoogleAdsNow(
  _prev: GoogleAdsActionState,
  formData: FormData,
): Promise<GoogleAdsActionState> {
  const member = await requireAdmin();
  if (!member) return { error: "Only an agency admin can manage integrations.", ok: false };

  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const id = await ownHotelId(hotelId);
  if (!id) return { error: "That hotel wasn't found for your agency.", ok: false };

  const res = await runGoogleAdsSync({ agencyId: member.agencyId, hotelClientId: id });
  revalidate(id);
  if (res.synced === 0 && res.errors.length > 0) {
    return { error: res.errors[0].error, ok: false };
  }
  if (res.processed === 0) {
    return { error: "No active Google Ads account to sync. Pick an account first.", ok: false };
  }
  return { error: null, ok: true };
}

/** Disconnects Google Ads for a hotel — deletes the connection (encrypted tokens go with it). */
export async function disconnectGoogleAds(formData: FormData): Promise<void> {
  const member = await requireAdmin();
  if (!member) return;
  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const id = await ownHotelId(hotelId);
  if (!id) return;

  await agencyScoped(prisma.googleAdsConnection).deleteMany({ where: { hotelClientId: id } });
  revalidate(id);
}

/** Selects which Ads customer account to track (when the user can access several). */
export async function selectGoogleAdsCustomer(
  _prev: GoogleAdsActionState,
  formData: FormData,
): Promise<GoogleAdsActionState> {
  const member = await requireAdmin();
  if (!member) return { error: "Only an agency admin can manage integrations.", ok: false };

  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const customerId = ((formData.get("customerId") as string | null) ?? "").replace(/\D/g, "");
  if (!customerId) return { error: "Pick an Ads account.", ok: false };

  const id = await ownHotelId(hotelId);
  if (!id) return { error: "That hotel wasn't found for your agency.", ok: false };

  const conn = await agencyScoped(prisma.googleAdsConnection).findFirst({
    where: { hotelClientId: id },
    select: { id: true, agencyId: true },
  });
  if (!conn) return { error: "Connect Google Ads first.", ok: false };

  // Re-derive the account server-side from the stored token — never trust the
  // client-supplied id's metadata. listCustomersWithDetails returns only syncable
  // NON-manager advertiser accounts (managers are expanded to their children), each
  // carrying the login-customer-id (MCC) it's reached through. The selected id MUST
  // be one of them; a manager/MCC or unknown id is rejected (it can't be synced —
  // metrics against a manager fail with REQUESTED_METRICS_FOR_MANAGER).
  let name: string | null = null;
  let currency: string | null = null;
  let login: string | null = null;
  try {
    const tok = await getTokenForApiCall("google_ads_access", conn.id, {
      agencyId: conn.agencyId,
      hotelClientId: id,
      source: "action:google-ads-select",
    });
    const accounts = await listCustomersWithDetails(tok.reveal());
    const match = accounts.find((a) => a.customerId === customerId);
    if (!match) {
      return {
        error:
          "That isn't a syncable advertiser account. Pick an advertiser account under your manager — a manager (MCC) account can't be synced.",
        ok: false,
      };
    }
    name = match.descriptiveName;
    currency = match.currencyCode;
    login = match.loginCustomerId;
  } catch {
    // Token likely expired: store the id and let the sync refresh + surface errors.
    // loginCustomerId stays null; the next reconnect re-derives it.
  }

  await agencyScoped(prisma.googleAdsConnection).updateMany({
    where: { hotelClientId: id },
    data: {
      customerId,
      customerName: name,
      currencyCode: currency,
      loginCustomerId: login,
      status: "ACTIVE",
      lastSyncError: null,
      requiresReconnect: false,
      lastErrorReason: null,
    },
  });

  // Kick off a first sync so the Google Ads channel fills immediately.
  await runGoogleAdsSync({ agencyId: member.agencyId, hotelClientId: id });
  revalidate(id);
  return { error: null, ok: true };
}
