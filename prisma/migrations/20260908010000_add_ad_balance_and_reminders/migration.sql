-- Advertising funds + the low-balance reminder the client dashboard configures.
--
-- Every money column is NULLABLE and in minor units. Meta only exposes a usable
-- "available funds" figure for some funding models, so a null here means "this
-- account does not publish one" and must render as "Balance unavailable" — never
-- as 0, which would read to a hotel owner as "you are out of money".
CREATE TABLE "AdAccountBalance" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "hotelClientId" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "availableMinor" INTEGER,
  "amountDueMinor" INTEGER,
  "amountSpentMinor" INTEGER,
  "spendCapMinor" INTEGER,
  "currency" TEXT,
  "fundingType" TEXT,
  "checkedAt" TIMESTAMP(3) NOT NULL,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdAccountBalance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdAccountBalance_hotelClientId_platform_accountId_key"
  ON "AdAccountBalance"("hotelClientId", "platform", "accountId");
CREATE INDEX "AdAccountBalance_agencyId_idx" ON "AdAccountBalance"("agencyId");
CREATE INDEX "AdAccountBalance_hotelClientId_idx" ON "AdAccountBalance"("hotelClientId");

ALTER TABLE "AdAccountBalance" ADD CONSTRAINT "AdAccountBalance_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdAccountBalance" ADD CONSTRAINT "AdAccountBalance_hotelClientId_fkey"
  FOREIGN KEY ("hotelClientId") REFERENCES "HotelClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LowBalanceReminder" (
  "id" TEXT NOT NULL,
  "agencyId" TEXT NOT NULL,
  "hotelClientId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "thresholdMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastCheckedAt" TIMESTAMP(3),
  "lastTriggeredAt" TIMESTAMP(3),
  "lastTriggeredAtBalanceMinor" INTEGER,
  "triggered" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LowBalanceReminder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LowBalanceReminder_hotelClientId_key" ON "LowBalanceReminder"("hotelClientId");
CREATE INDEX "LowBalanceReminder_agencyId_idx" ON "LowBalanceReminder"("agencyId");

ALTER TABLE "LowBalanceReminder" ADD CONSTRAINT "LowBalanceReminder_agencyId_fkey"
  FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LowBalanceReminder" ADD CONSTRAINT "LowBalanceReminder_hotelClientId_fkey"
  FOREIGN KEY ("hotelClientId") REFERENCES "HotelClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
