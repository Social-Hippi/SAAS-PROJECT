import "./load-env";
import { prisma } from "../lib/prisma";

// End-to-end test harness for the Meta data-retention + backfill feature.
//
//   npx tsx scripts/test-backfill.ts setup    <hotelId>   # simulate a 5-day gap
//   npx tsx scripts/test-backfill.ts status   <hotelId>   # inspect current state
//   npx tsx scripts/test-backfill.ts teardown <hotelId>   # reset token + failures
//
// `setup` marks the agency's Meta token EXPIRED (tokenExpiresAt = 5 days ago),
// records a SyncFailure, and deletes the last 5 days of AdSnapshot/SocialSnapshot
// to create a real gap — WITHOUT touching anything older (proving no data loss).
// You then reconnect a fresh token in the UI; the backfill refills the 5 days.

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const atUtcMidnight = (d: Date) => new Date(`${ymd(d)}T00:00:00.000Z`);

async function resolveHotel(hotelId: string) {
  const hotel = await prisma.hotelClient.findUnique({
    where: { id: hotelId },
    select: { id: true, name: true, agencyId: true },
  });
  if (!hotel) {
    console.error(`No hotel found with id "${hotelId}".`);
    console.error("Tip: list hotels with:  npx prisma studio  (HotelClient table)");
    process.exit(1);
  }
  return hotel;
}

function gapDates(): Date[] {
  const now = new Date();
  const yesterday = atUtcMidnight(new Date(now.getTime() - DAY));
  return Array.from({ length: 5 }, (_, i) => new Date(yesterday.getTime() - i * DAY));
}

async function setup(hotelId: string) {
  const hotel = await resolveHotel(hotelId);
  const dates = gapDates();
  const inList = { in: dates };

  // 1) Expire the agency's Meta token (create a placeholder if none exists, so
  //    the UI has an expired connection to reconnect). The placeholder ciphertext
  //    is never decrypted while expired; reconnecting overwrites it.
  const fiveDaysAgo = new Date(Date.now() - 5 * DAY);
  // Tokens are hotel-scoped — target this hotel's own token.
  const existing = await prisma.metaToken.findFirst({
    where: { agencyId: hotel.agencyId, hotelClientId: hotel.id },
  });
  if (existing) {
    await prisma.metaToken.update({
      where: { id: existing.id },
      data: { status: "expired", tokenExpiresAt: fiveDaysAgo },
    });
  } else {
    await prisma.metaToken.create({
      data: {
        agencyId: hotel.agencyId,
        hotelClientId: hotel.id,
        encryptedToken: "placeholder-expired-token",
        tokenExpiresAt: fiveDaysAgo,
        status: "expired",
      },
    });
  }

  // 2) Record a SyncFailure so the integrations page shows the failure notice.
  const hasFailure = await prisma.syncFailure.findFirst({
    where: { agencyId: hotel.agencyId, tokenType: "meta_ads", resolvedAt: null },
  });
  if (!hasFailure) {
    await prisma.syncFailure.create({
      data: {
        agencyId: hotel.agencyId,
        tokenType: "meta_ads",
        reason: "Test: token expired/revoked during sync.",
        failedAt: fiveDaysAgo,
      },
    });
  }

  // 3) Delete the last 5 days of snapshots — the GAP. Older rows are untouched.
  const adBefore = await prisma.adSnapshot.count({ where: { hotelClientId: hotel.id } });
  const adDeleted = await prisma.adSnapshot.deleteMany({
    where: { hotelClientId: hotel.id, date: inList },
  });
  const socialDeleted = await prisma.socialSnapshot.deleteMany({
    where: { hotelClientId: hotel.id, date: inList },
  });
  const adAfter = await prisma.adSnapshot.count({ where: { hotelClientId: hotel.id } });

  console.log(`\n✅ Setup complete for "${hotel.name}" (${hotel.id})`);
  console.log(`   Meta token        → status="expired", expired ${ymd(fiveDaysAgo)}`);
  console.log(`   SyncFailure       → recorded (meta_ads)`);
  console.log(`   Gap dates deleted → ${dates.map(ymd).reverse().join(", ")}`);
  console.log(`   AdSnapshot rows   → deleted ${adDeleted.count} (kept ${adAfter} of ${adBefore} older rows)`);
  console.log(`   SocialSnapshot    → deleted ${socialDeleted.count}`);
  if (adBefore === adDeleted.count) {
    console.log(`   ⚠  All ad rows were in the gap window — add older data first to fully prove "no loss".`);
  }

  console.log(`\n──────────── WALKTHROUGH ────────────`);
  console.log(`1. Open the hotel dashboard:   http://localhost:3001/agency/hotel/${hotel.id}`);
  console.log(`   → Confirm OLDER data still shows (no data loss), plus an amber`);
  console.log(`     "5 days of data missing — reconnect Meta to backfill" badge + warning banner.`);
  console.log(`2. Open the integrations page: http://localhost:3001/agency/hotel/${hotel.id}/integrations`);
  console.log(`   → Meta card shows "Token Expired — Reconnect Needed" + "Data sync failed 5 days ago".`);
  console.log(`3. Go to Settings:             http://localhost:3001/agency/settings`);
  console.log(`   → Paste a FRESH, valid Meta token and Connect.`);
  console.log(`4. The "Pulling missing data…" banner appears and polls to`);
  console.log(`   "Backfill complete — N days of data restored."`);
  console.log(`5. Verify the rows came back:  npx tsx scripts/test-backfill.ts status ${hotel.id}`);
  console.log(`6. Reload the dashboard — the previously-missing 5 days are present again.`);
  console.log(`\nTo reset state and retry:       npx tsx scripts/test-backfill.ts teardown ${hotel.id}\n`);
}

