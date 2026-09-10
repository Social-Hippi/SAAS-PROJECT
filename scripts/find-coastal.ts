import "./load-env";
import { prisma } from "../lib/prisma";

async function main() {
  const agencies = await prisma.agency.findMany({
    select: { id: true, name: true, plan: true, _count: { select: { hotelClients: true } } },
    orderBy: { createdAt: "asc" },
  });
  for (const a of agencies) {
    console.log(`${a.id}  ${a.name}  plan=${a.plan}  hotels=${a._count.hotelClients}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
