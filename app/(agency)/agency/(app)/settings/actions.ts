"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentMember, requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import {
  validateAgencyContact,
  validateAgencyName,
  type ContactFormState,
} from "@/lib/agency-validation";
import { regenerateInviteCode, setInviteCodeStatus } from "@/lib/hotel-invite";
import { encryptWithAudit, logTokenAudit } from "@/lib/token-audit";
import { getTokenForApiCall } from "@/lib/token-access";
import { validateToken, revokeAppAccess } from "@/lib/meta";
import { queueBackfillJob } from "@/lib/backfill";
import { syncHotelAds } from "@/lib/meta-sync";
import { archiveOnAccountChange } from "@/lib/meta-archive";
import {
  softDeleteHotelCore,
  restoreHotelCore,
  HotelDeleteError,
  type HotelDeleteErrorCode,
} from "@/lib/hotel-delete";

// A non-expiring Meta token (e.g. a system-user token) reports expires_at = 0.
// The MetaToken.tokenExpiresAt column is non-null, so we store this far-future
// sentinel for those. The UI shows "Does not expire" for dates past ~2900.
const NEVER_EXPIRES = new Date("2999-12-31T00:00:00.000Z");

export type SaveTokenState = {
  error: string | null;
  ok: boolean;
  // Set when reconnecting revealed a data gap and a backfill job was created.
  // The progress banner polls this job; null when there was nothing to backfill.
  backfillJobId?: string | null;
};

/**
 * Validates a pasted Meta access token with Meta, then stores it encrypted
 * (AES-256-GCM) as ONE hotel's MetaToken. Tokens are hotel-scoped (one per hotel,
 * @@unique([hotelClientId])), so the existing row for this hotel is updated in
 * place, otherwise a new one is created. We never persist a token that doesn't
 * validate, so `status` is only ever set "connected" for a live token. The hotel
 * is ownership-checked against the caller's agency (multi-tenant safety).
 */
export async function saveMetaToken(
  _prev: SaveTokenState,
  formData: FormData,
): Promise<SaveTokenState> {
  const member = await requireAdmin();
  if (!member) {
    return { error: "Only an agency admin can connect integrations.", ok: false };
  }

  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  if (!hotelId) return { error: "Missing hotel.", ok: false };

  // Multi-tenant guard: never trust a client-supplied hotel id.
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true },
  });
  if (!hotel) return { error: "That hotel client wasn't found for your agency.", ok: false };

  const raw = ((formData.get("accessToken") as string | null) ?? "").trim();
  if (!raw) return { error: "Paste your Meta access token.", ok: false };

  const validation = await validateToken(raw);
  if (!validation.valid) {
    return {
      error:
        validation.error ??
        "That token didn't validate with Meta. Check it and try again.",
      ok: false,
    };
  }

  const encryptedToken = await encryptWithAudit(raw, {
    agencyId: member.agencyId,
    hotelClientId: hotel.id,
    tokenType: "meta_ads",
    source: "action:saveMetaToken",
  });
  const tokenExpiresAt = validation.expiresAt ?? NEVER_EXPIRES;

  // This is the MANUAL path: stamp the source + clear any OAuth metadata so a
  // connection that was previously OAuth (and any soft-disconnect / expiry-warning
  // state) is correctly reclassified. Manual tokens can't be auto-refreshed.
  const data = {
    encryptedToken,
    tokenExpiresAt,
    status: "connected",
    tokenSource: "MANUAL_LONG_LIVED" as const,
    oauthScopes: validation.scopes ?? [],
    refreshableViaOAuth: false,
    connectedFacebookUserId: validation.userId ?? null,
    connectedFacebookUserName: validation.userName ?? null,
    disconnectedAt: null,
    lastRefreshedAt: null,
    expiryWarningStage: null,
  };

  // Hotel-scoped (multi-tenant). hotelClientId is unique on MetaToken, so
  // find-then-update keeps exactly one connection row per hotel.
  const existing = await agencyScoped(prisma.metaToken).findFirst({
    where: { hotelClientId: hotel.id },
    select: { id: true },
  });

  if (existing) {
    await agencyScoped(prisma.metaToken).update({
      where: { id: existing.id },
      data,
    });
  } else {
    await agencyScoped(prisma.metaToken).create({
      data: { agencyId: member.agencyId, hotelClientId: hotel.id, ...data },
    });
  }

  // A first connect imports the trailing 12 months of ads history for every
  // mapped hotel; a reconnect refills the gap left while the token was dead.
  // Either way, queue a backfill job for the missing windows; the
  // BackfillProgress banner picks it up and runs it. Never blocks the save.
  let backfillJobId: string | null = null;
  try {
    backfillJobId = await queueBackfillJob(member.agencyId);
  } catch {
    // A backfill-scheduling hiccup must never fail the connect itself — the
    // next scheduled sync still keeps recent days fresh.
  }

  revalidatePath(`/agency/hotel/${hotel.id}/integrations`);
  revalidatePath(`/agency/hotel/${hotel.id}`);
  revalidatePath("/agency/settings");
  return { error: null, ok: true, backfillJobId };
}

