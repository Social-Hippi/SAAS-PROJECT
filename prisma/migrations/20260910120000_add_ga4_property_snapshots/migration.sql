-- CreateTable
CREATE TABLE "Ga4PropertySnapshot" (
    "id" TEXT NOT NULL,
    "hotelClientId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "segmentKey" TEXT NOT NULL,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "users" INTEGER NOT NULL DEFAULT 0,
    "newUsers" INTEGER NOT NULL DEFAULT 0,
    "pageViews" INTEGER NOT NULL DEFAULT 0,
    "bounceRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgSessionDuration" INTEGER NOT NULL DEFAULT 0,
    "engagedSessions" INTEGER NOT NULL DEFAULT 0,
    "engagementRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "userEngagementDuration" INTEGER NOT NULL DEFAULT 0,
    "screenPageViewsPerSession" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "keyEvents" INTEGER NOT NULL DEFAULT 0,
    "organicSessions" INTEGER NOT NULL DEFAULT 0,
    "paidSessions" INTEGER NOT NULL DEFAULT 0,
    "socialSessions" INTEGER NOT NULL DEFAULT 0,
    "directSessions" INTEGER NOT NULL DEFAULT 0,
    "referralSessions" INTEGER NOT NULL DEFAULT 0,
    "mobileSessions" INTEGER NOT NULL DEFAULT 0,
    "desktopSessions" INTEGER NOT NULL DEFAULT 0,
    "tabletSessions" INTEGER NOT NULL DEFAULT 0,
    "topCountries" JSONB,
    "topCities" JSONB,
    "topSources" JSONB,
    "topCampaigns" JSONB,
    "topPages" JSONB,

    CONSTRAINT "Ga4PropertySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Ga4PropertySnapshot_hotelClientId_date_idx" ON "Ga4PropertySnapshot"("hotelClientId", "date");

-- CreateIndex
CREATE INDEX "Ga4PropertySnapshot_agencyId_idx" ON "Ga4PropertySnapshot"("agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "Ga4PropertySnapshot_hotelClientId_segmentKey_date_key" ON "Ga4PropertySnapshot"("hotelClientId", "segmentKey", "date");

-- AddForeignKey
ALTER TABLE "Ga4PropertySnapshot" ADD CONSTRAINT "Ga4PropertySnapshot_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ga4PropertySnapshot" ADD CONSTRAINT "Ga4PropertySnapshot_hotelClientId_fkey" FOREIGN KEY ("hotelClientId") REFERENCES "HotelClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
