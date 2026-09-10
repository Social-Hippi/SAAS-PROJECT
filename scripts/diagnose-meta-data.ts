import "./load-env";
import { prisma } from "../lib/prisma";

// READ-ONLY diagnosis of Meta ads data provenance. Writes nothing.
// Run: npx tsx scripts/diagnose-meta-data.ts

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "—");
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "—");

async function main() {
  // Which DB are we connected to? (host only — never print credentials)
  const dbUrl = process.env.DATABASE_URL ?? "";
  const host = dbUrl.match(/@([^/:?]+)/)?.[1] ?? "unknown";
  console.log(`Connected to DB host: ${host}\n`);

  // ── 1. AdSnapshot rows grouped by hotel ──
  console.log("══ 1. AdSnapshot rows by hotel ══");
  const groups = await prisma.adSnapshot.groupBy({
    by: ["hotelClientId", "metaAccountId"],
    _count: true,
    _min: { date: true },
    _max: { date: true },
    _sum: { spend: true },
  });
  for (const g of groups) {
    const hotel = await prisma.hotelClient.findUnique({
      where: { id: g.hotelClientId },
      select: { name: true, agencyId: true },
    });
    console.log(
      `  hotel=${hotel?.name ?? "?"} (${g.hotelClientId})\n` +
        `    metaAccountId=${g.metaAccountId} rows=${g._count} ` +
        `range=${ymd(g._min.date)}→${ymd(g._max.date)} totalSpend=${g._sum.spend}`,
    );
  }

  // ── 2. The hotel showing spend: 5 most recent rows + token + account ──
  const hotel = await prisma.hotelClient.findFirst({
    where: { metaAdAccountId: { not: null } },
    select: { id: true, name: true, agencyId: true, metaAdAccountId: true, lastSyncedAt: true, createdAt: true },
  });
  if (!hotel) throw new Error("No hotel with a mapped ad account.");

  console.log(`\n══ 2. Hotel "${hotel.name}" (${hotel.id}) ══`);
  console.log(`  metaAdAccountId: ${hotel.metaAdAccountId}`);
  console.log(`  hotel.lastSyncedAt: ${iso(hotel.lastSyncedAt)}`);
  console.log(`  hotel.createdAt:    ${iso(hotel.createdAt)}`);

  console.log("\n  5 most recent AdSnapshot rows:");
  const recent = await prisma.adSnapshot.findMany({
    where: { hotelClientId: hotel.id },
    orderBy: { date: "desc" },
    take: 5,
    select: { date: true, spend: true, impressions: true, clicks: true, conversions: true },
  });
  for (const r of recent) {
    console.log(
      `    ${ymd(r.date)}  spend=${r.spend}  impr=${r.impressions}  clicks=${r.clicks}  conv=${r.conversions}`,
    );
  }

  console.log("\n  MetaToken rows for this agency (token itself NOT selected):");
  const tokens = await prisma.metaToken.findMany({
    where: { agencyId: hotel.agencyId },
    select: { id: true, agencyId: true, hotelClientId: true, status: true, tokenExpiresAt: true, createdAt: true },
  });
  for (const t of tokens) {
    console.log(
      `    id=${t.id} hotelClientId=${t.hotelClientId} status=${t.status} expires=${iso(t.tokenExpiresAt)} createdAt=${iso(t.createdAt)}`,
    );
  }
  console.log("  (schema note: MetaToken is per-HOTEL — @@unique([hotelClientId]);");
  console.log("   lastSyncedAt lives on HotelClient, shown above. AdSnapshot has NO createdAt column.)");

  // ── 3. Provenance timestamps: backfill jobs + token audit log ──
  console.log("\n══ 3. Sync/backfill history (real-time evidence) ══");
  const jobs = await prisma.backfillJob.findMany({
    where: { agencyId: hotel.agencyId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { status: true, rangeStart: true, rangeEnd: true, daysRestored: true, daysFailed: true, createdAt: true, finishedAt: true, message: true },
  });
  console.log(`  BackfillJobs (${jobs.length}):`);
  for (const j of jobs) {
    console.log(
      `    ${iso(j.createdAt)} → ${iso(j.finishedAt)} status=${j.status} ` +
        `range=${ymd(j.rangeStart)}→${ymd(j.rangeEnd)} restored=${j.daysRestored} failed=${j.daysFailed}` +
        (j.message ? ` msg="${j.message}"` : ""),
    );
  }

  const audits = await prisma.tokenAuditLog.findMany({
    where: { agencyId: hotel.agencyId, tokenType: "meta_ads" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { createdAt: true, action: true, success: true, source: true },
  });
  console.log(`\n  TokenAuditLog, last ${audits.length} meta_ads accesses:`);
  for (const a of audits) {
    console.log(`    ${iso(a.createdAt)} action=${a.action} success=${a.success} source=${a.source}`);
  }

  // ── 4. Pattern analysis: does the data look scripted? ──
  console.log("\n══ 4. Pattern analysis vs seed-script signatures ══");
  const all = await prisma.adSnapshot.findMany({
    where: { hotelClientId: hotel.id },
    select: { date: true, spend: true },
    orderBy: { date: "asc" },
  });
  const spends = all.map((r) => Number(r.spend));
  const n = spends.length;
  const mean = spends.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(spends.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const distinct = new Set(spends.map((s) => s.toFixed(2))).size;
  const weekend: number[] = [];
  const weekday: number[] = [];
  for (const r of all) {
    const dow = r.date.getUTCDay();
    (dow === 0 || dow === 6 ? weekend : weekday).push(Number(r.spend));
  }
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  console.log(`  rows=${n} distinct spend values=${distinct} (scripted data often repeats/rounds)`);
  console.log(`  spend: min=${Math.min(...spends).toFixed(2)} max=${Math.max(...spends).toFixed(2)} mean=${mean.toFixed(2)} sd=${sd.toFixed(2)}`);
  console.log(`  weekday avg=${avg(weekday).toFixed(2)} weekend avg=${avg(weekend).toFixed(2)} ratio=${(avg(weekend) / avg(weekday)).toFixed(3)}`);
  console.log(`  (prisma/seed.ts demo generator multiplies weekend spend by exactly 1.25 → ratio ≈ 1.25;`);
  console.log(`   seed-dashboard-demo.ts uses spend ₹35–140 + metaAccountId "act_demo_000";`);
  console.log(`   prisma/seed.ts uses a RANDOM 9-digit act_… id and spend ₹800–6000×scale)`);

  // Paise distribution — uniform random generators produce uniformly random paise;
  // so does real Meta data. Round numbers (.00-heavy) would suggest hand-typed data.
  const paise = spends.filter((s) => Math.abs(s - Math.round(s)) < 0.005).length;
  console.log(`  values that are whole rupees: ${paise}/${n}`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