/**
 * Soft-disconnects ONE hotel's Meta connection: status → "disconnected" with a
 * disconnectedAt stamp, keeping the row (and its OAuth metadata) so the UI can
 * show how it was connected and a reconnect can update it in place. Historical
 * AdSnapshot data is preserved (the sync just stops, since it only reads
 * status="connected"). For OAuth connections we also best-effort revoke our
 * app's access at Meta. The token at rest stays encrypted. The hotelId is taken
 * from the form and ownership-checked via the agency-scoped query.
 */
export async function disconnectMetaToken(formData: FormData): Promise<void> {
  const member = await requireAdmin();
  if (!member) return; // admin-only: disconnecting an integration

  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  if (!hotelId) return;

  const token = await agencyScoped(prisma.metaToken).findFirst({
    where: { hotelClientId: hotelId },
    select: { id: true, status: true, tokenSource: true, connectedFacebookUserId: true },
  });
  if (!token) return;

  // Best-effort revoke for OAuth connections (keeps the user's Facebook
  // "Business Integrations" list tidy). Never blocks the local disconnect.
  if (
    token.tokenSource === "OAUTH" &&
    token.connectedFacebookUserId &&
    token.status === "connected"
  ) {
    try {
      const secret = await getTokenForApiCall("meta_ads", token.id, {
        agencyId: member.agencyId,
        hotelClientId: hotelId,
        source: "action:disconnectMetaToken-revoke",
      });
      await revokeAppAccess(token.connectedFacebookUserId, secret.reveal());
    } catch (err) {
      console.warn(
        "[META-OAUTH] disconnect: revoke failed (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  await agencyScoped(prisma.metaToken).update({
    where: { id: token.id },
    data: { status: "disconnected", disconnectedAt: new Date() },
  });
  await logTokenAudit({
    agencyId: member.agencyId,
    hotelClientId: hotelId,
    tokenType: "meta_ads",
    action: "deleted",
    source: "action:disconnectMetaToken",
  });
  revalidatePath(`/agency/hotel/${hotelId}/integrations`);
  revalidatePath(`/agency/hotel/${hotelId}`);
  revalidatePath("/agency/settings");
}

export type NotificationState = { error: string | null; ok: boolean };

/**
 * Saves the agency's budget-alert notification settings (email recipient + Slack
 * webhook + the two enable toggles). The Slack webhook is also saved here; the
 * "Test connection" button additionally verifies it via /api/agency/slack/test.
 */
export async function saveNotificationSettings(
  _prev: NotificationState,
  formData: FormData,
): Promise<NotificationState> {
  const member = await requireAdmin();
  if (!member) return { error: "Only an agency admin can change notification settings.", ok: false };

  const alertEmailAddress = ((formData.get("alertEmailAddress") as string | null) ?? "").trim() || null;
  const emailAlertsEnabled = formData.get("emailAlertsEnabled") === "on";
  const slackEnabled = formData.get("slackEnabled") === "on";
  const slackWebhookUrl = ((formData.get("slackWebhookUrl") as string | null) ?? "").trim() || null;

  if (alertEmailAddress && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alertEmailAddress)) {
    return { error: "That alert email address doesn't look valid.", ok: false };
  }

  await agencyScoped(prisma.agency).update({
    where: { id: member.agencyId },
    data: { alertEmailAddress, emailAlertsEnabled, slackEnabled, slackWebhookUrl },
  });

  revalidatePath("/agency/settings");
  return { error: null, ok: true };
}

/**
 * Saves the agency's public contact info (shown to hotel owners on their
 * dashboard). Validates + normalizes all five fields; agency-scoped so it only
 * ever updates the caller's own agency.
 */
export async function saveAgencyContact(
  _prev: ContactFormState,
  formData: FormData,
): Promise<ContactFormState> {
  const member = await requireAdmin();
  if (!member) {
    return { ok: false, formError: "Only an agency admin can edit agency contact info." };
  }

  const result = validateAgencyContact({
    mobile: String(formData.get("mobile") ?? ""),
    contactEmail: String(formData.get("contactEmail") ?? ""),
    whatsappNumber: String(formData.get("whatsappNumber") ?? ""),
    address: String(formData.get("address") ?? ""),
    websiteUrl: String(formData.get("websiteUrl") ?? ""),
  });
  if (!result.ok) return { ok: false, errors: result.errors };

  await agencyScoped(prisma.agency).update({
    where: { id: member.agencyId },
    data: result.data,
  });

  revalidatePath("/agency/settings");
  return { ok: true };
}

