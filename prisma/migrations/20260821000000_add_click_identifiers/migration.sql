-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 1A — marketing CLICK IDENTIFIERS.
--
-- Adds the ad-platform click identifiers to the three tables that already model
-- the marketing journey. No new model: Touchpoint/Session/TrackingEvent were
-- missing columns, not a concept.
--
--   Touchpoint    — the identifier present on THAT page load (one marketing
--                   interaction). Never the remembered cookie value.
--   Session       — what the browsing session LANDED with.
--   TrackingEvent — the identifier in effect when the event fired, denormalized
--                   so a conversion is self-contained for offline-conversion use.
--
-- SAFETY: every column is nullable with NO default and NO backfill, so this is a
-- metadata-only ALTER on Postgres (no table rewrite, no lock held for a scan) and
-- every existing row simply reads NULL. Historic click ids are deliberately NOT
-- extracted from TrackingEvent.pageUrl / Touchpoint.landingPage even though the
-- stored query strings often contain them: those rows were captured under the
-- older rules, and manufacturing attribution for them retroactively would change
-- numbers that have already been reported to agencies and hotels.
--
-- Touchpoint.utmTerm closes a pre-existing inconsistency — Session and
-- TrackingEvent both carried utmTerm and Touchpoint did not.
--
-- RLS: no policy changes. All three tables already have RLS enabled with a
-- tenant_isolation policy on agencyId (migrations 20260530100000 /
-- 20260609063431 / 20260612120000); policies gate rows, not columns, so new
-- columns are covered automatically.
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "TrackingEvent" ADD COLUMN     "fbclid" TEXT,
ADD COLUMN     "gbraid" TEXT,
ADD COLUMN     "gclid" TEXT,
ADD COLUMN     "wbraid" TEXT;

-- AlterTable
ALTER TABLE "Touchpoint" ADD COLUMN     "fbclid" TEXT,
ADD COLUMN     "gbraid" TEXT,
ADD COLUMN     "gclid" TEXT,
ADD COLUMN     "utmTerm" TEXT,
ADD COLUMN     "wbraid" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "fbclid" TEXT,
ADD COLUMN     "gbraid" TEXT,
ADD COLUMN     "gclid" TEXT,
ADD COLUMN     "wbraid" TEXT;

-- CreateIndex
CREATE INDEX "TrackingEvent_hotelClientId_gclid_idx" ON "TrackingEvent"("hotelClientId", "gclid");

