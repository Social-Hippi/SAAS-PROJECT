"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { logTokenAudit } from "@/lib/token-audit";
import { getTokenForApiCall } from "@/lib/token-access";
import type { SecretToken } from "@/lib/encryption";
import { getProfile } from "@/lib/instagram";
import { syncInstagramConnection } from "@/lib/instagram-sync";

// Server actions for the per-hotel Instagram (IGAA) connection. CONNECTING
// happens via the OAuth flow (/api/auth/instagram/start → callback), not here —
// these actions only manage an existing connection: disconnect, test, sync.

// Tenant + role guard shared by every action in this file. requireAdmin() is the
// single source of truth for the ADMIN-only rule: managing an integration is
// admin-only, enforced server-side here (an analyst resolves to null → each
// action returns its "not found" error). Also enforces multi-tenant scoping.
async function ownedHotel(hotelId: string) {
  const member = await requireAdmin();
  if (!member) return null;
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true },
  });
  return hotel ? { agencyId: member.agencyId, hotelId: hotel.id } : null;
}

// ── Disconnect ───────────────────────────────────────────────────────────────

export async function disconnectInstagram(formData: FormData): Promise<void> {
  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const ctx = await ownedHotel(hotelId);
  if (!ctx) return;

  await agencyScoped(prisma.instagramConnection).deleteMany({
    where: { hotelClientId: ctx.hotelId },
  });
  await logTokenAudit({
    agencyId: ctx.agencyId,
    hotelClientId: ctx.hotelId,
    tokenType: "instagram",
    action: "deleted",
    source: "action:disconnectInstagram",
  });
  revalidatePath(`/agency/hotel/${ctx.hotelId}/integrations`);
}

// ── Sync now: pull insights via the shared IGAA engine ──────────────────────

export type SyncState = { error: string | null; ok: boolean; message: string | null };

export async function syncInstagramNow(
  _prev: SyncState,
  formData: FormData,
): Promise<SyncState> {
  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const ctx = await ownedHotel(hotelId);
  if (!ctx) return { error: "That hotel wasn't found for your agency.", ok: false, message: null };

  const conn = await agencyScoped(prisma.instagramConnection).findFirst({
    where: { hotelClientId: ctx.hotelId, status: "active", tokenType: "igaa_direct" },
    // No ciphertext — the engine resolves it via getTokenForApiCall.
    select: { id: true, agencyId: true, hotelClientId: true, igUserId: true },
  });
  if (!conn) {
    return { error: "Connect Instagram first (Log in with Instagram).", ok: false, message: null };
  }

  // Manual sync pulls a fuller window than the daily cron.
  const res = await syncInstagramConnection(conn, { days: 30, perRequestDelayMs: 0 });
  revalidatePath(`/agency/hotel/${ctx.hotelId}/integrations`);

  if (res.ok) {
    return {
      error: null,
      ok: true,
      message: `Synced ${(res.followers ?? 0).toLocaleString()} followers and ${res.postsSynced ?? 0} recent posts.`,
    };
  }
  return { error: res.error ?? "Sync failed.", ok: false, message: null };
}

// ── Test connection: one live graph.instagram.com call from the stored token ─

export type TestConnectionState = {
  error: string | null;
  ok: boolean;
  username: string | null;
  followersCount: number | null;
};

export async function testInstagramConnectionAction(
  _prev: TestConnectionState,
  formData: FormData,
): Promise<TestConnectionState> {
  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const ctx = await ownedHotel(hotelId);
  if (!ctx) {
    return {
      error: "That hotel wasn't found for your agency.",
      ok: false,
      username: null,
      followersCount: null,
    };
  }

  const conn = await agencyScoped(prisma.instagramConnection).findFirst({
    where: { hotelClientId: ctx.hotelId, tokenType: "igaa_direct" },
    select: { id: true },
  });
  if (!conn) {
    return {
      error: "Connect Instagram first (Log in with Instagram).",
      ok: false,
      username: null,
      followersCount: null,
    };
  }

  let token: SecretToken;
  try {
    token = await getTokenForApiCall("instagram", conn.id, {
      agencyId: ctx.agencyId,
      hotelClientId: ctx.hotelId,
      source: "action:testInstagramConnection",
    });
  } catch {
    return {
      error: "Stored token could not be decrypted. Please reconnect.",
      ok: false,
      username: null,
      followersCount: null,
    };
  }

  try {
    const profile = await getProfile(token.reveal());
    return {
      error: null,
      ok: true,
      username: profile.username,
      followersCount: profile.followersCount,
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Couldn't reach Instagram. Please try again.",
      ok: false,
      username: null,
      followersCount: null,
    };
  }
}
