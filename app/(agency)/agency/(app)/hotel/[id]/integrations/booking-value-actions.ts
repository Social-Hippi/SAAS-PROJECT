"use server";

import { revalidatePath } from "next/cache";

import { getCurrentMember } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";

export type BookingValueState = { error: string | null; ok: boolean };

/** Rupees, to two decimals, within what the Decimal(12,2) column can hold. */
const MAX_AMOUNT = 9_999_999_999.99;

/**
 * Parses a typed amount.
 *
 * Returns `undefined` for "leave it alone", `null` for "clear it", a number to
 * set. The three are kept apart because an empty box means the agency has not
 * valued this booking yet — and storing that as 0 would put a booking worth an
 * unknown amount into the hotel's revenue as one worth nothing.
 */
function parseAmount(raw: string | null): number | null | undefined | "invalid" {
  if (raw == null) return undefined;
  const t = raw.trim().replace(/[, ]/g, "");
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return "invalid";
  return Math.round(n * 100) / 100;
}

/**
 * Saves the agency's valuation of one WhatsApp booking: the amount, and whether
 * they count it as coming from an ad.
 *
 * Multi-tenant: the booking is re-read through `agencyScoped` before the write,
 * so a booking id belonging to another agency simply is not found.
 *
 * The ad mark is only meaningful for an UNTRACED booking. A traced one already
 * carries the record, and the report counts it from that — so the flag is
 * stored as sent but changes nothing for those, and the UI does not offer it.
 */
export async function saveBookingValue(
  _prev: BookingValueState,
  formData: FormData,
): Promise<BookingValueState> {
  const member = await getCurrentMember();
  if (!member) return { error: "Your session has expired — please sign in again.", ok: false };

  const bookingId = ((formData.get("bookingId") as string | null) ?? "").trim();
  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();

  const booking = await agencyScoped(prisma.booking).findFirst({
    where: { id: bookingId, hotelClientId: hotelId, provider: "kraya" },
    select: { id: true },
  });
  if (!booking) return { error: "That booking wasn't found for your agency.", ok: false };

  const amount = parseAmount(formData.get("amount") as string | null);
  if (amount === "invalid") {
    return { error: "Enter the booking value as a number, or leave it blank.", ok: false };
  }

  const marked = formData.get("marked") === "1";

  await agencyScoped(prisma.booking).update({
    where: { id: booking.id },
    data: {
      agencyAdAttributed: marked,
      ...(amount === undefined
        ? {}
        : {
            agencyRevenue: amount,
            // Cleared amounts drop their provenance too, so a blank box never
            // sits next to a name and a date implying somebody stands behind it.
            agencyRevenueCurrency: amount == null ? null : "INR",
            agencyRevenueBy: amount == null ? null : member.id,
            agencyRevenueAt: amount == null ? null : new Date(),
          }),
    },
  });

  // The hotel's share link reads these figures, so it has to be rebuilt too —
  // otherwise the agency sees the new amount and the client keeps seeing the old.
  revalidatePath(`/agency/hotel/${hotelId}/integrations`);
  revalidatePath("/share", "layout");
  return { error: null, ok: true };
}
