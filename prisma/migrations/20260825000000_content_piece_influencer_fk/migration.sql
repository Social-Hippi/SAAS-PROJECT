-- ─────────────────────────────────────────────────────────────────────────────
-- Track A — deterministic Influencer ↔ ContentPiece link.
--
-- Before this, an influencer's tracking URL resolved only to a ContentPiece, and
-- the ContentPiece named its influencer in a FREE-TEXT column
-- (`influencerName`). Two influencers with the same display name were
-- indistinguishable, a rename orphaned history, and the UTM path and the coupon
-- path could not be proven to be the same person.
--
-- `influencerId` makes utm_content → ContentPiece → Influencer a FOREIGN KEY
-- resolution. `influencerName` is intentionally KEPT so existing rows and the
-- UI label survive; it is simply no longer an identity.
--
-- SAFETY: additive only. One nullable column + one index + one FK. No DROP, no
-- DELETE, no TRUNCATE, no UPDATE, and no backfill — existing ContentPieces get
-- NULL, which is correct: we cannot know which Influencer a typed name meant.
-- ─────────────────────────────────────────────────────────────────────────────

-- AlterTable
ALTER TABLE "ContentPiece" ADD COLUMN     "influencerId" TEXT;

-- CreateIndex
CREATE INDEX "ContentPiece_influencerId_idx" ON "ContentPiece"("influencerId");

-- AddForeignKey
ALTER TABLE "ContentPiece" ADD CONSTRAINT "ContentPiece_influencerId_fkey" FOREIGN KEY ("influencerId") REFERENCES "Influencer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

