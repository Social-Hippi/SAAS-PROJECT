
-- AlterTable
ALTER TABLE "BookingConnection" ADD COLUMN     "lastPushAt" TIMESTAMP(3),
ADD COLUMN     "lastPushOutcome" TEXT;

-- CreateTable
CREATE TABLE "BookingPushCapture" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "hotelClientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "bodyEncrypted" TEXT NOT NULL,
    "bodyBytes" INTEGER NOT NULL,
    "replayedAt" TIMESTAMP(3),

    CONSTRAINT "BookingPushCapture_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingPushCapture_agencyId_idx" ON "BookingPushCapture"("agencyId");

-- CreateIndex
CREATE INDEX "BookingPushCapture_connectionId_replayedAt_idx" ON "BookingPushCapture"("connectionId", "replayedAt");

-- CreateIndex
CREATE INDEX "BookingPushCapture_hotelClientId_receivedAt_idx" ON "BookingPushCapture"("hotelClientId", "receivedAt");

-- AddForeignKey
ALTER TABLE "BookingPushCapture" ADD CONSTRAINT "BookingPushCapture_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPushCapture" ADD CONSTRAINT "BookingPushCapture_hotelClientId_fkey" FOREIGN KEY ("hotelClientId") REFERENCES "HotelClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPushCapture" ADD CONSTRAINT "BookingPushCapture_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BookingConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
┌─────────────────────────────────────────────────────────┐
│  Update available 7.8.0 -> 8.0.0-rc.15                  │
│                                                         │
│  This is a major update - please follow the guide at    │
│  https://pris.ly/d/major-version-upgrade                │
│                                                         │
│  Run the following to update                            │
│    npm i --save-dev prisma@latest                       │
│    npm i @prisma/client@latest                          │
└─────────────────────────────────────────────────────────┘


-- RLS: same tenant_isolation policy as every other multi-tenant table. Held
-- push bodies carry guest PII, so they must be unreadable across agencies at the
-- database layer too, not only in application code.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['BookingPushCapture'];
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
