-- CreateTable
CREATE TABLE "PropertySegment" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "hotelClientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "pathPrefixes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bookingHosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceSheetId" TEXT,
    "sourceTabName" TEXT,
    "trackerLayout" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertySegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualLeadDaily" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "hotelClientId" TEXT NOT NULL,
    "propertySegmentId" TEXT,
    "date" DATE NOT NULL,
    "enquiries" INTEGER,
    "repeatContacts" INTEGER,
    "roomNightsConfirmed" INTEGER,
    "junkSpam" INTEGER,
    "soldOut" INTEGER,
    "inhouse" INTEGER,
    "lowBudget" INTEGER,
    "lessRoom" INTEGER,
    "lowBudgetLessRoom" INTEGER,
    "whatsappLeads" INTEGER,
    "whatsappConfirmed" INTEGER,
    "totalCallsReceived" INTEGER,
    "storedTotalLeads" INTEGER,
    "storedConversionRate" DECIMAL(7,4),
    "sourceRow" JSONB NOT NULL,
    "sourceSheetId" TEXT NOT NULL,
    "sourceTabName" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualLeadDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertySegment_agencyId_idx" ON "PropertySegment"("agencyId");

-- CreateIndex
CREATE INDEX "PropertySegment_hotelClientId_idx" ON "PropertySegment"("hotelClientId");

-- CreateIndex
CREATE UNIQUE INDEX "PropertySegment_hotelClientId_slug_key" ON "PropertySegment"("hotelClientId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "PropertySegment_sourceSheetId_sourceTabName_key" ON "PropertySegment"("sourceSheetId", "sourceTabName");

-- CreateIndex
CREATE INDEX "ManualLeadDaily_agencyId_idx" ON "ManualLeadDaily"("agencyId");

-- CreateIndex
CREATE INDEX "ManualLeadDaily_hotelClientId_date_idx" ON "ManualLeadDaily"("hotelClientId", "date");

-- CreateIndex
CREATE INDEX "ManualLeadDaily_propertySegmentId_date_idx" ON "ManualLeadDaily"("propertySegmentId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ManualLeadDaily_sourceSheetId_sourceTabName_date_key" ON "ManualLeadDaily"("sourceSheetId", "sourceTabName", "date");

-- AddForeignKey
ALTER TABLE "PropertySegment" ADD CONSTRAINT "PropertySegment_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertySegment" ADD CONSTRAINT "PropertySegment_hotelClientId_fkey" FOREIGN KEY ("hotelClientId") REFERENCES "HotelClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualLeadDaily" ADD CONSTRAINT "ManualLeadDaily_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualLeadDaily" ADD CONSTRAINT "ManualLeadDaily_hotelClientId_fkey" FOREIGN KEY ("hotelClientId") REFERENCES "HotelClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualLeadDaily" ADD CONSTRAINT "ManualLeadDaily_propertySegmentId_fkey" FOREIGN KEY ("propertySegmentId") REFERENCES "PropertySegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
