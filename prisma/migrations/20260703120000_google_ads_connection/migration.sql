-- ─────────────────────────────────────────────────────────────────────────────
-- Google Ads (googleads.googleapis.com, GAQL) per-hotel OAuth connection.
-- SEPARATE from GA4: different API, the `adwords` OAuth scope, and a platform
-- developer token. Modeled exactly like Ga4Connection — encrypted access +
-- refresh tokens, hotel-scoped, multi-tenant (agencyId + tenant_isolation RLS).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "GoogleAdsStatus" AS ENUM ('ACTIVE', 'TOKEN_EXPIRED', 'ERROR', 'REVOKED');

CREATE TABLE "GoogleAdsConnection" (
    "id"                TEXT NOT NULL,
    "hotelClientId"     TEXT NOT NULL,
    "agencyId"          TEXT NOT NULL,
    "customerId"        TEXT NOT NULL,
    "customerName"      TEXT,
    "currencyCode"      TEXT,
    "loginCustomerId"   TEXT,
    "accessToken"       TEXT NOT NULL,
    "refreshToken"      TEXT NOT NULL,
    "tokenExpiresAt"    TIMESTAMP(3) NOT NULL,
    "scope"             TEXT NOT NULL,
    "status"            "GoogleAdsStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSyncedAt"      TIMESTAMP(3),
    "lastSyncError"     TEXT,
    "requiresReconnect" BOOLEAN NOT NULL DEFAULT false,
    "lastErrorReason"   TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleAdsConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoogleAdsConnection_hotelClientId_key" ON "GoogleAdsConnection"("hotelClientId");
CREATE INDEX "GoogleAdsConnection_agencyId_idx" ON "GoogleAdsConnection"("agencyId");

ALTER TABLE "GoogleAdsConnection"
  ADD CONSTRAINT "GoogleAdsConnection_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoogleAdsConnection"
  ADD CONSTRAINT "GoogleAdsConnection_hotelClientId_fkey"
  FOREIGN KEY ("hotelClientId") REFERENCES "HotelClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: same tenant_isolation policy as every other multi-tenant table.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['GoogleAdsConnection'];
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
