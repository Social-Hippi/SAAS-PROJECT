"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { encryptToken } from "@/lib/encryption";
import { getBookingProvider } from "@/lib/booking-provider";
import "@/lib/booking-providers/simplotel";

// ─────────────────────────────────────────────────────────────────────────────
// Booking connection setup — the missing half of the Booking Push integration.
//
// Everything downstream of this has existed for months: the receiver, tenant
// resolution from the secret, idempotency, lifecycle history, journey matching.
// What did not exist was any way to CREATE the row those depend on, so no hotel
// was ever connected and every booking figure fell back to the tracking snippet.
//
// THE SECRET IS SHOWN ONCE. It is stored as AES-256-GCM ciphertext, readable
// afterwards only through getTokenForApiCall (which audits every access) — so
// there is no screen that can print it again, by design. A lost secret is
// regenerated, not recovered, and regenerating breaks the provider's config
// until they are given the new one. The UI says so before it happens.
// ─────────────────────────────────────────────────────────────────────────────

export type BookingConnectionState = {
  error: string | null;
  ok: boolean;
  /** Plaintext, returned EXACTLY once — on the call that minted it. */
  secret?: string;
};

/** 32 bytes of CSPRNG, URL-safe. Long enough that it is never brute-forced. */
function mintSecret(): string {
  return randomBytes(32).toString("base64url");
}

async function ownHotel(hotelId: string) {
  return agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true, agencyId: true },
  });
}

/**
 * Creates the connection (or re-mints the secret for an existing one) and
 * returns the plaintext for the operator to hand to the provider.
 *
 * Deliberately one action for both: "connect" and "regenerate" differ only in
 * whether a row already exists, and splitting them invited a second code path
 * that could store the secret differently.
 */
export async function connectBookingProvider(
  _prev: BookingConnectionState,
  formData: FormData,
): Promise<BookingConnectionState> {
  const member = await requireAdmin();
  if (!member) return { error: "Only an agency admin can manage integrations.", ok: false };

  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const provider = ((formData.get("provider") as string | null) ?? "").trim().toLowerCase();

  const hotel = await ownHotel(hotelId);
  if (!hotel) return { error: "That hotel wasn't found for your agency.", ok: false };

  // Reject a provider with no adapter rather than storing a row the receiver
  // will 404 every push against.
  if (!getBookingProvider(provider)) {
    return { error: `No adapter exists for "${provider}".`, ok: false };
  }

  const secret = mintSecret();
  const credentials = encryptToken(secret);

  await prisma.bookingConnection.upsert({
    // Keyed by hotel AND provider: a hotel legitimately has more than one source
    // (Simplotel for web bookings, Kraya for WhatsApp), and they must not
    // overwrite each other's secret.
    where: { hotelClientId_provider: { hotelClientId: hotel.id, provider } },
    create: {
      agencyId: hotel.agencyId,
      hotelClientId: hotel.id,
      provider,
      credentials,
      // "pending" until a push actually arrives. The receiver flips it, so the
      // status reflects reality rather than what an operator hoped.
      status: "pending",
    },
    update: { provider, credentials, status: "pending", lastError: null },
  });

  revalidatePath(`/agency/hotel/${hotel.id}/integrations`);
  return { error: null, ok: true, secret };
}

/** Removes the connection. Bookings already received are kept — they are facts. */
export async function disconnectBookingProvider(formData: FormData): Promise<void> {
  const member = await requireAdmin();
  if (!member) return;

  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const hotel = await ownHotel(hotelId);
  if (!hotel) return;

  // Booking.connectionId is onDelete: SetNull, so the reservations survive with
  // their revenue and journey matches intact. Deleting history to disconnect a
  // webhook would be destroying the very thing the integration exists to build.
  // Scoped to the provider named in the form, so disconnecting Simplotel cannot
  // silently remove a Kraya connection for the same hotel.
  const provider = ((formData.get("provider") as string | null) ?? "").trim().toLowerCase();
  await prisma.bookingConnection.deleteMany({
    where: { hotelClientId: hotel.id, ...(provider ? { provider } : {}) },
  });
  revalidatePath(`/agency/hotel/${hotel.id}/integrations`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Recording pushes that were held while the provider had no field mapping.
// ─────────────────────────────────────────────────────────────────────────────

export type ReplayState = {
  error: string | null;
  /** Null until a replay has run in this session. */
  summary: string | null;
  problems: string[];
};

/**
 * Turns every held push for this hotel into the booking it always was.
 *
 * ADMIN ONLY, and the tenant comes from the connection we look up — never from
 * anything the form sends. Safe to press twice: a recorded body is skipped, and
 * ingestion is keyed on the provider's reservation id regardless.
 */
export async function recordHeldPushes(
  _prev: ReplayState,
  formData: FormData,
): Promise<ReplayState> {
  const member = await requireAdmin();
  if (!member) {
    return { error: "Only an agency admin can record held bookings.", summary: null, problems: [] };
  }

  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const connection = await agencyScoped(prisma.bookingConnection).findFirst({
    where: { hotelClientId: hotelId },
    select: { id: true, agencyId: true, hotelClientId: true, provider: true },
  });
  if (!connection) {
    return { error: "No booking connection was found for this hotel.", summary: null, problems: [] };
  }

  const { replayHeldPushes } = await import("@/lib/booking-push-replay");
  const out = await replayHeldPushes(connection);

  revalidatePath(`/agency/hotel/${hotelId}/integrations`);
  // The hotel's report reads these bookings, so it has to be rebuilt too.
  revalidatePath("/share", "layout");

  const parts = [
    `${out.recorded} recorded`,
    out.stillHeld > 0 ? `${out.stillHeld} still held` : null,
    out.alreadyRecorded > 0 ? `${out.alreadyRecorded} already recorded` : null,
  ].filter(Boolean);

  return { error: null, summary: parts.join(" · "), problems: out.problems };
}
