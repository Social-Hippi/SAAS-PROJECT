import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScoped, agencyScopedFor } from "@/lib/tenant";

// ─────────────────────────────────────────────────────────────────────────────
// Canonical PAID AD SPEND service (Phase 0 — measurement integrity).
//
// One place that answers "how much did this hotel spend on ads in this window,
// per platform?" so no caller has to remember which table holds what. Before
// this module, every KPI summed `AdSnapshot.spend` directly and called the
// result "ad spend" — which silently meant META-ONLY spend, while the revenue
// it was divided by came from every channel (see calculateROAS / computeKpis).
//
// RULES ENCODED HERE (each one was a real bug source):
//
//   • META spend comes from `AdSnapshot` ONLY (account-level daily rows), with
//     `archived: false`. `AdCampaignSnapshot` holds the SAME spend broken out by
//     campaign — summing both double-counts. Never do it.
//   • GOOGLE spend comes from `GoogleAdsCampaignSnapshot` (campaign-level daily
//     rows). There is no account-level Google table; summing the campaign rows
//     IS the account total. Note this model has no `archived` column, so there
//     is no archived filter to apply (see the Phase 0 audit).
//   • CURRENCY is not assumed away. A combined total is produced only when the
//     platforms are safely combinable; otherwise `total` is null and callers
//     must show the platforms separately rather than adding rupees to dollars.
//
// Phase 0 explicitly does NOT split Meta spend across facebook/instagram or any
// other sub-platform: Meta reports account-level spend and any split would be an
// invention. Meta spend is Meta spend. Granular platform/ad/click attribution
// arrives in Phase 1.
//
// No schema changes: every field read here already exists.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The currency every stored money value is assumed to be in. The whole app
 * formats as INR (lib/format.ts) and budgets are stored in paise, so INR is the
 * reporting currency, not a guess.
 */
export const REPORTING_CURRENCY = "INR";

export type PlatformSpend = {
  spend: number;
  /**
   * ISO-4217 code when we can establish it from stored data, else null
   * ("unknown", NOT "assumed wrong"). See the currency note on getSpendByPlatform.
   */
  currency: string | null;
};

export type SpendByPlatform = {
  /** Meta ad spend in the window (AdSnapshot, archived excluded). */
  meta: number;
  /** Google Ads spend in the window (GoogleAdsCampaignSnapshot). */
  google: number;
  /**
   * meta + google — or NULL when the platforms cannot be safely added because a
   * platform reports in a currency other than REPORTING_CURRENCY. Callers must
   * treat null as "combined figure unavailable", never as zero.
   */
  total: number | null;
  /** The currency `meta`, `google` and `total` are expressed in. */
  currency: string;
  /** True when a combined total/ROAS would mix incompatible currencies. */
  mixedCurrency: boolean;
  platforms: {
    meta: PlatformSpend;
    google: PlatformSpend;
  };
};

const num = (d: { toString(): string } | null | undefined): number =>
  d == null ? 0 : Number(d);

/** A Prisma delegate wrapper — either session-scoped or explicit-agency scoped. */
type Scoper = <D>(model: D) => D;

/**
 * Shared implementation. `scoped` injects the tenant filter, so this function
 * never has to know whether the caller has a Clerk session (agencyScoped) or an
 * agencyId resolved from a share token / cron loop (agencyScopedFor).
 */
