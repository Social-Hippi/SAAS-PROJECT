import "server-only";

import { prisma } from "@/lib/prisma";
import { getTokenForApiCall } from "@/lib/token-access";
import type { SecretToken } from "@/lib/encryption";
import {
  getCampaignObjectives,
  getDailyCampaignInsights,
  getDailyInsights,
  MetaAuthError,
} from "@/lib/meta";
import { recordSyncFailure } from "@/lib/sync-failures";
import { refreshCampaignPerformance } from "@/lib/campaign-attribution";

// Per-hotel Meta Ads sync — the single-hotel counterpart of the scheduled
// /api/meta/sync cron (same trailing-window upsert; same dead-token handling).
// Used by the super-admin "Sync now" page for demos/testing before the daily
// cron has run.
//
// SECURITY: the token is resolved only via getTokenForApiCall and never logged.

const DAY_MS = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export type HotelSyncResult = {
  ok: boolean;
  hotelName?: string;
  snapshotsWritten?: number;
  range?: { since: string; until: string };
  error?: string;
};

/**
 * Pulls the trailing `days` (1–90, default 7) of daily insights for one hotel
 * and upserts its AdSnapshots. Caller must be authorized for cross-tenant
 * access (super admin) — the hotel's own agencyId scopes every query below,
 * exactly like the cron does per agency.
 */
export async function syncHotelAds(
  hotelClientId: string,
  days = 7,
): Promise<HotelSyncResult> {
  const clamped = Math.min(Math.max(Math.trunc(days), 1), 90);

  const hotel = await prisma.hotelClient.findUnique({
    where: { id: hotelClientId },
    select: { id: true, name: true, agencyId: true, metaAdAccountId: true, deletedAt: true },
  });
  if (!hotel) return { ok: false, error: "Hotel not found." };
  // Soft-deleted hotels never sync (data is preserved, just paused).
  if (hotel.deletedAt) {
    return { ok: false, hotelName: hotel.name, error: "This hotel has been deleted." };
  }
  if (!hotel.metaAdAccountId) {
    return {
      ok: false,
      hotelName: hotel.name,
      error: "This hotel has no Meta ad account mapped — map one on its Integrations page first.",
    };
  }

  // Hotel-scoped token: each hotel owns its own Meta connection.
  const token = await prisma.metaToken.findFirst({
    where: { hotelClientId: hotel.id, agencyId: hotel.agencyId, status: "connected" },
    select: { id: true },
  });
  if (!token) {
    return {
      ok: false,
      hotelName: hotel.name,
      error: "This hotel has no connected Meta token.",
    };
  }

  let secret: SecretToken;
  try {
    secret = await getTokenForApiCall("meta_ads", token.id, {
      agencyId: hotel.agencyId,
      hotelClientId: hotel.id,
      source: "admin:sync-now",
    });
  } catch {
    return { ok: false, hotelName: hotel.name, error: "Could not decrypt the Meta token." };
  }

  const now = new Date();
  const range = {
    since: ymd(new Date(now.getTime() - (clamped - 1) * DAY_MS)),
    until: ymd(now),
  };

  try {
    const rows = await getDailyInsights(secret.reveal(), hotel.metaAdAccountId, range);

    let written = 0;
    for (const row of rows) {
      if (!row.date) continue;
      const date = new Date(`${row.date}T00:00:00.000Z`);
      const data = {
        metaAccountId: hotel.metaAdAccountId,
        spend: row.spend.toFixed(2),
        impressions: row.impressions,
        reach: row.reach,
        clicks: row.clicks,
        ctr: row.ctr,
        cpc: row.cpc.toFixed(4),
        cpm: row.cpm.toFixed(4),
        conversions: row.conversions,
        roas: row.roas,
        pixelPurchases: row.pixelPurchases,
        pixelLeads: row.pixelLeads,
        pixelPageViews: row.pixelPageViews,
      };
      await prisma.adSnapshot.upsert({
        where: {
          hotelClientId_metaAccountId_date: {
            hotelClientId: hotel.id,
            metaAccountId: hotel.metaAdAccountId,
            date,
          },
        },
        create: { agencyId: hotel.agencyId, hotelClientId: hotel.id, date, ...data },
        update: data,
      });
      written += 1;
    }

    // Campaign-level rows + the materialized attribution refresh, same window.
    let campaignsWritten = 0;
    const campaignRows = await getDailyCampaignInsights(
      secret.reveal(),
      hotel.metaAdAccountId,
      range,
    );

    // Objectives come from the CAMPAIGNS endpoint, not from insights: insights
    // returns objective as null for these accounts (verified in production —
    // even today's rows), because the objective belongs to the campaign rather
    // than to a day of delivery.
    //
    // Best-effort: without it every TYPE reads "Not available", which is what it
    // already read. It must not cost the day's spend and delivery figures.
    let objectives = new Map<string, string>();
    try {
      objectives = await getCampaignObjectives(secret.reveal(), hotel.metaAdAccountId);
    } catch (err) {
      console.warn(
        `[meta-sync] campaign objectives skipped for ${hotel.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
    for (const row of campaignRows) {
      const date = new Date(`${row.date}T00:00:00.000Z`);
      const data = {
        metaAccountId: hotel.metaAdAccountId,
        campaignName: row.campaignName,
        // Insights first (it is the row's own answer), then the campaign's.
        objective: row.objective ?? objectives.get(row.campaignId) ?? null,
        spend: row.spend.toFixed(2),
        impressions: row.impressions,
        clicks: row.clicks,
        conversions: row.conversions,
        purchaseValue: row.purchaseValue.toFixed(2),
        reach: row.reach,
        messagingStarted: row.messagingStarted,
        calls: row.calls,
        leads: row.leads,
        qualityRanking: row.qualityRanking,
        engagementRateRanking: row.engagementRateRanking,
        conversionRateRanking: row.conversionRateRanking,
      };
      await prisma.adCampaignSnapshot.upsert({
        where: {
          hotelClientId_metaCampaignId_date: {
            hotelClientId: hotel.id,
            metaCampaignId: row.campaignId,
            date,
          },
        },
        create: {
          agencyId: hotel.agencyId,
          hotelClientId: hotel.id,
          metaCampaignId: row.campaignId,
          date,
          ...data,
        },
        update: data,
      });
      campaignsWritten += 1;
    }
    await refreshCampaignPerformance(
      hotel.agencyId,
      hotel.id,
      new Date(`${range.since}T00:00:00.000Z`),
      now,
    );

    await prisma.hotelClient.update({
      where: { id: hotel.id },
      data: { lastSyncedAt: new Date() },
    });

    return {
      ok: true,
      hotelName: hotel.name,
      snapshotsWritten: written + campaignsWritten,
      range,
    };
  } catch (err) {
    if (err instanceof MetaAuthError) {
      // Same bookkeeping as the cron: mark the token dead and record the
      // failure so the integrations page shows the reconnect prompt.
      await prisma.metaToken.update({
        where: { id: token.id },
        data: { status: "expired" },
      });
      await recordSyncFailure(
        hotel.agencyId,
        hotel.id,
        "meta_ads",
        err.message || "Meta token expired/revoked during sync.",
      );
      return {
        ok: false,
        hotelName: hotel.name,
        error: "Meta token expired/revoked — it has been marked expired; reconnect in Settings.",
      };
    }
    return {
      ok: false,
      hotelName: hotel.name,
      error: err instanceof Error ? err.message : "Unknown sync error.",
    };
  }
}
