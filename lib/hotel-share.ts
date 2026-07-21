import "server-only";

import { randomBytes, createHash } from "node:crypto";

// Helpers for the hotel share surface.
//
// MIGRATION — PHASE 1: the hotel's live access path is the public /share/<token>
// report link (ShareLink.token, minted by Prisma @default(uuid()) in
// share-actions.ts and rendered by ShareLinkManager). The older /h/<shareToken>
// flow is NO LONGER RENDERED anywhere, but generateShareToken() and
// hotelShareUrl() below are deliberately retained so hotel-share-actions.ts and
// HotelShareManager.tsx still compile and the change is trivially revertible.
// Both are dead code in Phase 1 and are removed in Phase 2.

/** A fresh 256-bit (32-byte) hex share token. */
export function generateShareToken(): string {
  return randomBytes(32).toString("hex");
}

// ── Visitor IP hashing ───────────────────────────────────────────────────────
// The access log stores only a SALTED SHA-256 of the IP, never the raw address,
// so the agency can tell "same visitor / how many times" without us holding PII.
// The salt is a server-only secret, so a hash can't be reversed via a rainbow
// table of known IPs.

function ipSalt(): string {
  return process.env.ENCRYPTION_KEY || process.env.CRON_SECRET || "hoteltrack-dev-share-secret";
}

/** Salted SHA-256 of a client IP. Returns null when the IP is unknown. */
export function hashIp(ip: string | null | undefined): string | null {
  const v = (ip ?? "").trim();
  if (!v) return null;
  return createHash("sha256").update(`${ipSalt()}:${v}`).digest("hex");
}

/** Best-effort client IP from the request headers (behind Vercel's proxy). */
export function clientIpFrom(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim() || null;
  return headers.get("x-real-ip");
}

// ── Public URL construction ──────────────────────────────────────────────────
// Prefer the configured app URL (so local/preview links point at the right host)
// and fall back to the production domain the spec documents.

/** The origin used to build share links, e.g. "https://hoteltrack.in". */
export function shareBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SHARE_BASE_URL ||
    "https://hoteltrack.in"
  ).replace(/\/+$/, "");
}

/**
 * The full /h/<token> dashboard URL.
 *
 * @deprecated PHASE 1 — DEAD CODE. That route is retired
 * (app/h/[shareToken]/page.tsx always 404s) and nothing renders this any more;
 * the live hotel link is `${shareBaseUrl()}/share/<ShareLink.token>`, built in
 * ShareLinkManager. Retained only so HotelShareManager.tsx /
 * hotel-share-actions.ts keep compiling until Phase 2 removes them.
 */
export function hotelShareUrl(token: string): string {
  return `${shareBaseUrl()}/h/${token}`;
}
