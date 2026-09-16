"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { encryptToken } from "@/lib/encryption";

// Server actions for the Kraya card.
//
// THE SECRET IS SHOWN ONCE. Stored as AES-256-GCM ciphertext and readable
// afterwards only through getTokenForApiCall, which audits every access — so no
// screen can print it again, by design. Regenerating breaks Kraya's webhook
// until the new value is pasted back, and the card says so before it happens.

export type KrayaState = { error: string | null; ok: boolean; secret?: string };

async function ownHotel(hotelId: string) {
  return agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true, agencyId: true },
  });
}

/** Creates the connection, or re-mints the secret for an existing one. */
export async function connectKraya(
  _prev: KrayaState,
  formData: FormData,
): Promise<KrayaState> {
  const member = await requireAdmin();
  if (!member) return { error: "Only an agency admin can manage integrations.", ok: false };

  const hotel = await ownHotel(((formData.get("hotelId") as string | null) ?? "").trim());
  if (!hotel) return { error: "That hotel wasn't found for your agency.", ok: false };

  const secret = randomBytes(32).toString("base64url");

  await prisma.krayaConnection.upsert({
    where: { hotelClientId: hotel.id },
    create: {
      agencyId: hotel.agencyId,
      hotelClientId: hotel.id,
      credentials: encryptToken(secret),
      // "pending" until a lead actually arrives — the receiver flips it, so the
      // status reflects reality rather than what an operator hoped.
      status: "pending",
    },
    update: { credentials: encryptToken(secret), status: "pending", lastError: null },
  });

  revalidatePath(`/agency/hotel/${hotel.id}/integrations`);
  return { error: null, ok: true, secret };
}

/**
 * Nominates the stage that means "this became a booking".
 *
 * The ONLY stage name that carries a consequence. Every other one is displayed
 * exactly as Kraya spells it and needs no configuration at all.
 */
export async function setKrayaConfirmedStage(
  _prev: KrayaState,
  formData: FormData,
): Promise<KrayaState> {
  const member = await requireAdmin();
  if (!member) return { error: "Only an agency admin can manage integrations.", ok: false };

  const hotel = await ownHotel(((formData.get("hotelId") as string | null) ?? "").trim());
  if (!hotel) return { error: "That hotel wasn't found for your agency.", ok: false };

  const raw = ((formData.get("stage") as string | null) ?? "").trim();
  // Empty clears it, which stops bookings being created — a deliberate choice an
  // agency may want, so it is allowed rather than rejected.
  await agencyScoped(prisma.krayaConnection).updateMany({
    where: { hotelClientId: hotel.id },
    data: { confirmedStageName: raw.length > 0 ? raw : null },
  });

  revalidatePath(`/agency/hotel/${hotel.id}/integrations`);
  return { error: null, ok: true };
}

/** Removes the connection. Conversations and bookings already received are kept. */
export async function disconnectKraya(formData: FormData): Promise<void> {
  const member = await requireAdmin();
  if (!member) return;
  const hotel = await ownHotel(((formData.get("hotelId") as string | null) ?? "").trim());
  if (!hotel) return;

  // Only the connection goes. The leads and bookings it produced are facts, and
  // deleting them to unhook a webhook would destroy the attribution history this
  // integration exists to build.
  await prisma.krayaConnection.deleteMany({ where: { hotelClientId: hotel.id } });
  revalidatePath(`/agency/hotel/${hotel.id}/integrations`);
}
