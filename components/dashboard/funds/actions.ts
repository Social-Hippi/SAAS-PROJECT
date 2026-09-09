"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { rateLimit, clientIpFromHeaders } from "@/lib/ratelimit";
import { resolveHotelAccess } from "@/lib/hotel-access";

// ─────────────────────────────────────────────────────────────────────────────
// Saving a low-balance reminder. THIS ACTION REQUIRES A SESSION.
//
// It used to accept a /share/<uuid> token as a credential, which made it the one
// write a link-holder could perform. That was wrong, and not marginally: a share
// URL is unauthenticated and forwardable, the reminder names the address that
// receives this hotel's ad-account BALANCE, and LowBalanceReminder is UNIQUE per
// hotel. So anyone holding a forwarded link could both redirect those figures to
// an inbox of their choosing AND silently overwrite the address the agency had
// set — no confirmation step, and the per-(token+IP) rate limit is per-instance
// in production, so it did not bound the attempt either.
//
// Hiding the form on the share surface is NOT the control. A hidden form is not
// a control; the server refusing the caller is. The `viewer !== "share"` gate in
// AvailableFundsCard mirrors this guard so the UI does not offer what the server
// will reject — it does not replace it.
//
// Authorization is resolveHotelAccess(), the same gate the rest of the hotel
// surfaces use: it requires a Clerk session, resolves the hotel row FIRST and
// reads agencyId off that row, and fails closed on signed-out, no membership,
// soft-deleted hotel and suspended agency. Both principals — an agency member
// and a hotel-side user — reach the write through it, and nothing else does.
//
// hotelClientId is taken from the RESOLVED ACCESS, never from the form, so a
// caller cannot name one hotel and write to another.
// ─────────────────────────────────────────────────────────────────────────────

export type ReminderResult = { ok: true } | { ok: false; error: string };

/** RFC-shaped enough to catch typos without rejecting valid unusual addresses. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** A threshold has to be a real amount — and small enough to be a warning. */
const MIN_THRESHOLD = 1;
const MAX_THRESHOLD = 10_000_000; // ₹1 crore; beyond this it is not a "low balance"

export async function saveLowBalanceReminder(input: {
  hotelId: string;
  email: string;
  /** Major units as typed by the person (₹5,000 → 5000). */
  threshold: string;
  enabled?: boolean;
}): Promise<ReminderResult> {
  // ── Authorise FIRST — before validation, before any IO ──────────────────────
  // An unauthenticated caller must not be able to probe this action's behaviour
  // (which addresses parse, which thresholds are in range), and there is nothing
  // here worth doing for one. Signed out → resolveHotelAccess returns null.
  const access = await resolveHotelAccess(input.hotelId);
  if (!access) {
    return { ok: false, error: "You don't have access to this hotel." };
  }
  const { agencyId, hotelClientId } = access;

  // Defence in depth on the authenticated path: one signed-in caller still can't
  // hammer the write. Fails CLOSED, like every other bucket here.
  const ip = clientIpFromHeaders(await headers());
  const rl = await rateLimit("shareReminder", `${hotelClientId}:${ip}`);
  if (!rl.ok) {
    return { ok: false, error: "Too many attempts. Please wait a moment and try again." };
  }

  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }

  const amount = Number(input.threshold.replace(/[,\s₹]/g, ""));
  if (!Number.isFinite(amount) || amount < MIN_THRESHOLD || amount > MAX_THRESHOLD) {
    return { ok: false, error: "Please enter a threshold amount between ₹1 and ₹1,00,00,000." };
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

  revalidatePath(`/agency/hotel/${hotelClientId}`);
  return { ok: true };
}
