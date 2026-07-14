"use server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { rateLimit, clientIpFromHeaders } from "@/lib/ratelimit";
import { agencyScopedFor } from "@/lib/tenant";
import { sendEmail } from "@/lib/email";
import { newHotelJoinedEmail, hotelWelcomeEmail } from "@/lib/hotel-invite";
import { validateUrl, validateEmail, validateMobile, validateWhatsapp, validateAddress } from "@/lib/agency-validation";

// Completes a hotel self-signup. Two paths:
//  • Visitor not signed in → we create their Clerk account (Backend SDK) with the
//    hotel_client role + the supplied password, provision the hotel, and tell the
//    client to send them to Clerk's hosted sign-in (returning to their dashboard).
//  • Visitor already signed in (came back via the sign-in link) → we link the
//    existing Clerk user to the new hotel and they go straight to the dashboard.
//
// We deliberately use the stable Backend SDK rather than the experimental
// signal-based client signup hooks in this Clerk version.

const CHANNEL_MANAGERS = new Set(["None", "djubo", "eZee", "STAAH", "RateGain", "Other", "Custom"]);

export type HotelSignupInput = {
  inviteCode: string;
  hotelName: string;
  websiteUrl: string;
  contactName: string;
  ownerEmail: string;
  password: string;
  ownerPhone: string;
  address: string;
  whatsappNumber: string;
  roomCount: string;
  channelManager: string;
  otaCommissionRate: string;
};

export type HotelSignupResult =
  | { ok: true; hotelClientId: string; needsSignIn: boolean }
  | { ok: false; error: string; fieldErrors?: Record<string, string>; existingEmail?: boolean };

// ACCESS LOCKDOWN: hotel self-signup is permanently disabled. Hotels no longer
// get logins — they see their outcomes via a read-only share link. Kept as a flag
// function (not a `const true`) so the original flow below stays reachable to the
// compiler and can be restored by flipping this to `false` if the decision changes.
function hotelSelfSignupDisabled(): boolean {
  return true;
}

