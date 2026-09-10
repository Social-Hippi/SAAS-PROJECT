import "./load-env";
import { prisma } from "../lib/prisma";

// READ-ONLY: print the aggregated campaign-performance table exactly as the
// dashboard computes it (last 30 days), for verification.

const DAY_MS = 86_400_000;

async function main() {
  const daysArg = Number(process.argv[2]);
  const days = Number.isFinite(daysArg) ? daysArg : 30;
  const since = new Date(Date.now() - days * DAY_MS);

  const rows = await prisma.campaignPerformance.findMany({
    where: { date: { gte: since } },
    select: {
      campaignKey: true,
      campaignName: true,
      metaSpend: true,
      metaReportedConversions: true,
      realBookings: true,
      realBookingValue: true,
    },
  });

  const agg = new Map<
    string,
    { name: string; spend: number; metaConv: number; realB: number; realV: number }
  >();
  for (const r of rows) {
    const a =
      agg.get(r.campaignKey) ??
      { name: r.campaignName, spend: 0, metaConv: 0, realB: 0, realV: 0 };
    a.spend += Number(r.metaSpend);
    a.metaConv += r.metaReportedConversions;
    a.realB += r.realBookings;
    a.realV += Number(r.realBookingValue);
    agg.set(r.campaignKey, a);
  }

  console.log(`Campaign performance — last ${days} days (${rows.length} day-rows, ${agg.size} campaigns):\n`);
  console.log("Campaign".padEnd(48), "Spend".padStart(12), "MetaConv".padStart(9), "RealBk".padStart(7), "RealRev".padStart(10), "TrueROAS".padStart(9));
  const sorted = [...agg.values()].sort((a, b) => b.spend - a.spend);
  for (const a of sorted) {
    const roas = a.spend > 0 ? (a.realV / a.spend).toFixed(2) + "×" : "—";
    console.log(
      a.name.slice(0, 47).padEnd(48),
      a.spend.toFixed(2).padStart(12),
      String(a.metaConv).padStart(9),
      String(a.realB).padStart(7),
      a.realV.toFixed(2).padStart(10),
      roas.padStart(9),
    );
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