export type AgencyNameState = { ok: boolean; error?: string; name?: string };

/**
 * Renames the agency — the ORGANISATION identity every member sees in the app
 * header, on generated reports, and in emails to hotels.
 *
 * This action did not exist. `Agency.name` was written once by
 * createAgencyForCurrentUser and by nothing else, so an agency was named
 * permanently at signup — and the onboarding form pre-filled that field with
 * `${user.firstName}'s Agency`, which left whole organisations identified by
 * whichever individual signed up first, with no way to correct it in the
 * product. (scripts/cleanup-demo-data.ts exists partly to delete two agencies
 * that were created exactly that way.)
 *
 * Admin-only and agency-scoped: the update goes through agencyScoped, so the
 * `where` can only ever resolve to the caller's own agency. Because the name is
 * organisation-level state, the rename is immediately visible to EVERY member —
 * the header reads it from member.agency.name on each request, and the paths
 * that display it are revalidated below.
 */
export async function saveAgencyName(
  _prev: AgencyNameState,
  formData: FormData,
): Promise<AgencyNameState> {
  const member = await requireAdmin();
  if (!member) {
    return { ok: false, error: "Only an agency admin can rename the organisation." };
  }

  const result = validateAgencyName(String(formData.get("agencyName") ?? ""));
  if (!result.ok) return { ok: false, error: result.error };

  await agencyScoped(prisma.agency).update({
    where: { id: member.agencyId },
    data: { name: result.name },
  });

  // The name appears in the app header (every page under the agency layout),
  // the hotel list, and the dashboard, so refresh all three for other members.
  revalidatePath("/agency/settings");
  revalidatePath("/agency/dashboard");
  revalidatePath("/agency/hotels");
  return { ok: true, name: result.name };
}

/** Regenerate this agency's hotel-signup invite code (old code stops working). */
export async function regenerateAgencyInviteCode(): Promise<{ ok: boolean; code?: string; error?: string }> {
  const member = await requireAdmin();
  if (!member) return { ok: false, error: "Only an agency admin can manage the invite code." };
  const code = await regenerateInviteCode(member.agencyId);
  revalidatePath("/agency/settings");
  return { ok: true, code };
}

/** Enable/disable hotel self-signup for this agency. */
export async function setAgencyInviteStatus(
  status: "ACTIVE" | "DISABLED",
): Promise<{ ok: boolean; status?: string; error?: string }> {
  const member = await requireAdmin();
  if (!member) return { ok: false, error: "Only an agency admin can manage the invite code." };
  await setInviteCodeStatus(member.agencyId, status);
  revalidatePath("/agency/settings");
  return { ok: true, status };
}

export type MapAccountState = { error: string | null; ok: boolean };

/**
 * Maps a Meta ad account to one of this agency's hotel clients (or clears the
 * mapping when adAccountId is empty). Verifies the hotel belongs to the agency.
 */