export async function completeHotelSignup(input: HotelSignupInput): Promise<HotelSignupResult> {
  // Hard-refuse BEFORE any Clerk account or HotelClient is created, so no
  // non-staff account can ever be provisioned through this action even if it is
  // invoked directly (the /join page also shows a "closed" message).
  if (hotelSelfSignupDisabled()) {
    return {
      ok: false,
      error: "Hotel self-signup is no longer available. Please contact your agency for access to your dashboard.",
    };
  }

  // Throttle signups per IP (invite-code probing + account-creation spam). Fails
  // CLOSED so a store outage can't open the floodgates.
  const rl = await rateLimit("joinSignup", clientIpFromHeaders(await headers()));
  if (!rl.ok) {
    return { ok: false, error: "Too many attempts. Please wait a minute and try again." };
  }

  const { userId: sessionUserId } = await auth();

  // Resolve the inviting agency; reject a disabled/regenerated/suspended code.
  const agency = await prisma.agency.findUnique({
    where: { inviteCode: input.inviteCode },
    select: { id: true, name: true, email: true, inviteCodeStatus: true, mobile: true, contactEmail: true, suspendedAt: true },
  });
  if (!agency || agency.inviteCodeStatus === "DISABLED" || agency.suspendedAt) {
    return { ok: false, error: "This invite link has expired or been disabled. Ask your agency for a new link." };
  }

  // An existing agency member must not convert their account into a hotel.
  if (sessionUserId) {
    const member = await prisma.agencyMember.findUnique({ where: { clerkId: sessionUserId }, select: { id: true } });
    if (member) {
      return { ok: false, error: "This account is already an agency account. Use a different email to sign up as a hotel." };
    }
    const existingHotel = await prisma.hotelClient.findFirst({ where: { createdByUserId: sessionUserId }, select: { id: true } });
    if (existingHotel) return { ok: true, hotelClientId: existingHotel.id, needsSignIn: false };
  }

  // ── Validate ──
  const fieldErrors: Record<string, string> = {};
  const hotelName = input.hotelName.trim();
  if (hotelName.length < 2) fieldErrors.hotelName = "Enter your hotel name.";
  const contactName = input.contactName.trim();
  if (contactName.length < 2) fieldErrors.contactName = "Enter the owner/contact name.";
  const websiteUrl = validateUrl(input.websiteUrl);
  if (!websiteUrl) fieldErrors.websiteUrl = "Enter a valid website URL.";
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  if (!validateEmail(ownerEmail)) fieldErrors.ownerEmail = "Enter a valid email.";
  if (!sessionUserId && input.password.length < 8) fieldErrors.password = "Use at least 8 characters.";
  const ownerPhone = validateMobile(input.ownerPhone);
  if (!ownerPhone) fieldErrors.ownerPhone = "Enter a valid 10-digit mobile number.";
  const whatsappNumber = validateWhatsapp(input.whatsappNumber);
  if (!whatsappNumber) fieldErrors.whatsappNumber = "Enter a valid WhatsApp number.";
  const address = input.address.trim();
  if (!validateAddress(address)) fieldErrors.address = "Enter an address (10–500 characters).";
  let roomCount: number | null = null;
  if (input.roomCount.trim()) {
    const n = Number.parseInt(input.roomCount, 10);
    if (!Number.isFinite(n) || n < 0 || n > 100000) fieldErrors.roomCount = "Enter a valid number of rooms.";
    else roomCount = n;
  }
  const channelManager = CHANNEL_MANAGERS.has(input.channelManager) ? input.channelManager : "None";
  let otaRate = Number.parseFloat(input.otaCommissionRate);
  if (!Number.isFinite(otaRate)) otaRate = 18;
  otaRate = Math.min(50, Math.max(0, otaRate));
  if (Object.keys(fieldErrors).length > 0) return { ok: false, error: "Please fix the highlighted fields.", fieldErrors };

  // ── Resolve the target Clerk user (existing session, or create one) ──
  const client = await clerkClient();
  let targetUserId = sessionUserId;
  let needsSignIn = false;
  if (!targetUserId) {
    const existing = await client.users.getUserList({ emailAddress: [ownerEmail] });
    if (existing.totalCount > 0) {
      return { ok: false, error: "An account with this email already exists.", existingEmail: true };
    }
    try {
      const created = await client.users.createUser({
        emailAddress: [ownerEmail],
        password: input.password,
        publicMetadata: { role: "hotel_client" },
      });
      targetUserId = created.id;
      needsSignIn = true; // a server-created user has no session — they sign in next.
    } catch (err) {
      const msg = (err as { errors?: { message?: string }[] }).errors?.[0]?.message ?? "Couldn't create your account.";
      return { ok: false, error: msg };
    }
  } else {
    // Linking an existing signed-in user → make sure they carry the hotel role.
    try {
      await client.users.updateUserMetadata(sessionUserId!, { publicMetadata: { role: "hotel_client" } });
    } catch (err) {
      console.error("[HOTEL-SIGNUP] role set failed for", sessionUserId, err);
    }
  }

  // ── Create the hotel (scoped to the inviting agency) ──
  const hotel = await agencyScopedFor(agency.id, prisma.hotelClient).create({
    data: {
      agencyId: agency.id,
      name: hotelName, websiteUrl: websiteUrl!, contactName, contactEmail: ownerEmail,
      contactPhone: ownerPhone, address, whatsappNumber, roomCount, channelManager,
      otaCommissionRate: otaRate.toFixed(2), createdByUserId: targetUserId!,
      conversionMethod: "both", // sensible default; agency refines detection later
    },
    select: { id: true, siteId: true },
  });

  await agencyScopedFor(agency.id, prisma.hotelInvite).create({
    data: {
      agencyId: agency.id, inviteCode: input.inviteCode, hotelClientId: hotel.id,
      hotelEmail: ownerEmail, status: "COMPLETED", completedAt: new Date(),
    },
  });

  // Notify both sides (best-effort).
  const agencyMail = newHotelJoinedEmail({ agencyName: agency.name, hotelName, hotelEmail: ownerEmail, hotelClientId: hotel.id });
  const hotelMail = hotelWelcomeEmail({
    agencyName: agency.name, hotelName, hotelClientId: hotel.id, siteId: hotel.siteId,
    agencyContact: { email: agency.contactEmail ?? agency.email, mobile: agency.mobile },
  });
  await Promise.allSettled([
    sendEmail({ to: agency.email, subject: agencyMail.subject, html: agencyMail.html }),
    sendEmail({ to: ownerEmail, subject: hotelMail.subject, html: hotelMail.html }),
  ]);

  return { ok: true, hotelClientId: hotel.id, needsSignIn };
}
