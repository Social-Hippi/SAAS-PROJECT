import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant";
import { TtlLruCache } from "@/lib/lru-cache";
import { DEFAULT_TIMEZONE, safeTimeZone } from "@/lib/timezone";

// The property timezone, for the hotel-scoped API routes that receive a window
// as bare YYYY-MM-DD strings and must cut those days the SAME way the page that
// produced them did.
//
// Without this, /savings and /revenue-by-source parsed "2026-09-01" at UTC
// midnight while the page had resolved it to midnight IST — so two panels on one
// page, driven by one query string, covered windows 5h30m apart at each end.
//
// Cached for five minutes: a timezone changes approximately never, and these
// routes are called on every dashboard render. Tenant-scoped like every other
// read, and failing to the default rather than throwing — a report must not 500
// because a timezone lookup blinked.

const cache = new TtlLruCache<string>(200, 5 * 60_000);

export async function propertyTimezone(agencyId: string, hotelClientId: string): Promise<string> {
  const key = `${agencyId}|${hotelClientId}`;
  const hit = cache.get(key);
  if (hit) return hit;

  try {
    const row = await agencyScopedFor(agencyId, prisma.hotelClient).findFirst({
      where: { id: hotelClientId },
      select: { timezone: true },
    });
    const tz = safeTimeZone(row?.timezone);
    cache.set(key, tz);
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}
