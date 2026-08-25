-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 1B — BOOKING FOUNDATION.
--
-- Establishes the booking world as a set of FACTS, kept separate from any
-- attribution INTERPRETATION:
--
--   BookingConnection    — provider-agnostic seam for a PMS / booking engine /
--                          OTA / channel manager. No vendor is hard-coded and
--                          none is integrated yet.
--   Booking              — the reservation itself. Carries NO visitorId,
--                          sessionId, matchMethod or confidence.
--   BookingStatusEvent   — append-only lifecycle, so a cancellation or refund is
--                          a new row and the realized value stays reconstructable.
--   BookingJourneyMatch  — the EVIDENCE linking a booking to a journey, with an
--                          explicit method and confidence. May be absent, may be
--                          ambiguous (multiple rows per booking are allowed);
--                          none of that is permitted to corrupt the Booking row.
--
-- SAFETY: purely ADDITIVE. Four new tables and three new enum types. No existing
-- table is altered, and no tracking data is touched — TrackingEvent,
-- Touchpoint, Session and the DOM-scraped conversionValue all keep working
-- exactly as before. There is no DROP, DELETE, TRUNCATE, or UPDATE anywhere in
-- this migration, and no backfill: every Booking row must come from a real
-- booking source.
--
-- RLS: the four tables are enrolled in the same tenant_isolation policy as every
-- other multi-tenant table (see 20260530100000_enable_rls).
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('CONFIRMED', 'MODIFIED', 'CANCELLED', 'REFUNDED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "BookingMatchMethod" AS ENUM ('booking_id', 'customer_id', 'email_hash', 'phone_hash', 'visitor_id', 'session_id', 'tracking_event', 'coupon_code', 'manual', 'unknown');

-- CreateEnum
CREATE TYPE "BookingMatchConfidence" AS ENUM ('DETERMINISTIC', 'STRONG', 'PARTIAL', 'UNKNOWN');

-- CreateTable
CREATE TABLE "BookingConnection" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "hotelClientId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalAccountId" TEXT,
    "credentials" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastBookingReceivedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "hotelClientId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalBookingId" TEXT NOT NULL,
    "connectionId" TEXT,
    "status" "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "bookingChannel" TEXT,
    "currency" TEXT,
    "bookedAt" TIMESTAMP(3) NOT NULL,
    "checkIn" TIMESTAMP(3),
    "checkOut" TIMESTAMP(3),
    "guestEmailHash" TEXT,
    "guestPhoneHash" TEXT,
    "guestName" TEXT,
    "externalGuestId" TEXT,
    "grossAmount" DECIMAL(12,2),
    "netAmount" DECIMAL(12,2),
    "roomRevenue" DECIMAL(12,2),
    "ancillaryRevenue" DECIMAL(12,2),
    "taxAmount" DECIMAL(12,2),
    "refundedAmount" DECIMAL(12,2),
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingStatusEvent" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "status" "BookingStatus" NOT NULL,
    "grossAmount" DECIMAL(12,2),
    "netAmount" DECIMAL(12,2),
    "refundedAmount" DECIMAL(12,2),
    "currency" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingJourneyMatch" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "hotelClientId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "visitorId" TEXT,
    "sessionId" TEXT,
    "trackingEventId" TEXT,
    "matchMethod" "BookingMatchMethod" NOT NULL DEFAULT 'unknown',
    "matchConfidence" "BookingMatchConfidence" NOT NULL DEFAULT 'UNKNOWN',
    "evidence" JSONB,
    "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingJourneyMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingConnection_hotelClientId_key" ON "BookingConnection"("hotelClientId");

-- CreateIndex
CREATE INDEX "BookingConnection_agencyId_idx" ON "BookingConnection"("agencyId");

-- CreateIndex
CREATE INDEX "Booking_agencyId_idx" ON "Booking"("agencyId");

-- CreateIndex
CREATE INDEX "Booking_hotelClientId_bookedAt_idx" ON "Booking"("hotelClientId", "bookedAt");

-- CreateIndex
CREATE INDEX "Booking_hotelClientId_status_idx" ON "Booking"("hotelClientId", "status");

-- CreateIndex
CREATE INDEX "Booking_hotelClientId_guestEmailHash_idx" ON "Booking"("hotelClientId", "guestEmailHash");

-- CreateIndex
CREATE INDEX "Booking_hotelClientId_guestPhoneHash_idx" ON "Booking"("hotelClientId", "guestPhoneHash");

-- CreateIndex
CREATE INDEX "Booking_connectionId_idx" ON "Booking"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_hotelClientId_provider_externalBookingId_key" ON "Booking"("hotelClientId", "provider", "externalBookingId");

-- CreateIndex
CREATE INDEX "BookingStatusEvent_agencyId_idx" ON "BookingStatusEvent"("agencyId");

-- CreateIndex
CREATE INDEX "BookingStatusEvent_bookingId_occurredAt_idx" ON "BookingStatusEvent"("bookingId", "occurredAt");

-- CreateIndex
CREATE INDEX "BookingJourneyMatch_agencyId_idx" ON "BookingJourneyMatch"("agencyId");

-- CreateIndex
CREATE INDEX "BookingJourneyMatch_bookingId_idx" ON "BookingJourneyMatch"("bookingId");

-- CreateIndex
CREATE INDEX "BookingJourneyMatch_hotelClientId_matchConfidence_idx" ON "BookingJourneyMatch"("hotelClientId", "matchConfidence");

-- CreateIndex
CREATE INDEX "BookingJourneyMatch_visitorId_idx" ON "BookingJourneyMatch"("visitorId");

-- CreateIndex
CREATE INDEX "BookingJourneyMatch_trackingEventId_idx" ON "BookingJourneyMatch"("trackingEventId");

-- AddForeignKey
ALTER TABLE "BookingConnection" ADD CONSTRAINT "BookingConnection_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingConnection" ADD CONSTRAINT "BookingConnection_hotelClientId_fkey" FOREIGN KEY ("hotelClientId") REFERENCES "HotelClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_hotelClientId_fkey" FOREIGN KEY ("hotelClientId") REFERENCES "HotelClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BookingConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingStatusEvent" ADD CONSTRAINT "BookingStatusEvent_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingStatusEvent" ADD CONSTRAINT "BookingStatusEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingJourneyMatch" ADD CONSTRAINT "BookingJourneyMatch_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingJourneyMatch" ADD CONSTRAINT "BookingJourneyMatch_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Row-Level Security (same policy shape as every other tenant table) ──
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['BookingConnection', 'Booking', 'BookingStatusEvent', 'BookingJourneyMatch'];
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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hoteltrack_app', t);
  END LOOP;
END $$;
