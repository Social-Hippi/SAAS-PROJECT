"use server";

import { revalidatePath } from "next/cache";
import { getCurrentMember } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { getTokenForApiCall } from "@/lib/token-access";
import { describeCustomer, loginCustomerId } from "@/lib/google-ads";

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

/** Disconnects Google Ads for a hotel — deletes the connection (encrypted tokens go with it). */
export async function disconnectGoogleAds(formData: FormData): Promise<void> {
  const member = await getCurrentMember();
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
  const member = await getCurrentMember();
  if (!member) return { error: "Your session has expired — please sign in again.", ok: false };

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

  // Re-derive the account's name + currency server-side from the stored token —
  // never trust the client-supplied id's metadata. This also validates the id is
  // actually accessible under this connection's authorization.
  let name: string | null = null;
  let currency: string | null = null;
  let isManager = false;
  try {
    const tok = await getTokenForApiCall("google_ads_access", conn.id, {
      agencyId: conn.agencyId,
      hotelClientId: id,
      source: "action:google-ads-select",
    });
    const details = await describeCustomer(tok.reveal(), customerId);
    name = details.descriptiveName;
    currency = details.currencyCode;
    isManager = details.manager;
  } catch {
    // Fall through with nulls; the sync will refresh the token if it expired.
  }

  await agencyScoped(prisma.googleAdsConnection).updateMany({
    where: { hotelClientId: id },
    data: {
      customerId,
      customerName: name,
      currencyCode: currency,
      loginCustomerId: isManager ? null : loginCustomerId(),
      status: "ACTIVE",
      lastSyncError: null,
      requiresReconnect: false,
      lastErrorReason: null,
    },
  });

  revalidate(id);
  return { error: null, ok: true };
}
