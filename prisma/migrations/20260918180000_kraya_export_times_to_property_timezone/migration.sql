-- One-time repair: Kraya export times were stored 5 h 30 min late.
--
-- The export writes local wall-clock time with no offset ("2026-09-17 07:22:18"),
-- and the importer read it as UTC. For an IST property that stored every
-- imported time 5 h 30 min after the moment it names. The importer now reads the
-- export in the property's timezone; this puts the times already imported right.
--
-- WHICH VALUES. Only those that came from an export, told apart by precision:
-- the export parser produces whole seconds, while a live Kraya webhook is dated
-- by `new Date()` and carries milliseconds. On Aster at the time of writing that
-- split is 4,028 first-message times from exports against 145 from webhooks.
--
-- HOW. A stored value is the export's wall-clock digits held as naive UTC.
-- `v AT TIME ZONE tz` reads those digits as local time in the property's
-- timezone; `AT TIME ZONE 'UTC'` turns that instant back into naive UTC. So the
-- conversion is exact for any timezone, and DST-safe — not a fixed 5:30.
--
-- ONCE ONLY. Running this twice would shift everything a second time. As a
-- migration it is recorded when applied and never runs again; that record is
-- the guard. Existing times written by a webhook are never touched.

-- Conversations created or last updated from an export.
UPDATE "WhatsAppConversation" AS c
   SET "firstMessageAt" = (c."firstMessageAt" AT TIME ZONE h."timezone") AT TIME ZONE 'UTC'
  FROM "HotelClient" AS h
 WHERE h."id" = c."hotelClientId"
   AND c."krayaLeadId" IS NOT NULL
   AND c."connectionId" IS NULL
   AND date_trunc('second', c."firstMessageAt") = c."firstMessageAt";

UPDATE "WhatsAppConversation" AS c
   SET "lastMessageAt" = (c."lastMessageAt" AT TIME ZONE h."timezone") AT TIME ZONE 'UTC'
  FROM "HotelClient" AS h
 WHERE h."id" = c."hotelClientId"
   AND c."krayaLeadId" IS NOT NULL
   AND c."connectionId" IS NULL
   AND date_trunc('second', c."lastMessageAt") = c."lastMessageAt";

-- Kraya bookings dated from an export (the confirmation time in its history, or
-- the stage-updated time). A booking the webhook dated keeps its milliseconds.
UPDATE "Booking" AS b
   SET "bookedAt" = (b."bookedAt" AT TIME ZONE h."timezone") AT TIME ZONE 'UTC'
  FROM "HotelClient" AS h
 WHERE h."id" = b."hotelClientId"
   AND b."provider" = 'kraya'
   AND date_trunc('second', b."bookedAt") = b."bookedAt";
