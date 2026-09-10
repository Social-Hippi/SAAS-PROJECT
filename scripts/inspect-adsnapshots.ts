// One-off: summarize AdSnapshot rows to sanity-check what Meta sync stored.
import "./load-env";
import { prisma } from "../lib/prisma";

async function main() {
  const agg = await prisma.adSnapshot.aggregate({
    _sum: { spend: true, impressions: true, clicks: true, conversions: true },
    _min: { date: true },
    _max: { date: true },
    _count: true,
  });
  console.log("rows:", agg._count);
  console.log("date range:", agg._min.date?.toISOString().slice(0, 10), "→", agg._max.date?.toISOString().slice(0, 10));
  console.log("total spend:", agg._sum.spend?.toString());
  console.log("total impressions:", agg._sum.impressions, "clicks:", agg._sum.clicks, "conversions:", agg._sum.conversions);

  const nonzero = await prisma.adSnapshot.count({ where: { spend: { gt: 0 } } });
  console.log("days with spend > 0:", nonzero);

  console.log("\nMost recent 12 days:");
  const recent = await prisma.adSnapshot.findMany({
    orderBy: { date: "desc" },
    take: 12,
    select: { date: true, spend: true, impressions: true, clicks: true, conversions: true, roas: true, pixelPurchases: true },
  });
  for (const r of recent) {
    console.log(
      r.date.toISOString().slice(0, 10),
      `spend=${r.spend}`,
      `impr=${r.impressions}`,
      `clicks=${r.clicks}`,
      `conv=${r.conversions}`,
      `roas=${r.roas}`,
      `pixelPurch=${r.pixelPurchases}`,
    );
  }

  console.log("\nTop 5 spend days:");
  const top = await prisma.adSnapshot.findMany({
    orderBy: { spend: "desc" },
    take: 5,
    select: { date: true, spend: true, impressions: true, clicks: true },
  });
  for (const r of top) {
    console.log(r.date.toISOString().slice(0, 10), `spend=${r.spend}`, `impr=${r.impressions}`, `clicks=${r.clicks}`);
  }
}

main().finally(() => prisma.$disconnect());
