"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { encryptWithAudit, logTokenAudit } from "@/lib/token-audit";
import { getTokenForApiCall } from "@/lib/token-access";
import {
  GaAuthError,
  isServiceAccountJson,
  isValidGa4PropertyId,
  validateGaConnection,
  type ServiceAccountCredentials,
} from "@/lib/google-analytics";
import { syncGaConnection } from "@/lib/ga-sync";

// Tenant + role guard shared by every action in this file. requireAdmin() is the
// single source of truth for the ADMIN-only rule: connecting/managing an ad
// account is admin-only, enforced server-side here (an analyst resolves to null →
// each action returns its "not found" error). Also enforces multi-tenant scoping.
async function ownedHotel(hotelId: string) {
  const member = await requireAdmin();
  if (!member) return null;
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true },
  });
  return hotel ? { agencyId: member.agencyId, hotelId: hotel.id } : null;
}

function gaErrorMessage(err: unknown): string {
  if (err instanceof GaAuthError) return err.message;
  if (err instanceof Error) return err.message;
  return "Couldn't reach Google Analytics. Please try again.";
}

// ── Phase 1: connect — validate + save (encrypted) ────────────────────────────

export type ConnectGaState = {
  error: string | null;
  ok: boolean;
};

export async function connectGoogleAnalytics(
  _prev: ConnectGaState,
  formData: FormData,
): Promise<ConnectGaState> {
  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const propertyId = ((formData.get("propertyId") as string | null) ?? "").trim();
  const file = formData.get("credentialsFile") as File | null;
  const pastedJson = ((formData.get("credentialsJson") as string | null) ?? "").trim();

  const ctx = await ownedHotel(hotelId);
  if (!ctx) return { error: "That hotel wasn't found for your agency.", ok: false };

  if (!isValidGa4PropertyId(propertyId)) {
    return {
      error:
        "Enter the numeric GA4 property id (e.g. 123456789). Find it under GA " +
        "Admin → Property settings.",
      ok: false,
    };
  }

  // Either an uploaded file or pasted JSON is acceptable — agencies can
  // upload the downloaded .json or paste its contents directly.
  let rawJson: string;
  if (file && typeof file.size === "number" && file.size > 0) {
    if (file.size > 32 * 1024) {
      // Real service-account JSONs are ~2-3 KB. A 32KB cap guards against
      // someone uploading the wrong file by mistake.
      return { error: "Credentials file is unexpectedly large. Upload the .json from Google Cloud.", ok: false };
    }
    rawJson = await file.text();
  } else if (pastedJson) {
    rawJson = pastedJson;
  } else {
    return { error: "Upload the service-account JSON file (or paste its contents).", ok: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { error: "That file isn't valid JSON. Upload the .json key downloaded from Google Cloud.", ok: false };
  }
  if (!isServiceAccountJson(parsed)) {
    return {
      error:
        "This doesn't look like a Google Cloud service-account key. The JSON " +
        "must have type: \"service_account\" plus client_email and private_key. " +
        "Make sure you downloaded a service-account key (IAM → Service Accounts → " +
        "Keys → Add Key), not an OAuth client.",
      ok: false,
    };
  }
  const credentials = parsed as ServiceAccountCredentials;

  // Validate against the live property BEFORE saving so the agency gets
  // an immediate, actionable error if they forgot to share the property.
  try {
    await validateGaConnection(credentials, propertyId);
  } catch (err) {
    return { error: gaErrorMessage(err), ok: false };
  }

  // Encrypt the whole JSON blob with the same AES-256-GCM utility we use for
  // Meta tokens. We re-serialise from `credentials` so any junk fields the
  // user accidentally added get stripped first.
  const encryptedCredentials = await encryptWithAudit(JSON.stringify(credentials), {
    agencyId: ctx.agencyId,
    hotelClientId: ctx.hotelId,
    tokenType: "ga_credentials",
    source: "action:connectGoogleAnalytics",
  });

  await agencyScoped(prisma.googleAnalyticsConnection).upsert({
    // hotelClientId is unique per hotel and was ownership-verified above, so it
    // is a tenant-safe unique key for the upsert. agencyScoped stamps agencyId
    // onto the written rows.
    where: { hotelClientId: ctx.hotelId },
    create: {
      agencyId: ctx.agencyId,
      hotelClientId: ctx.hotelId,
      propertyId,
      encryptedCredentials,
      status: "connected",
    },
    update: {
      propertyId,
      encryptedCredentials,
      status: "connected",
    },
  });

  revalidatePath(`/agency/hotel/${ctx.hotelId}/integrations`);
  return { error: null, ok: true };
}

// ── Disconnect ────────────────────────────────────────────────────────────────

export async function disconnectGoogleAnalytics(formData: FormData): Promise<void> {
  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const ctx = await ownedHotel(hotelId);
  if (!ctx) return;
  await agencyScoped(prisma.googleAnalyticsConnection).deleteMany({
    where: { hotelClientId: ctx.hotelId },
  });
  await logTokenAudit({
    agencyId: ctx.agencyId,
    hotelClientId: ctx.hotelId,
    tokenType: "ga_credentials",
    action: "deleted",
    source: "action:disconnectGoogleAnalytics",
  });
  revalidatePath(`/agency/hotel/${ctx.hotelId}/integrations`);
}

// ── Test connection: hits the live property with the stored credentials ──────

export type GaTestState = {
  error: string | null;
  ok: boolean;
};

export async function testGaConnectionAction(
  _prev: GaTestState,
  formData: FormData,
): Promise<GaTestState> {
  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const ctx = await ownedHotel(hotelId);
  if (!ctx) return { error: "That hotel wasn't found for your agency.", ok: false };

  const conn = await agencyScoped(prisma.googleAnalyticsConnection).findFirst({
    where: { hotelClientId: ctx.hotelId },
    select: { id: true, propertyId: true },
  });
  if (!conn) return { error: "Connect Google Analytics first.", ok: false };

  let credentials: ServiceAccountCredentials;
  try {
    credentials = JSON.parse(
      (
        await getTokenForApiCall("ga_credentials", conn.id, {
          agencyId: ctx.agencyId,
          hotelClientId: ctx.hotelId,
          source: "action:testGaConnection",
        })
      ).reveal(),
    ) as ServiceAccountCredentials;
  } catch {
    return { error: "Stored credentials could not be decrypted. Please reconnect.", ok: false };
  }

  try {
    await validateGaConnection(credentials, conn.propertyId);
    return { error: null, ok: true };
  } catch (err) {
    if (err instanceof GaAuthError) {
      // Lost-access path: flip the connection to disconnected so the dashboard
      // shows the reconnect prompt automatically.
      await agencyScoped(prisma.googleAnalyticsConnection).updateMany({
        where: { hotelClientId: ctx.hotelId },
        data: { status: "disconnected" },
      });
      revalidatePath(`/agency/hotel/${ctx.hotelId}/integrations`);
    }
    return { error: gaErrorMessage(err), ok: false };
  }
}

// ── Sync now: pulls the last 30 days of metrics + source breakdown ───────────

export type GaSyncState = {
  error: string | null;
  ok: boolean;
  message: string | null;
};

export async function syncGaInsights(
  _prev: GaSyncState,
  formData: FormData,
): Promise<GaSyncState> {
  const hotelId = ((formData.get("hotelId") as string | null) ?? "").trim();
  const ctx = await ownedHotel(hotelId);
  if (!ctx) {
    return { error: "That hotel wasn't found for your agency.", ok: false, message: null };
  }

  const conn = await agencyScoped(prisma.googleAnalyticsConnection).findFirst({
    where: { hotelClientId: ctx.hotelId },
    // No ciphertext here — syncGaConnection resolves it via getTokenForApiCall.
    select: { id: true, agencyId: true, hotelClientId: true, propertyId: true },
  });
  if (!conn) {
    return { error: "Connect Google Analytics first.", ok: false, message: null };
  }

  const res = await syncGaConnection(conn);
  revalidatePath(`/agency/hotel/${ctx.hotelId}/integrations`);

  if (res.ok) {
    return {
      error: null,
      ok: true,
      message: `Synced ${res.daysSynced ?? 0} days and ${res.sourcesSynced ?? 0} source rows.`,
    };
  }
  return { error: res.error ?? "GA sync failed.", ok: false, message: null };
}
