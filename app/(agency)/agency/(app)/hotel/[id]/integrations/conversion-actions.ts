"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { normalizeThankYouPatterns, PATTERN_SEPARATOR } from "@/lib/conversion-patterns";

// ─────────────────────────────────────────────────────────────────────────────
// How a completed booking is recognised.
//
// Like bookingDomains, this could only ever be set when a hotel was CREATED —
// no edit path, no UI. On Aster it is "/payment/razorpay-callback/*", which
// catches a Razorpay payment and nothing else. A booking taken pay-at-hotel, or
// through any other gateway, lands somewhere else and is never recorded: the
// guest arrives from the ad, books, and the report shows nothing.
//
// Nothing errors, and the visit still records — so the hotel appears to be
// tracked while its bookings quietly are not.
// ─────────────────────────────────────────────────────────────────────────────

export type ConversionState = { error: string | null; ok: boolean };

export async function setConversionDetection(
  _prev: ConversionState,
  formData: FormData,
): Promise<ConversionState> {
  const member = await requireAdmin();
  if (!member) return { error: "Only an agency admin can change tracking settings.", ok: false };

  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true },
  });
  if (!hotel) return { error: "That hotel wasn't found for your agency.", ok: false };

  const { patterns, rejected } = normalizeThankYouPatterns(
    String(formData.get("patterns") ?? ""),
  );

  if (rejected.length > 0) {
    // Refused whole: a half-saved list looks applied and silently drops a path,
    // which is the same silence this setting exists to end.
    return { error: `Not a usable path: ${rejected.join(", ")}`, ok: false };
  }
  if (patterns.length === 0) {
    return {
      error: "Add at least one confirmation path, or bookings cannot be detected.",
      ok: false,
    };
  }

  await agencyScoped(prisma.hotelClient).updateMany({
    where: { id: hotel.id },
    data: {
      // Newline-separated: the snippet's glob builder escapes "|", so a
      // pipe-joined list would match a literal pipe and therefore nothing.
      thankYouUrlPattern: patterns.join(PATTERN_SEPARATOR),
      conversionMethod: "url_change",
    },
  });

  revalidatePath(`/agency/hotel/${hotel.id}/integrations`);
  return { error: null, ok: true };
}
