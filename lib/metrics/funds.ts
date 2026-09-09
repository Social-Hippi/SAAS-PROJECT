import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { ok, unavailable, type MetricValue } from "@/lib/metrics/metric-value";

// Advertising funds, as the dashboard shows them.
//
// The honest position, stated once: Meta publishes no "money remaining" figure.
// getAdAccountFunding() derives headroom from a spend cap when one exists and
// returns null otherwise, so most accounts legitimately have no number here.
// This loader turns that null into `unavailable` with a reason the owner can act
// on — never into 0, which on a funds card reads as "you have run out".

export type AdFunds = {
  /** Spendable headroom, or an explanation of why there isn't a figure. */
  available: MetricValue<number>;
  currency: string;
  platformLabel: string;
  accountId: string | null;
  checkedAt: Date | null;
  /** Set when the last read failed, so a broken token isn't mistaken for "no cap". */
  lastError: string | null;
  reminder: {
    configured: boolean;
    email: string | null;
    thresholdMinor: number | null;
    enabled: boolean;
    lastCheckedAt: Date | null;
    lastTriggeredAt: Date | null;
    currentlyTriggered: boolean;
  };
};

const NO_ACCOUNT =
  "No advertising account is connected for this hotel, so there are no funds to report.";
const NO_FIGURE =
  "This advertising account doesn't publish a spendable balance. Setting a spend cap on the account would let us track and alert on remaining funds.";
const NEVER_CHECKED =
  "We haven't been able to read this advertising account's funds yet. The check runs once a day.";

export async function loadAdFunds(hotelClientId: string): Promise<AdFunds> {
  const [row, reminder] = await Promise.all([
    agencyScoped(prisma.adAccountBalance).findFirst({
      where: { hotelClientId, platform: "meta" },
      orderBy: { checkedAt: "desc" },
    }),
    agencyScoped(prisma.lowBalanceReminder).findFirst({ where: { hotelClientId } }),
  ]);

  const reminderState: AdFunds["reminder"] = {
    configured: Boolean(reminder),
    email: reminder?.email ?? null,
    thresholdMinor: reminder?.thresholdMinor ?? null,
    enabled: reminder?.enabled ?? false,
    lastCheckedAt: reminder?.lastCheckedAt ?? null,
    lastTriggeredAt: reminder?.lastTriggeredAt ?? null,
    currentlyTriggered: reminder?.triggered ?? false,
  };

  if (!row) {
    return {
      available: unavailable(NEVER_CHECKED),
      currency: "INR",
      platformLabel: "Meta Ads",
      accountId: null,
      checkedAt: null,
      lastError: null,
      reminder: reminderState,
    };
  }

  const available: MetricValue<number> =
    row.availableMinor != null
      ? ok(row.availableMinor / 100)
      : unavailable(row.lastError ? NO_ACCOUNT : NO_FIGURE);

  return {
    available,
    currency: row.currency ?? "INR",
    platformLabel: "Meta Ads",
    accountId: row.accountId,
    checkedAt: row.checkedAt,
    lastError: row.lastError,
    reminder: reminderState,
  };
}
