"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { normalizeBookingHost } from "@/lib/booking-domains";

// ─────────────────────────────────────────────────────────────────────────────
// Which hosts a booking link may carry the visitor's identity to.
//
// WHY THIS SETTING DECIDES WHETHER AD ATTRIBUTION WORKS AT ALL.
//
// A guest clicks a Google ad, lands on the hotel's site with a gclid, then
// follows a "Book now" link to a DIFFERENT host — the booking engine. Cookies
// are per-origin, so nothing crosses on its own. The snippet bridges the gap by
// rewriting outbound booking links with a `_ht_j` token carrying the session,
// visitor, UTMs and click ids.
//
// It only rewrites links to hosts listed HERE. An empty list decorates nothing,
// so every ad click dies at the domain boundary and the booking that follows
// looks organic forever. Nothing errors; the attribution simply never exists.
//
// On Aster that was the whole bottleneck: 4,057 gclid-carrying visits reached
// asterholidays.com and ZERO reached bookings.coffeeberryhills.in.
//
// A HOST IS A CAPABILITY, NOT A LABEL. Anything listed receives a token that
// identifies a real visitor, so entries are normalised to bare hostnames and
// matched exactly or as a true subdomain — never as a bare suffix, or an entry
// for "example.com" would hand identity to "evil-example.com".
// ─────────────────────────────────────────────────────────────────────────────

export type BookingDomainState = { error: string | null; ok: boolean };

export async function setBookingDomains(
  _prev: BookingDomainState,
  formData: FormData,
): Promise<BookingDomainState> {
  const member = await requireAdmin();
  if (!member) return { error: "Only an agency admin can change tracking settings.", ok: false };

  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true },
  });
  if (!hotel) return { error: "That hotel wasn't found for your agency.", ok: false };

  const raw = String(formData.get("domains") ?? "");
  const entries = raw
    .split(/[\s,\n]+/)
    .map((e) => e.trim())
    .filter(Boolean);

  const hosts: string[] = [];
  const rejected: string[] = [];
  for (const entry of entries) {
    const host = normalizeBookingHost(entry);
    if (!host) rejected.push(entry);
    else if (!hosts.includes(host)) hosts.push(host);
  }

  if (rejected.length > 0) {
    // Refuse the whole submission rather than saving the valid half: a partially
    // applied list looks saved and silently omits a host.
    return { error: `Not a valid hostname: ${rejected.join(", ")}`, ok: false };
  }

  await agencyScoped(prisma.hotelClient).updateMany({
    where: { id: hotel.id },
    data: { bookingDomains: hosts },
  });

  revalidatePath(`/agency/hotel/${hotel.id}/integrations`);
  return { error: null, ok: true };
}
