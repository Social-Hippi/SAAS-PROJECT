-- Campaign taxonomy for the client dashboard's paid-performance tables.
--
-- Both columns are NULLABLE and backfill-free by design: rows synced before this
-- migration have no objective to recover without re-fetching history from the
-- platform APIs, and a default like 'OTHER' would be a guess presented as a
-- fact. Those rows read "Not available" until a sync refreshes them.
ALTER TABLE "AdCampaignSnapshot" ADD COLUMN "objective" TEXT;
ALTER TABLE "GoogleAdsCampaignSnapshot" ADD COLUMN "advertisingChannelType" TEXT;
