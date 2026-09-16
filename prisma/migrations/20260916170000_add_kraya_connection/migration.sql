
-- DropIndex
DROP INDEX "BookingConnection_hotelClientId_key";

-- AlterTable
ALTER TABLE "WhatsAppConversation" ADD COLUMN     "krayaLeadId" TEXT,
ADD COLUMN     "pipelineName" TEXT,
ADD COLUMN     "stageName" TEXT,
ALTER COLUMN "connectionId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "KrayaConnection" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "hotelClientId" TEXT NOT NULL,
    "credentials" TEXT,
    "confirmedStageName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastLeadReceivedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KrayaConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KrayaConnection_hotelClientId_key" ON "KrayaConnection"("hotelClientId");

-- CreateIndex
CREATE INDEX "KrayaConnection_agencyId_idx" ON "KrayaConnection"("agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingConnection_hotelClientId_provider_key" ON "BookingConnection"("hotelClientId", "provider");

-- CreateIndex
CREATE INDEX "WhatsAppConversation_hotelClientId_krayaLeadId_idx" ON "WhatsAppConversation"("hotelClientId", "krayaLeadId");

-- AddForeignKey
ALTER TABLE "KrayaConnection" ADD CONSTRAINT "KrayaConnection_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KrayaConnection" ADD CONSTRAINT "KrayaConnection_hotelClientId_fkey" FOREIGN KEY ("hotelClientId") REFERENCES "HotelClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