async function status(hotelId: string) {
  const hotel = await resolveHotel(hotelId);
  const dates = gapDates();
  const [token, adInGap, socialInGap, adTotal, failures, job] = await Promise.all([
    prisma.metaToken.findFirst({
      where: { agencyId: hotel.agencyId, hotelClientId: hotel.id },
      select: { status: true, tokenExpiresAt: true },
    }),
    prisma.adSnapshot.count({ where: { hotelClientId: hotel.id, date: { in: dates } } }),
    prisma.socialSnapshot.count({ where: { hotelClientId: hotel.id, date: { in: dates } } }),
    prisma.adSnapshot.count({ where: { hotelClientId: hotel.id } }),
    prisma.syncFailure.count({ where: { agencyId: hotel.agencyId, resolvedAt: null } }),
    prisma.backfillJob.findFirst({
      where: { agencyId: hotel.agencyId },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  console.log(`\nStatus for "${hotel.name}" (${hotel.id})`);
  console.log(`   Meta token        → ${token ? `${token.status}, expires ${ymd(token.tokenExpiresAt)}` : "none"}`);
  console.log(`   AdSnapshot total  → ${adTotal}`);
  console.log(`   Gap window dates  → ${dates.map(ymd).reverse().join(", ")}`);
  console.log(`   Rows in gap       → AdSnapshot ${adInGap}/5, SocialSnapshot ${socialInGap}/5`);
  console.log(`   Active failures   → ${failures}`);
  if (job) {
    console.log(`   Latest backfill   → ${job.status} (restored ${job.daysRestored}, failed ${job.daysFailed})`);
    if (job.message) console.log(`                       "${job.message}"`);
  } else {
    console.log(`   Latest backfill   → none yet`);
  }
  console.log("");
}

async function teardown(hotelId: string) {
  const hotel = await resolveHotel(hotelId);
  await prisma.metaToken.updateMany({
    where: { agencyId: hotel.agencyId },
    data: { status: "connected" },
  });
  const resolved = await prisma.syncFailure.updateMany({
    where: { agencyId: hotel.agencyId, resolvedAt: null },
    data: { resolvedAt: new Date() },
  });
  console.log(`\n✅ Teardown for "${hotel.name}": Meta token → connected, resolved ${resolved.count} sync failure(s).`);
  console.log(`   (Deleted snapshots are NOT recreated here — reconnect/backfill restores them.)\n`);
}

async function main() {
  const [, , cmd, hotelId] = process.argv;
  if (!cmd || !hotelId || !["setup", "status", "teardown"].includes(cmd)) {
    console.log("Usage: npx tsx scripts/test-backfill.ts <setup|status|teardown> <hotelId>");
    process.exit(1);
  }
  if (cmd === "setup") await setup(hotelId);
  else if (cmd === "status") await status(hotelId);
  else await teardown(hotelId);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
