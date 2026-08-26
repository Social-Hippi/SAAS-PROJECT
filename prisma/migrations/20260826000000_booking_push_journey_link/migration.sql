-- ─────────────────────────────────────────────────────────────────────────────
-- Simplotel Booking Push — journey linkage + credential read path.
--
-- PART 1: Booking.journeySessionId / journeyVisitorId
-- The strongest deterministic booking<->journey evidence we can hold. These are
-- identifiers HotelTrack itself minted and carried to the booking engine in the
-- cross-domain journey token; when the provider echoes them back on the booking
-- push, the booking joins to the exact visit that produced it. Unlike an email
-- or phone hash they are unique to ONE visit, so two guests sharing a contact
-- detail can never collide. Both nullable: a provider that does not echo them
-- simply falls back to customerId / emailHash / phoneHash, then UNKNOWN.
--
-- PART 2: app_read_encrypted_secret() gains a BookingConnection branch.
-- lib/token-access.ts registers `booking_provider ->
-- BookingConnection.credentials`, but the security-definer function never
-- covered that table. Today reads use the direct parameterised path, so nothing
-- is broken; the moment TOKEN_SECRET_ACCESS=definer is enabled, a booking
-- adapter would have failed to read its own secret. CREATE OR REPLACE keeps the
-- three existing branches byte-identical and adds one.
--
-- KNOWN LIMITATION, deliberately NOT addressed here: Ga4Connection and
-- GoogleAdsConnection each hold TWO ciphertext columns on one row, which this
-- function's (table, id) signature cannot distinguish. Fixing that needs a
-- signature change affecting existing callers, so it stays a separate change.
--
-- SAFETY: additive only. Two nullable columns, two indexes, one function
-- replacement. No DROP, DELETE, TRUNCATE, UPDATE, NOT NULL, or backfill.
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "journeySessionId" TEXT,
ADD COLUMN     "journeyVisitorId" TEXT;

-- CreateIndex
CREATE INDEX "Booking_hotelClientId_journeySessionId_idx" ON "Booking"("hotelClientId", "journeySessionId");

-- CreateIndex
CREATE INDEX "Booking_hotelClientId_journeyVisitorId_idx" ON "Booking"("hotelClientId", "journeyVisitorId");

-- Extend the audited security-definer secret read to booking providers.
CREATE OR REPLACE FUNCTION app_read_encrypted_secret(p_table text, p_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ct     text;
  v_agency text;
  v_hotel  text;
  v_type   text;
BEGIN
  IF p_table = 'MetaToken' THEN
    SELECT "encryptedToken", "agencyId", NULL INTO v_ct, v_agency, v_hotel
      FROM "MetaToken" WHERE "id" = p_id;
    v_type := 'meta_ads';
  ELSIF p_table = 'InstagramConnection' THEN
    SELECT "encryptedToken", "agencyId", "hotelClientId" INTO v_ct, v_agency, v_hotel
      FROM "InstagramConnection" WHERE "id" = p_id;
    v_type := 'instagram';
  ELSIF p_table = 'GoogleAnalyticsConnection' THEN
    SELECT "encryptedCredentials", "agencyId", "hotelClientId" INTO v_ct, v_agency, v_hotel
      FROM "GoogleAnalyticsConnection" WHERE "id" = p_id;
    v_type := 'ga_credentials';
  ELSIF p_table = 'BookingConnection' THEN
    SELECT "credentials", "agencyId", "hotelClientId" INTO v_ct, v_agency, v_hotel
      FROM "BookingConnection" WHERE "id" = p_id;
    v_type := 'booking_provider';
  ELSE
    RAISE EXCEPTION 'app_read_encrypted_secret: unknown table %', p_table;
  END IF;

  IF v_ct IS NULL THEN
    RETURN NULL;
  END IF;

  -- Guarantee auditing: every ciphertext read writes an audit row.
  INSERT INTO "TokenAuditLog"
    ("id", "agencyId", "hotelClientId", "tokenType", "action", "success", "source", "createdAt")
  VALUES
    (gen_random_uuid()::text, v_agency, v_hotel, v_type, 'decrypted', true, 'db:security_definer', CURRENT_TIMESTAMP);

  RETURN v_ct;
END;
$$;
