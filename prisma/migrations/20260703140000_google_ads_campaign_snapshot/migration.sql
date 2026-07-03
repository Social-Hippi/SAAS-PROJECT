-- ─────────────────────────────────────────────────────────────────────────────
-- Google Ads STEP 2: daily per-campaign metrics (mirrors AdCampaignSnapshot).
-- Account-level KPIs + trend are derived by summing these rows. Multi-tenant
-- (agencyId + tenant_isolation RLS). Money is Ads-reported (cost_micros/1e6).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "GoogleAdsCampaignSnapshot" (
    "id"               TEXT NOT NULL,
    "agencyId"         TEXT NOT NULL,
    "hotelClientId"    TEXT NOT NULL,
    "customerId"       TEXT NOT NULL,
    "campaignId"       TEXT NOT NULL,
    "campaignName"     TEXT NOT NULL,
    "status"           TEXT NOT NULL,
    "date"             DATE NOT NULL,
    "spend"            DECIMAL(12,2) NOT NULL,
    "impressions"      INTEGER NOT NULL,
    "clicks"           INTEGER NOT NULL,
    "conversions"      DOUBLE PRECISION NOT NULL,
    "conversionsValue" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "GoogleAdsCampaignSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoogleAdsCampaignSnapshot_hotelClientId_campaignId_date_key"
  ON "GoogleAdsCampaignSnapshot"("hotelClientId", "campaignId", "date");
CREATE INDEX "GoogleAdsCampaignSnapshot_agencyId_idx" ON "GoogleAdsCampaignSnapshot"("agencyId");
CREATE INDEX "GoogleAdsCampaignSnapshot_hotelClientId_date_idx" ON "GoogleAdsCampaignSnapshot"("hotelClientId", "date");

ALTER TABLE "GoogleAdsCampaignSnapshot"
  ADD CONSTRAINT "GoogleAdsCampaignSnapshot_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoogleAdsCampaignSnapshot"
  ADD CONSTRAINT "GoogleAdsCampaignSnapshot_hotelClientId_fkey"
  FOREIGN KEY ("hotelClientId") REFERENCES "HotelClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: same tenant_isolation policy as every other multi-tenant table.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['GoogleAdsCampaignSnapshot'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING ('
      '  current_setting(''app.bypass_rls'', true) = ''on'''
      '  OR "agencyId" = current_setting(''app.current_agency_id'', true)'
      ') '
      'WITH CHECK ('
      '  current_setting(''app.bypass_rls'', true) = ''on'''
      '  OR "agencyId" = current_setting(''app.current_agency_id'', true)'
      ')',
      t
    );
  END LOOP;
END $$;
