-- GA4 read-expansion: broaden the fields pulled from the GA4 Data API
-- (analyticsdata.googleapis.com runReport) into more themed reports.
-- All additive: new scalar day-metrics are NOT NULL with defaults, new
-- ecommerce metrics + all breakdown JSON lists are nullable, so existing
-- Ga4Snapshot rows and in-flight syncs are unaffected. No new tables, no
-- change to Ga4Connection, auth, scope, or tenant scoping (rows already
-- carry agencyId + hotelClientId).

-- Engagement (R1 — day-level scalars).
ALTER TABLE "Ga4Snapshot" ADD COLUMN "engagedSessions" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "engagementRate" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "userEngagementDuration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "screenPageViewsPerSession" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "keyEvents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "returningUsers" INTEGER NOT NULL DEFAULT 0;

-- Ecommerce (R5 — nullable: only ecommerce-enabled properties return these).
ALTER TABLE "Ga4Snapshot" ADD COLUMN "purchaseRevenue" INTEGER;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "transactions" INTEGER;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "purchaserRate" DOUBLE PRECISION;

-- Breakdown top-N lists (R2/R3/R4/R6/R7/R8/R9), nullable JSONB.
ALTER TABLE "Ga4Snapshot" ADD COLUMN "topSources" JSONB;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "topCampaigns" JSONB;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "firstUserChannels" JSONB;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "topEvents" JSONB;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "topPages" JSONB;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "landingBySource" JSONB;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "newVsReturning" JSONB;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "topRegions" JSONB;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "topBrowsers" JSONB;
ALTER TABLE "Ga4Snapshot" ADD COLUMN "topOperatingSystems" JSONB;
