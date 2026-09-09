import "server-only";

import { prisma } from "@/lib/prisma";
import { getTokenForApiCall } from "@/lib/token-access";
import { getAdAccountFunding } from "@/lib/meta";
import { formatCurrency } from "@/lib/format";
import { sendEmail, renderEmail, statTable, statRow, lead, p, esc } from "@/lib/email";

// ─────────────────────────────────────────────────────────────────────────────
// ADVERTISING FUNDS + the low-balance reminder.
//
// Two jobs, one pass, mirroring lib/budget-alerts.ts:
//   1. refresh each hotel's ad-account funding into AdAccountBalance
//   2. evaluate any LowBalanceReminder against the fresh figure and email once
//
// WHAT META ACTUALLY GIVES US, and why most hotels will see "Balance
// unavailable": there is no "prepaid rupees remaining" field in the Marketing
// API. `balance` is the amount DUE. The only real headroom figure is a spend cap
// minus lifetime spend, and only some accounts set a cap. getAdAccountFunding()
// derives availableMinor in that case and returns null otherwise — so this job
// stores a null, the dashboard says "Balance unavailable", and the reminder
// simply does not fire. None of those steps invents a number.
//
// FIRING ONCE, NOT DAILY. A reminder that crosses its threshold sets
// `triggered`, and stays quiet until funds go back above it. An account that
// sits low for a fortnight sends one email, not fourteen — the second one is
// noise and the fourteenth gets the sender marked as spam.
//
// Runs unscoped by design: it is a cron sweeping every agency, exactly like
// runBudgetAlerts. Every write is keyed by the hotel row it came from.
// ─────────────────────────────────────────────────────────────────────────────

export type RunBalanceResult = {
  hotelsChecked: number;
  balancesUpdated: number;
  remindersEvaluated: number;
  remindersTriggered: number;
  errors: { hotelName: string; error: string }[];
};

