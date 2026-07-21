import "server-only";

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { renderEmail, p, lead, esc } from "@/lib/email";

// Hotel self-signup invite codes (see /join/[inviteCode]). One code per agency,
// unique platform-wide, format SLUG-XXXXXXXX. These helpers take an explicit
// agencyId (the caller — a server action — has already resolved + ownership-
// checked it via getCurrentMember), so they operate only on that one agency.

// Base for the dashboard link AND the tracking snippet in the hotel welcome
// email. The localhost fallback is dev-only: validatePlatformEnv() refuses to
// boot a production server without NEXT_PUBLIC_APP_URL, so a real hotel can
// never receive a localhost snippet.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

// Unambiguous charset — no 0/O/1/I/L — so a code is easy to read aloud / retype.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const RANDOM_LEN = 8; // ≥8 random chars after the slug (entropy ≈ 40 bits) — Part 6.

/** Agency name → short uppercase slug, e.g. "Social Hippi!" → "SOCIAL-HIPPI". */
export function slugifyAgencyName(name: string): string {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/g, "");
  return slug || "AGENCY";
}

function randomSuffix(): string {
  const bytes = randomBytes(RANDOM_LEN);
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** Generate a platform-unique invite code for an agency name (retries on clash). */
export async function generateUniqueInviteCode(agencyName: string): Promise<string> {
  const slug = slugifyAgencyName(agencyName);
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = `${slug}-${randomSuffix()}`;
    const existing = await prisma.agency.findUnique({ where: { inviteCode: code }, select: { id: true } });
    if (!existing) return code;
  }
  // Astronomically unlikely; fall back to a pure-random code.
  return `${slug}-${randomSuffix()}${randomSuffix()}`;
}

/** Full public invite URL for a code. */
export function inviteUrl(code: string): string {
  return `${APP_URL}/join/${code}`;
}

/**
 * Return the agency's invite code, generating + persisting one if it has none
 * yet (existing agencies created before this feature). Idempotent.
 */
export async function ensureInviteCode(agencyId: string): Promise<{ code: string; status: string }> {
  const agency = await prisma.agency.findUnique({
    where: { id: agencyId },
    select: { name: true, inviteCode: true, inviteCodeStatus: true },
  });
  if (!agency) throw new Error("Agency not found");
  if (agency.inviteCode) return { code: agency.inviteCode, status: agency.inviteCodeStatus ?? "ACTIVE" };

  const code = await generateUniqueInviteCode(agency.name);
  await prisma.agency.update({
    where: { id: agencyId },
    data: { inviteCode: code, inviteCodeGeneratedAt: new Date(), inviteCodeStatus: "ACTIVE" },
  });
  return { code, status: "ACTIVE" };
}

/** Regenerate the agency's invite code (the old one stops working). */
export async function regenerateInviteCode(agencyId: string): Promise<string> {
  const agency = await prisma.agency.findUnique({ where: { id: agencyId }, select: { name: true } });
  if (!agency) throw new Error("Agency not found");
  const code = await generateUniqueInviteCode(agency.name);
  await prisma.agency.update({
    where: { id: agencyId },
    data: { inviteCode: code, inviteCodeGeneratedAt: new Date(), inviteCodeStatus: "ACTIVE" },
  });
  return code;
}

/** Enable/disable self-signup without discarding the code. */
export async function setInviteCodeStatus(agencyId: string, status: "ACTIVE" | "DISABLED"): Promise<void> {
  await prisma.agency.update({ where: { id: agencyId }, data: { inviteCodeStatus: status } });
}

// ── Emails ───────────────────────────────────────────────────────────────────

/** Email to the AGENCY admin when a hotel self-signs-up. */
export function newHotelJoinedEmail(opts: {
  agencyName: string;
  hotelName: string;
  hotelEmail: string;
  hotelClientId: string;
}): { subject: string; html: string } {
  const integrationsUrl = `${APP_URL}/agency/hotel/${opts.hotelClientId}/integrations`;
  return {
    subject: `New hotel joined: ${opts.hotelName}`,
    html: renderEmail({
      heading: "A hotel joined your agency",
      preheader: `${opts.hotelName} just signed up via your invite link.`,
      bodyHtml:
        lead(`<strong>${esc(opts.hotelName)}</strong> just signed up via your HotelTrack invite link.`) +
        p(`Contact email: ${esc(opts.hotelEmail)}`) +
        p(`They can already see their dashboard. To start tracking, connect their Meta / Instagram / GA4 integrations and confirm the tracking snippet is installed.`),
      cta: { label: "Configure their integrations", url: integrationsUrl },
    }),
  };
}

/** Welcome email to the HOTEL after signup (login + snippet install). */
export function hotelWelcomeEmail(opts: {
  agencyName: string;
  hotelName: string;
  hotelClientId: string;
  siteId: string;
  agencyContact?: { email?: string | null; mobile?: string | null } | null;
}): { subject: string; html: string } {
  const dashboardUrl = `${APP_URL}/hotel/${opts.hotelClientId}/dashboard`;
  // Must match the snippet shown in the agency UI: public/t.js locates its own
  // <script> tag by looking for "id=" in the src and reads the siteId from that
  // query param — a data-* attribute is never read, so the tag must carry ?id=.
  const snippet = `&lt;script src="${esc(APP_URL)}/t.js?id=${esc(opts.siteId)}" async&gt;&lt;/script&gt;`;
  const contactLine =
    opts.agencyContact && (opts.agencyContact.email || opts.agencyContact.mobile)
      ? p(
          `Need help? Reach ${esc(opts.agencyName)}${opts.agencyContact.email ? ` at ${esc(opts.agencyContact.email)}` : ""}${opts.agencyContact.mobile ? ` / ${esc(opts.agencyContact.mobile)}` : ""}.`,
        )
      : "";
  return {
    subject: `Welcome to HotelTrack, ${opts.hotelName}`,
    html: renderEmail({
      heading: "Your hotel dashboard is ready",
      preheader: `${opts.hotelName} is now set up on HotelTrack with ${opts.agencyName}.`,
      bodyHtml:
        lead(`Welcome, <strong>${esc(opts.hotelName)}</strong> 🎉`) +
        p(`Your hotel is now connected to ${esc(opts.agencyName)} on HotelTrack. Log in any time to see your bookings, channel performance and savings.`) +
        p(`<strong>Install your tracking snippet</strong> — paste this just before <code>&lt;/head&gt;</code> on your website so we can attribute bookings:`) +
        `<pre style="margin:0 0 14px;padding:12px;background:#f4f4f5;border-radius:8px;font-size:12px;overflow:auto;color:#18181b;">${snippet}</pre>` +
        contactLine,
      cta: { label: "Open my dashboard", url: dashboardUrl },
    }),
  };
}