export async function mapAdAccount(
  _prev: MapAccountState,
  formData: FormData,
): Promise<MapAccountState> {
  const member = await requireAdmin();
  if (!member) {
    return { error: "Only an agency admin can map ad accounts.", ok: false };
  }

  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const adAccountId = ((formData.get("adAccountId") as string | null) ?? "").trim();
  if (!hotelId) return { error: "Missing hotel.", ok: false };

  // Multi-tenant guard: never trust a client-supplied hotel id.
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true, metaAdAccountId: true, previousAdAccountIds: true },
  });
  if (!hotel) return { error: "That hotel client wasn't found for your agency.", ok: false };

  const newId = adAccountId || null;
  const oldId = hotel.metaAdAccountId;
  const accountChanged = newId !== oldId;
  // A switch between two DIFFERENT real accounts (not first-time mapping, not
  // unmapping, not a same-account re-save) triggers archiving of the old data.
  const switchedAccounts = accountChanged && !!oldId && !!newId;

  let previousAdAccountIds = hotel.previousAdAccountIds;
  if (switchedAccounts) {
    // Archive the old account's rows + restore any prior data for the new one.
    // Best-effort: a hiccup here must not block re-mapping the account.
    try {
      await archiveOnAccountChange({
        agencyId: member.agencyId,
        hotelClientId: hotel.id,
        oldAccountId: oldId!,
        newAccountId: newId!,
      });
    } catch (err) {
      console.error("[META-RECONNECT] archive failed for hotel", hotel.id, err);
    }
    // Record the old account in history (dedup); drop the new one if it was a
    // previous account being reconnected (its data is live again now).
    previousAdAccountIds = [...new Set([...previousAdAccountIds, oldId!])].filter(
      (id) => id !== newId,
    );
  }

  await agencyScoped(prisma.hotelClient).update({
    where: { id: hotel.id },
    data: {
      metaAdAccountId: newId,
      previousAdAccountIds,
      // Stamp the connection time only when the mapped account actually changes
      // to a real account — a same-account re-save must not reset the
      // "sync in progress" fresh-start window.
      ...(newId && accountChanged ? { metaAccountConnectedAt: new Date() } : {}),
    },
  });

  // Mapping an ad account is what makes a hotel syncable. Two-step so its
  // dashboard fills in immediately AND completely:
  //   1. A bounded inline sync of the last 30 days (account + campaign-level +
  //      attribution) so the default dashboard view shows data the moment the
  //      mapping returns — this is what makes selecting the account feel
  //      "automatic". 30 days stays within Meta's campaign-insights window cap.
  //   2. Queue the full 12-month history import (now campaign-aware too) for the
  //      longer date ranges. Both are best-effort and never block the mapping.
  if (adAccountId) {
    try {
      await syncHotelAds(hotel.id, 30);
    } catch {
      // The history backfill + scheduled sync still cover the data if this hiccups.
    }
    try {
      await queueBackfillJob(member.agencyId);
    } catch {
      // The scheduled sync still covers recent days if scheduling hiccups.
    }
  }

  // The mapping is set per hotel on its Integrations page; also refresh the
  // hotel dashboard (where the campaign sections live) and Settings.
  revalidatePath(`/agency/hotel/${hotel.id}/integrations`);
  revalidatePath(`/agency/hotel/${hotel.id}`);
  revalidatePath("/agency/settings");
  return { error: null, ok: true };
}

// ── Hotel soft delete / restore (admin only) ─────────────────────────────────

export type DeleteHotelState = {
  // null = no error yet; "SESSION" = signed out; otherwise a HotelDeleteErrorCode.
  error: HotelDeleteErrorCode | "SESSION" | null;
  ok: boolean;
};

/**
 * Soft-deletes a hotel (admin-only; enforced in softDeleteHotelCore). Used by the
 * Danger Zone modal via useActionState — returns a typed error on failure, and on
 * success redirects to the agency dashboard with a ?deleted=<name> flag the
 * dashboard turns into a confirmation banner. Data + tokens are preserved.
 */
export async function softDeleteHotel(
  _prev: DeleteHotelState,
  formData: FormData,
): Promise<DeleteHotelState> {
  const member = await getCurrentMember();
  if (!member) return { error: "SESSION", ok: false };

  const hotelClientId = String(formData.get("hotelClientId") ?? "");
  const confirmationName = String(formData.get("confirmationName") ?? "");
  const reason = ((formData.get("reason") as string | null) ?? "").trim() || null;

  let name: string;
  try {
    const res = await softDeleteHotelCore(
      { agencyId: member.agencyId, memberId: member.id, role: member.role },
      { hotelClientId, confirmationName, reason },
    );
    name = res.name;
  } catch (err) {
    if (err instanceof HotelDeleteError) return { error: err.code, ok: false };
    throw err;
  }

  revalidatePath("/agency/dashboard");
  revalidatePath("/agency/hotels");
  revalidatePath("/agency/hotel/" + hotelClientId);
  // Throws NEXT_REDIRECT — must stay outside the try/catch above.
  redirect(`/agency/dashboard?deleted=${encodeURIComponent(name)}`);
}

/**
 * Restores a soft-deleted hotel (admin only). No self-service UI yet — called by
 * scripts/restore-hotel.ts (and a future admin restore page). Idempotent.
 */
export async function restoreHotel(
  hotelClientId: string,
): Promise<{ ok: boolean; error?: HotelDeleteErrorCode | "SESSION" }> {
  const member = await getCurrentMember();
  if (!member) return { ok: false, error: "SESSION" };

  try {
    await restoreHotelCore(
      { agencyId: member.agencyId, memberId: member.id, role: member.role },
      hotelClientId,
    );
  } catch (err) {
    if (err instanceof HotelDeleteError) return { ok: false, error: err.code };
    throw err;
  }

  revalidatePath("/agency/dashboard");
  revalidatePath("/agency/hotels");
  return { ok: true };
}
