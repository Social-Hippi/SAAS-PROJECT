import "./load-env";
import { prisma } from "../lib/prisma";

// DEV ONLY: marks every agency's subscription active (Agency plan, no limits) so
// the subscription-gated dashboard is usable without going through Razorpay.
// Revert by running the real Razorpay checkout flow, or set a status back manually.
//   npm run dev:activate

async function main() {
  const result = await prisma.agency.updateMany({
    data: { subscriptionStatus: "active", plan: "agency" },
  });
  console.log(`Activated ${result.count} agency/agencies (plan = agency).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
