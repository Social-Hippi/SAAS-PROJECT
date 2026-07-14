"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { clampResetDay, paiseFromRupees } from "@/lib/budget";

export type BudgetSettingsState = { error: string | null; ok: boolean };

/**
 * Saves a hotel's ad-budget settings. Budget is entered in whole rupees and
 * stored in paise. When tracking is disabled, the saved budget/reset-day are
 * preserved (so re-enabling restores them). Multi-tenant: the hotel is verified
 * against the caller's agency.
 */
export async function saveBudgetSettings(
  _prev: BudgetSettingsState,
  formData: FormData,
): Promise<BudgetSettingsState> {
  const member = await requireAdmin();
  if (!member) return { error: "Only an agency admin can manage integrations.", ok: false };

  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const enabled = formData.get("budgetTrackingEnabled") === "on";
  const budgetRaw = ((formData.get("monthlyAdBudgetRupees") as string | null) ?? "").trim();
  const resetDay = clampResetDay(Number.parseInt((formData.get("budgetResetDay") as string | null) ?? "1", 10));

  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true, monthlyAdBudget: true, budgetResetDay: true },
  });
  if (!hotel) return { error: "That hotel client wasn't found for your agency.", ok: false };

  if (enabled) {
    const rupees = Number(budgetRaw.replace(/[,\s₹]/g, ""));
    if (!budgetRaw || !Number.isFinite(rupees) || rupees <= 0) {
      return { error: "Enter a monthly budget amount (in ₹) to enable tracking.", ok: false };
    }
    await agencyScoped(prisma.hotelClient).update({
      where: { id: hotel.id },
      data: { budgetTrackingEnabled: true, monthlyAdBudget: paiseFromRupees(rupees), budgetResetDay: resetDay },
    });
  } else {
    // Keep the existing budget/reset-day so re-enabling restores them.
    await agencyScoped(prisma.hotelClient).update({
      where: { id: hotel.id },
      data: { budgetTrackingEnabled: false },
    });
  }

  revalidatePath(`/agency/hotel/${hotel.id}/integrations`);
  revalidatePath(`/agency/hotel/${hotel.id}`);
  return { error: null, ok: true };
}
