import "./load-env";
import Razorpay from "razorpay";
import { PLAN_ORDER, PLANS, type PlanKey } from "../lib/razorpay-plans";

// Creates the three monthly subscription Plans in your Razorpay account, then
// prints the env lines to paste into .env.local. Idempotent: plans are tagged
// with notes.hoteltrack_plan and a matching plan (same key + amount) is reused on
// re-runs instead of creating duplicates.
//
// Requires RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET (test mode, rzp_test_…) in env.
//   npm run setup:razorpay

const ENV_VAR: Record<PlanKey, string> = {
  starter: "RAZORPAY_PLAN_STARTER",
  growth: "RAZORPAY_PLAN_GROWTH",
  agency: "RAZORPAY_PLAN_AGENCY",
};

type PlanEntity = {
  id: string;
  item?: { amount?: number };
  notes?: Record<string, string | number>;
};

async function main() {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    console.error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET must be set (in .env.local).");
    process.exit(1);
  }
  if (!key_id.startsWith("rzp_test_")) {
    console.warn(
      "⚠ RAZORPAY_KEY_ID does not look like a test key (rzp_test_…). " +
        "This script is meant for test mode.",
    );
  }

  const rzp = new Razorpay({ key_id, key_secret });
  const existing = (await rzp.plans.all({ count: 100 })).items as unknown as PlanEntity[];
  const lines: string[] = [];

  for (const key of PLAN_ORDER) {
    const plan = PLANS[key];

    let match = existing.find(
      (p) => p.notes?.hoteltrack_plan === key && p.item?.amount === plan.pricePaise,
    );
    if (match) {
      console.log(`Reusing ${plan.name} plan: ${match.id}`);
    } else {
      const created = (await rzp.plans.create({
        period: "monthly",
        interval: 1,
        item: { name: `HotelTrack ${plan.name}`, amount: plan.pricePaise, currency: "INR" },
        notes: { hoteltrack_plan: key },
      })) as unknown as PlanEntity;
      console.log(`Created ${plan.name} plan (₹${plan.pricePaise / 100}/mo): ${created.id}`);
      match = created;
    }

    lines.push(`${ENV_VAR[key]}="${match.id}"`);
  }

  console.log("\n── Paste these into your .env.local ──\n");
  console.log(lines.join("\n"));
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
