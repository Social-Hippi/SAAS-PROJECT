import type { DailyCampaignRow } from "@/lib/meta";

// ─────────────────────────────────────────────────────────────────────────────
// ONE mapping from a Meta campaign insight to an AdCampaignSnapshot row.
//
// WHY THIS FILE EXISTS. The same upsert was written out by hand in three places
// — the daily cron route, lib/meta-sync.ts and lib/backfill.ts — and they
// disagreed about WHICH COLUMNS TO WRITE. meta-sync.ts set all fifteen; the cron
// route and the backfill set seven, silently dropping objective, reach,
// messagingStarted, leads, calls and the three delivery rankings.
//
// Nothing failed. Prisma's `update` only touches the fields it is given, so rows
// written earlier by the full mapper kept their values while every row the cron
// CREATED was born with those six columns null. On Aster Holidays that showed up
// as messaging conversations populated up to 2026-09-10 — the last day someone
// pressed "Sync now", which routes through meta-sync.ts — and null every day
// after, while spend, impressions and clicks kept arriving perfectly. The report
// read the gap as "Meta has not reported this" when Meta had reported it and we
// had thrown it away on write.
//
// A duplicated write that is merely out of date looks identical to one that is
// correct, which is why this is a function and not a comment asking three call
// sites to remember.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every column an AdCampaignSnapshot carries, except the identity a caller
 * supplies itself (agencyId / hotelClientId / metaCampaignId / date).
 *
 * `objectives` is the campaign-level lookup from getCampaignObjectives. Insights
 * returns `objective` as null for these accounts, so the map is the real answer
 * — but it is optional, because a caller that could not fetch it should still
 * write the other fourteen columns rather than skip the row.
 */
export function campaignSnapshotData(
  row: DailyCampaignRow,
  metaAccountId: string,
  objectives?: Map<string, string>,
) {
  return {
    metaAccountId,
    campaignName: row.campaignName,
    // Insights first (it is the row's own answer), then the campaign's.
    objective: row.objective ?? objectives?.get(row.campaignId) ?? null,
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
}
