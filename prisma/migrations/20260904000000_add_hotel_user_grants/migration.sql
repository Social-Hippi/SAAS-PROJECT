-- ─────────────────────────────────────────────────────────────────────────────
-- Hotel-side users: HotelMember (the grant) + HotelUserInvite (the invitation).
--
-- WHY: the only user↔hotel link in the schema was HotelClient.createdByUserId —
-- a single nullable column recording who self-signed-up. That is a provenance
-- note, not an access model: it cannot express a second person at the same
-- hotel, cannot carry a role, and cannot be revoked. Hotel access was therefore
-- necessarily all-or-nothing, which is why it was switched off wholesale in
-- lib/hotel-auth.ts (hotelAccessNeutralized). Without this table there is no
-- safe way to turn it back on.
--
-- HotelMember deliberately mirrors AgencyMember so there is ONE tenancy
-- architecture, not two: every row carries agencyId, is indexed on it, and is
-- reachable through the existing agencyScoped* helpers. The hotel dimension is
-- an ADDITIONAL filter, never a replacement for the agency one.
--
-- SAFETY — this migration is strictly ADDITIVE:
--   • CREATE TYPE  ×2   (new enums, no existing type altered)
--   • CREATE TABLE ×2   (new tables, no existing table altered)
--   • CREATE INDEX      (on the new tables only)
--   • ADD CONSTRAINT    (foreign keys FROM the new tables only)
--
-- There is NO DROP, DELETE, TRUNCATE, UPDATE, ALTER of any existing table or
-- column, no NOT NULL applied to existing rows, and no backfill. Every existing
-- row, index and constraint is untouched, and historical attribution data is not
-- read or written. Rolling forward changes no current behaviour: with zero
-- HotelMember rows the authorization helpers deny exactly as they do today.
--
-- REVERSIBILITY: dropping the two tables and two types restores the prior schema
-- exactly, because nothing outside them was modified.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "HotelRole" AS ENUM ('hotel_owner', 'hotel_manager', 'hotel_marketing');

-- CreateEnum
CREATE TYPE "HotelInviteState" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "HotelMember" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "hotelClientId" TEXT NOT NULL,
    "clerkId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "HotelRole" NOT NULL,
    "invitedByAgencyMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HotelMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HotelUserInvite" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "hotelClientId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "HotelRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "HotelInviteState" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedByAgencyMemberId" TEXT,
    "acceptedByClerkId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HotelUserInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HotelMember_agencyId_idx" ON "HotelMember"("agencyId");

-- CreateIndex
CREATE INDEX "HotelMember_hotelClientId_idx" ON "HotelMember"("hotelClientId");

-- CreateIndex: "which hotels does this signed-in user belong to" — the hot path
-- for every hotel-side request.
CREATE INDEX "HotelMember_clerkId_idx" ON "HotelMember"("clerkId");

-- CreateIndex: one membership per (hotel, user). Re-accepting an invitation
-- updates the role rather than stacking a second grant.
CREATE UNIQUE INDEX "HotelMember_hotelClientId_clerkId_key" ON "HotelMember"("hotelClientId", "clerkId");

-- CreateIndex: a token maps to at most one invitation.
CREATE UNIQUE INDEX "HotelUserInvite_tokenHash_key" ON "HotelUserInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "HotelUserInvite_agencyId_idx" ON "HotelUserInvite"("agencyId");

-- CreateIndex: outstanding invitations for a hotel (agency management view).
CREATE INDEX "HotelUserInvite_hotelClientId_status_idx" ON "HotelUserInvite"("hotelClientId", "status");

-- CreateIndex: duplicate-invite guard.
CREATE INDEX "HotelUserInvite_hotelClientId_email_idx" ON "HotelUserInvite"("hotelClientId", "email");

-- AddForeignKey
ALTER TABLE "HotelMember" ADD CONSTRAINT "HotelMember_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelMember" ADD CONSTRAINT "HotelMember_hotelClientId_fkey" FOREIGN KEY ("hotelClientId") REFERENCES "HotelClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelUserInvite" ADD CONSTRAINT "HotelUserInvite_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelUserInvite" ADD CONSTRAINT "HotelUserInvite_hotelClientId_fkey" FOREIGN KEY ("hotelClientId") REFERENCES "HotelClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security (Layer 2 — see MULTITENANCY.md).
--
-- Applied here for the same reason every other multi-tenant table has it: these
-- rows carry agencyId and must be covered if/when the app connects as the
-- non-owner hoteltrack_app role. Enabled WITHOUT FORCE, matching the existing
-- policies, so applying this changes nothing for the current owner connection.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['HotelMember', 'HotelUserInvite'];
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

-- Grant the dedicated app role the same DML it has on every other tenant table.
-- Guarded so the migration still applies on a database where the role has not
-- been provisioned yet (it is created NOLOGIN by 20260530100000_enable_rls).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hoteltrack_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "HotelMember" TO hoteltrack_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "HotelUserInvite" TO hoteltrack_app;
  END IF;
END $$;
