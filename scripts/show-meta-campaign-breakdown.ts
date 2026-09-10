import "./load-env";
import { prisma } from "../lib/prisma";

// READ-ONLY: prints the Meta Campaign Breakdown exactly as the new dashboard
// section computes it (raw AdCampaignSnapshot, per-campaign, sorted by spend).
//   npx tsx scripts/show-meta-campaign-breakdown.ts [days]

const DAY_MS = 86_400_000;

async function main() {
  const days = Number.isFinite(Number(process.argv[2])) ? Number(process.argv[2]) : 30;
  const since = new Date(Date.now() - days * DAY_MS);
  const hotel = await prisma.hotelClient.findFirst({
    where: { metaAdAccountId: { not: null } },
    select: { id: true, name: true, metaAdAccountId: true },
  });
  if (!hotel) throw new Error("no hotel with ad account");

  const snaps = await prisma.adCampaignSnapshot.findMany({
    where: { hotelClientId: hotel.id, date: { gte: since } },
    select: { metaCampaignId: true, campaignName: true, spend: true, impressions: true, clicks: true, conversions: true, purchaseValue: true },
  });

  const agg = new Map<string, { name: string; spend: number; impr: number; clicks: number; bk: number; rev: number }>();
  for (const r of snaps) {
    const a = agg.get(r.metaCampaignId) ?? { name: r.campaignName, spend: 0, impr: 0, clicks: 0, bk: 0, rev: 0 };
    a.spend += Number(r.spend); a.impr += r.impressions; a.clicks += r.clicks; a.bk += r.conversions; a.rev += Number(r.purchaseValue);
    a.name = r.campaignName;
    agg.set(r.metaCampaignId, a);
  }
  const rows = [...agg.values()].sort((x, y) => y.spend - x.spend);

  console.log(`\nMeta Campaign Breakdown — ${hotel.name} (${hotel.metaAdAccountId}) — last ${days} days, ${rows.length} campaigns\n`);
  console.log("Campaign".padEnd(46), "Spend".padStart(12), "Impr".padStart(10), "Clicks".padStart(8), "CTR".padStart(7), "MetaBk".padStart(7), "MetaROAS".padStart(9));
  for (const a of rows) {
    const ctr = a.impr > 0 ? (a.clicks / a.impr * 100).toFixed(2) + "%" : "—";
    const roas = a.spend > 0 ? (a.rev / a.spend).toFixed(2) + "×" : "—";
    console.log(
      a.name.slice(0, 45).padEnd(46),
      ("Rs " + Math.round(a.spend).toLocaleString("en-IN")).padStart(12),
      a.impr.toLocaleString("en-IN").padStart(10),
      a.clicks.toLocaleString("en-IN").padStart(8),
      ctr.padStart(7),
      String(a.bk).padStart(7),
      roas.padStart(9),
    );
  }
}

main().catch((e) => { console.error("FAIL:", e instanceof Error ? e.message : e); process.exit(1); }).finally(() => prisma.$disconnect());
