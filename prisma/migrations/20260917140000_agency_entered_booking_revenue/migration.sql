
-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "agencyAdAttributed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "agencyRevenue" DECIMAL(12,2),
ADD COLUMN     "agencyRevenueAt" TIMESTAMP(3),
ADD COLUMN     "agencyRevenueBy" TEXT,
ADD COLUMN     "agencyRevenueCurrency" TEXT;

-- CreateIndex
CREATE INDEX "Booking_hotelClientId_agencyAdAttributed_bookedAt_idx" ON "Booking"("hotelClientId", "agencyAdAttributed", "bookedAt");

