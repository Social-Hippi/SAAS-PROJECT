import "server-only";

import { prisma } from "@/lib/prisma";
import { isBookingDomain } from "@/lib/journey-token";

// ─────────────────────────────────────────────────────────────────────────────
// Install health — making a broken snippet install VISIBLE.
//
// WHY THIS EXISTS
// A siteId mistyped into a site's template drops 100% of that site's traffic
// and, until now, produced nothing but a bare 403. Aster Holidays shipped
// `cmru6bnm00010416vl4yiwa6` on its booking engine — the real id with `o` read
// as `0` and `l` as `1` — and every event from that host was discarded for
// weeks with no signal to anyone.
//
// WHAT THIS DOES
// Emits ONE structured line per rejected request carrying: a redacted id (its
// head, tail and length — enough to recognise a near-miss of a real siteId,
// never enough to reconstruct a working one), the Origin, the reason, and the
// hotel WHEN the origin can be resolved deterministically.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// It does not write to the database. Both call sites are PUBLIC and
// UNAUTHENTICATED, so persisting a row per rejection would let anyone amplify
// writes at will. The resolution below is a single indexed read, behind the
// endpoints' existing rate limiter, and is skipped entirely without an Origin.
// ─────────────────────────────────────────────────────────────────────────────

export type RejectionReason = "unknown_site_id" | "hotel_deleted" | "snippet_disabled";

/** Head/tail/length only — recognisable, not reusable. */
export function redactSiteId(siteId: string): { head: string; tail: string; length: number } {
  return { head: siteId.slice(0, 6), tail: siteId.slice(-4), length: siteId.length };
}

/** Host of an Origin/Referer header, or null when absent or unparseable. */
export function originHost(headers: Headers): string | null {
  const raw = headers.get("origin") ?? headers.get("referer");
  if (!raw) return null;
  try { return new URL(raw).host.toLowerCase(); } catch { return null; }
}

/**
 * Resolve an origin to a hotel DETERMINISTICALLY — exact website host, or a
 * host the hotel has declared as a booking domain. Returns null when the origin
 * matches none, or more than one, hotel: an ambiguous match is not a match, and
 * naming the wrong hotel in an install warning is worse than naming none.
 */
export async function resolveHotelByOrigin(host: string | null): Promise<{ id: string; name: string } | null> {
  if (!host) return null;
  let candidates: { id: string; name: string; websiteUrl: string; bookingDomains: string[] }[];
  try {
    candidates = await prisma.hotelClient.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, websiteUrl: true, bookingDomains: true },
    });
  } catch {
    return null; // never let diagnostics break the request path
  }

  const matches = candidates.filter((h) => {
    let siteHost = "";
    try { siteHost = new URL(h.websiteUrl).host.toLowerCase(); } catch { /* ignore */ }
    const bare = siteHost.replace(/^www\./, "");
    const probe = host.replace(/^www\./, "");
    if (bare && probe === bare) return true;
    return isBookingDomain(host, h.bookingDomains);
  });

  return matches.length === 1 ? { id: matches[0].id, name: matches[0].name } : null;
}

/** Emit the diagnostic. Never throws — diagnostics must not break tracking. */
export async function logSnippetRejection(args: {
  siteId: string;
  headers: Headers;
  reason: RejectionReason;
  endpoint: string;
}): Promise<void> {
  try {
    const host = originHost(args.headers);
    const hotel = await resolveHotelByOrigin(host);
    console.warn(
      "[SNIPPET-REJECTED]",
      JSON.stringify({
        endpoint: args.endpoint,
        reason: args.reason,
        siteId: redactSiteId(args.siteId),
        origin: host,
        hotelClientId: hotel?.id ?? null,
        hotelName: hotel?.name ?? null,
        at: new Date().toISOString(),
      }),
    );
  } catch { /* diagnostics are best-effort */ }
}