export async function runBalanceAlerts(
  opts: { agencyId?: string; force?: boolean } = {},
): Promise<RunBalanceResult> {
  const result: RunBalanceResult = {
    hotelsChecked: 0,
    balancesUpdated: 0,
    remindersEvaluated: 0,
    remindersTriggered: 0,
    errors: [],
  };

  const hotels = await prisma.hotelClient.findMany({
    where: {
      deletedAt: null,
      metaAdAccountId: { not: null },
      agency: { suspendedAt: null, ...(opts.agencyId ? { id: opts.agencyId } : {}) },
    },
    select: {
      id: true,
      name: true,
      agencyId: true,
      metaAdAccountId: true,
      agency: { select: { name: true } },
    },
  });

  for (const hotel of hotels) {
    result.hotelsChecked += 1;
    const accountId = hotel.metaAdAccountId!;

    // MetaToken is @@unique([hotelClientId]) — exactly one per hotel, and
    // hotelClientId is required, so there is no agency-level token to fall back
    // to. A hotel without a row simply has no Meta connection.
    const tokenRow = await prisma.metaToken.findUnique({
      where: { hotelClientId: hotel.id },
      select: { id: true },
    });

    if (!tokenRow) {
      await recordFailure(hotel, accountId, "No Meta connection for this hotel.");
      continue;
    }

    try {
      const secret = await getTokenForApiCall("meta_ads", tokenRow.id, {
        agencyId: hotel.agencyId,
        hotelClientId: hotel.id,
        source: "cron:/api/balance/check",
      });
      const funding = await getAdAccountFunding(secret.reveal(), accountId);

      await prisma.adAccountBalance.upsert({
        where: {
          hotelClientId_platform_accountId: {
            hotelClientId: hotel.id,
            platform: "meta",
            accountId: funding.accountId,
          },
        },
        create: {
          agencyId: hotel.agencyId,
          hotelClientId: hotel.id,
          platform: "meta",
          accountId: funding.accountId,
          availableMinor: funding.availableMinor,
          amountDueMinor: funding.amountDueMinor,
          amountSpentMinor: funding.amountSpentMinor,
          spendCapMinor: funding.spendCapMinor,
          currency: funding.currency,
          fundingType: funding.fundingType,
          checkedAt: new Date(),
          lastError: null,
        },
        update: {
          availableMinor: funding.availableMinor,
          amountDueMinor: funding.amountDueMinor,
          amountSpentMinor: funding.amountSpentMinor,
          spendCapMinor: funding.spendCapMinor,
          currency: funding.currency,
          fundingType: funding.fundingType,
          checkedAt: new Date(),
          lastError: null,
        },
      });
      result.balancesUpdated += 1;

      await evaluateReminder({
        hotelId: hotel.id,
        hotelName: hotel.name,
        agencyName: hotel.agency.name,
        availableMinor: funding.availableMinor,
        currency: funding.currency ?? "INR",
        force: opts.force ?? false,
        result,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error reading ad account.";
      await recordFailure(hotel, accountId, message);
      result.errors.push({ hotelName: hotel.name, error: message });
    }
  }

  return result;
}

/**
 * A failed read is RECORDED, not silently skipped.
 *
 * Without this, a broken token looks identical to an account with no cap — both
 * show "Balance unavailable" — and nobody ever finds out the check stopped
 * working. lastError is what separates the two on screen.
 */
async function recordFailure(
  hotel: { id: string; agencyId: string },
  accountId: string,
  message: string,
): Promise<void> {
  await prisma.adAccountBalance.upsert({
    where: {
      hotelClientId_platform_accountId: {
        hotelClientId: hotel.id,
        platform: "meta",
        accountId,
      },
    },
    create: {
      agencyId: hotel.agencyId,
      hotelClientId: hotel.id,
      platform: "meta",
      accountId,
      checkedAt: new Date(),
      lastError: message.slice(0, 500),
    },
    update: { checkedAt: new Date(), lastError: message.slice(0, 500) },
  });
}

async function evaluateReminder(args: {
  hotelId: string;
  hotelName: string;
  agencyName: string;
  availableMinor: number | null;
  currency: string;
  force: boolean;
  result: RunBalanceResult;
}): Promise<void> {
  const { hotelId, hotelName, agencyName, availableMinor, currency, force, result } = args;

  const reminder = await prisma.lowBalanceReminder.findUnique({
    where: { hotelClientId: hotelId },
  });
  if (!reminder || !reminder.enabled) return;

  result.remindersEvaluated += 1;

  // Always record that we looked, even when we could not judge — "last checked"
  // is the difference between a quiet reminder and a dead one.
  await prisma.lowBalanceReminder.update({
    where: { id: reminder.id },
    data: { lastCheckedAt: new Date() },
  });

  // No usable balance: nothing to compare. Deliberately NOT treated as zero,
  // which would fire the reminder for every account Meta declines to report on.
  if (availableMinor == null) return;

  const below = availableMinor < reminder.thresholdMinor;

  // Re-arm once funds recover, so the next dip notifies again.
  if (!below) {
    if (reminder.triggered) {
      await prisma.lowBalanceReminder.update({
        where: { id: reminder.id },
        data: { triggered: false },
      });
    }
    return;
  }

  // Already notified and still low — stay quiet until it recovers.
  if (reminder.triggered && !force) return;

  const sent = await sendLowBalanceEmail({
    to: reminder.email,
    hotelName,
    agencyName,
    availableMinor,
    thresholdMinor: reminder.thresholdMinor,
    currency,
  });

  await prisma.lowBalanceReminder.update({
    where: { id: reminder.id },
    data: {
      triggered: true,
      lastTriggeredAt: new Date(),
      lastTriggeredAtBalanceMinor: availableMinor,
    },
  });
  if (sent) result.remindersTriggered += 1;
}

async function sendLowBalanceEmail(input: {
  to: string;
  hotelName: string;
  agencyName: string;
  availableMinor: number;
  thresholdMinor: number;
  currency: string;
}): Promise<boolean> {
  const { to, hotelName, agencyName, availableMinor, thresholdMinor } = input;
  const available = formatCurrency(availableMinor / 100);
  const threshold = formatCurrency(thresholdMinor / 100);

  const html = renderEmail({
    heading: `${hotelName}: advertising funds are low`,
    preheader: `${available} of advertising headroom remains — below your ${threshold} reminder.`,
    bodyHtml: [
      lead(
        `The advertising account for <strong>${esc(hotelName)}</strong> has ${esc(available)} of spending headroom left, which is below the ${esc(threshold)} you asked to be told about.`,
      ),
      statTable(
        [
          statRow("Available", available),
          statRow("Your threshold", threshold),
          statRow("Hotel", esc(hotelName)),
          statRow("Managed by", esc(agencyName)),
        ].join(""),
      ),
      p(
        "When this runs out your ads stop running. Topping up or raising the account's spend cap will keep them live.",
      ),
      p(
        "You'll get this reminder once per dip — we won't email you again until the balance goes back above your threshold and falls below it another time.",
      ),
    ].join(""),
  });

  const res = await sendEmail({
    to,
    subject: `${hotelName}: advertising funds are running low`,
    html,
  });
  return res.ok;
}
