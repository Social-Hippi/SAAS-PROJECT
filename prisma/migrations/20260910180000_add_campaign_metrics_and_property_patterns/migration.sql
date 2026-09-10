-- AlterTable
ALTER TABLE "AdCampaignSnapshot" ADD COLUMN     "reach" INTEGER,
ADD COLUMN     "messagingStarted" INTEGER,
ADD COLUMN     "leads" INTEGER,
ADD COLUMN     "qualityRanking" TEXT,
ADD COLUMN     "engagementRateRanking" TEXT,
ADD COLUMN     "conversionRateRanking" TEXT;

-- AlterTable
ALTER TABLE "PropertySegment" ADD COLUMN     "campaignNamePatterns" TEXT[] DEFAULT ARRAY[]::TEXT[];
