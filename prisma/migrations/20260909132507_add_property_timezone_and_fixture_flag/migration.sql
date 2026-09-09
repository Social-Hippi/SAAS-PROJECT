-- AlterTable
ALTER TABLE "Agency" ADD COLUMN     "isFixture" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "HotelClient" ADD COLUMN     "isFixture" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata';