async function computeSpendByPlatform(
  scoped: Scoper,
  hotelClientIds: string[],
  startDate: Date,
  endDate: Date,
): Promise<SpendByPlatform> {
  if (hotelClientIds.length === 0) {
    return {
      meta: 0,
      google: 0,
      total: 0,
      currency: REPORTING_CURRENCY,
      mixedCurrency: false,
      platforms: {
        meta: { spend: 0, currency: null },
        google: { spend: 0, currency: null },
      },
    };
  }

  const hotelFilter =
    hotelClientIds.length === 1
      ? { hotelClientId: hotelClientIds[0] }
      : { hotelClientId: { in: hotelClientIds } };

  const [metaAgg, googleAgg, googleConns] = await Promise.all([
    // META — account-level only. NEVER add AdCampaignSnapshot here.
    scoped(prisma.adSnapshot).aggregate({
      where: { ...hotelFilter, archived: false, date: { gte: startDate, lte: endDate } },
      _sum: { spend: true },
    }),
    // GOOGLE — campaign-level rows summed to the account total.
    scoped(prisma.googleAdsCampaignSnapshot).aggregate({
      where: { ...hotelFilter, date: { gte: startDate, lte: endDate } },
      _sum: { spend: true },
    }),
    // Google's account currency is the ONE currency we actually persist
    // (GoogleAdsConnection.currencyCode, set at account selection).
    scoped(prisma.googleAdsConnection).findMany({
      where: hotelFilter,
      select: { currencyCode: true },
    }),
  ]);

  const metaSpend = num(metaAgg._sum.spend);
  const googleSpend = num(googleAgg._sum.spend);

  // Distinct KNOWN Google currencies across the hotels in scope. More than one
  // means the rollup itself is mixed, even if each is individually fine.
  const googleCurrencies = [
    ...new Set(
      googleConns
        .map((c) => (c.currencyCode ?? "").trim().toUpperCase())
        .filter((c) => c.length > 0),
    ),
  ];
  const googleCurrency = googleCurrencies.length === 1 ? googleCurrencies[0] : null;

  // META currency is NOT persisted anywhere. It is available from the Graph API
  // (lib/meta.ts getAdAccounts returns `currency`) but no column stores it, and
  // Phase 0 adds no columns. So it reads as null = "unknown", and unknown is
  // treated as the reporting currency — which is exactly what every existing KPI
  // already assumed implicitly. Making it explicit here is the point: when Meta
  // currency does get persisted, this is the single line that has to change.
  const metaCurrency: string | null = null;

  // A combined total is UNSAFE only when we can positively establish that a
  // platform with non-zero spend reports in something other than the reporting
  // currency (or when the hotels in scope disagree with each other). Unknown is
  // not treated as incompatible — that would remove the combined figure for
  // every hotel connected before currencyCode was captured, a regression rather
  // than a correction.
  const googleIsForeign =
    googleSpend > 0 &&
    (googleCurrencies.length > 1 ||
      (googleCurrency !== null && googleCurrency !== REPORTING_CURRENCY));

  const mixedCurrency = googleIsForeign;

  return {
    meta: metaSpend,
    google: googleSpend,
    total: mixedCurrency ? null : metaSpend + googleSpend,
    currency: REPORTING_CURRENCY,
    mixedCurrency,
    platforms: {
      meta: { spend: metaSpend, currency: metaCurrency },
      google: { spend: googleSpend, currency: googleCurrency },
    },
  };
}

/**
 * Paid ad spend for ONE hotel, scoped to the signed-in agency (Clerk session, or
 * a runWithAgencyScope override). Use in authenticated server components,
 * actions and route handlers.
 */
export function getSpendByPlatform(
  hotelClientId: string,
  startDate: Date,
  endDate: Date,
): Promise<SpendByPlatform> {
  return computeSpendByPlatform(agencyScoped, [hotelClientId], startDate, endDate);
}

/**
 * Paid ad spend for ONE hotel with an EXPLICIT agencyId — for code paths with no
 * session (the public /share report, cron jobs), mirroring agencyScopedFor.
 */
export function getSpendByPlatformFor(
  agencyId: string,
  hotelClientId: string,
  startDate: Date,
  endDate: Date,
): Promise<SpendByPlatform> {
  const scoped: Scoper = (model) => agencyScopedFor(agencyId, model);
  return computeSpendByPlatform(scoped, [hotelClientId], startDate, endDate);
}

/**
 * Paid ad spend summed across MANY hotels of one agency — the agency rollup.
 * An empty hotel list yields zeros (and a safe zero total), never a full-agency
 * unscoped read.
 */
export function getSpendByPlatformForHotels(
  agencyId: string,
  hotelClientIds: string[],
  startDate: Date,
  endDate: Date,
): Promise<SpendByPlatform> {
  const scoped: Scoper = (model) => agencyScopedFor(agencyId, model);
  return computeSpendByPlatform(scoped, hotelClientIds, startDate, endDate);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — shared ROAS arithmetic so every caller divides the same way.
// Exported separately (no DB, no session) so they are directly unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A ROAS ratio, or null when it cannot be computed. Null — never 0 — is the
 * "no denominator" answer, so the UI renders "—" instead of a misleading 0×.
 * A null `spend` (currencies not combinable) also yields null.
 */
export function safeRoas(revenue: number, spend: number | null): number | null {
  if (spend == null || !Number.isFinite(spend) || spend <= 0) return null;
  if (!Number.isFinite(revenue)) return null;
  return revenue / spend;
}

/**
 * The combined PAID spend to divide by, or null when the platforms cannot be
 * safely combined. Thin wrapper so call sites read as intent, not field access.
 */
export function combinedPaidSpend(spend: SpendByPlatform): number | null {
  return spend.total;
}
