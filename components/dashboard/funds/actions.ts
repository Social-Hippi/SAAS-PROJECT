"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { rateLimit, clientIpFromHeaders } from "@/lib/ratelimit";
import { resolveShareLink } from "@/lib/share-link-access";
import { resolveHotelAccess } from "@/lib/hotel-access";

// ─────────────────────────────────────────────────────────────────────────────
// Saving a low-balance reminder.
//
// THE ONLY WRITE a /share/<uuid> holder can perform, so it is the one place the
// public report's read-only posture is relaxed — deliberately, because the brief
// asks the hotel itself to configure this, and deliberately narrowly:
//
//   • the token must resolve, be live, and address THE HOTEL BEING WRITTEN TO.
//     hotelClientId is taken from the resolved link, never from the form.
//   • rate-limited per (token + IP), failing CLOSED. This action names an email
//     address that will receive figures about the hotel, so an unmetered version
//     would be a way to fan hotel data out to arbitrary inboxes.
//   • it can only ever create or update ONE row for that hotel, and touches no
//     other field on any other table.
//
// A signed-in agency member or hotel user reaches the same action without a
// token, via resolveHotelAccess. Both paths end at the same write.
// ─────────────────────────────────────────────────────────────────────────────

export type ReminderResult = { ok: true } | { ok: false; error: string };

/** RFC-shaped enough to catch typos without rejecting valid unusual addresses. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** A threshold has to be a real amount — and small enough to be a warning. */
const MIN_THRESHOLD = 1;
const MAX_THRESHOLD = 10_000_000; // ₹1 crore; beyond this it is not a "low balance"

export async function saveLowBalanceReminder(input: {
  hotelId: string;
  shareToken?: string;
  email: string;
  /** Major units as typed by the person (₹5,000 → 5000). */
  threshold: string;
  enabled?: boolean;
}): Promise<ReminderResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }

  const amount = Number(input.threshold.replace(/[,\s₹]/g, ""));
  if (!Number.isFinite(amount) || amount < MIN_THRESHOLD || amount > MAX_THRESHOLD) {
    return { ok: false, error: "Please enter a threshold amount between ₹1 and ₹1,00,00,000." };
  }

  // ── Authorise, and derive the tenant from the credential, never the form ──
  let agencyId: string;
  let hotelClientId: string;

  if (input.shareToken) {
    const ip = clientIpFromHeaders(await headers());
    const rl = await rateLimit("shareReminder", `${input.shareToken}:${ip}`);
    if (!rl.ok) {
      return { ok: false, error: "Too many attempts. Please wait a moment and try again." };
    }

    const resolution = await resolveShareLink(input.shareToken);
    if (!resolution.ok) {
      return { ok: false, error: "This report link is no longer active." };
    }
    // The token must address the hotel being written to.
    if (resolution.link.hotelClientId !== input.hotelId) {
      return { ok: false, error: "This report link is no longer active." };
    }
    agencyId = resolution.link.agencyId;
    hotelClientId = resolution.link.hotelClientId;
  } else {
    const access = await resolveHotelAccess(input.hotelId);
    if (!access) {
      return { ok: false, error: "You don't have access to this hotel." };
    }
    agencyId = access.agencyId;
    hotelClientId = access.hotelClientId;
  }

  const thresholdMinor = Math.round(amount * 100);
  const enabled = input.enabled ?? true;

  try {
    await prisma.lowBalanceReminder.upsert({
      where: { hotelClientId },
      create: { agencyId, hotelClientId, email, thresholdMinor, enabled },
      update: {
        email,
        thresholdMinor,
        enabled,
        // A changed threshold re-arms the reminder: the previous "already told
        // you" state was about a different number.
        triggered: false,
      },
    });
  } catch {
    return { ok: false, error: "We couldn't save that just now. Please try again." };
  }

  revalidatePath(input.shareToken ? `/share/${input.shareToken}` : `/agency/hotel/${hotelClientId}`);
  return { ok: true };
}
