import "server-only";

import { searchStream, loginCustomerId } from "@/lib/google-ads";
import { getValidAccessToken, type Conn } from "@/lib/google-ads-sync";

// ─────────────────────────────────────────────────────────────────────────────
// Why Google Ads is not attributing booking revenue.
//
// READ-ONLY, on demand. The symptom in our own synced figures: over 30 days
// Aster shows 7,013.75 conversions worth ₹7,012.75 — a value of about ONE RUPEE
// each. That is what a conversion recorded with a default value looks like, not
// a booking worth ₹9,086. And 6,912 of those conversions come from local store
// visit campaigns, not from anything that produces a booking.
//
// The account itself holds the answer, so this asks it:
//
//   1. WHICH CONVERSION ACTIONS EXIST — is there one for a booking or purchase
//      at all, and what type and origin is it (website, store visit, calls)?
//   2. DOES IT CARRY A REAL VALUE — `default_value` with `always_use_default_value`
//      is the giveaway: every conversion recorded as the same amount, whatever
//      the guest actually paid.
//   3. WHAT IS BIDDING ON WHAT — `primary_for_goal` says which actions campaigns
//      optimise towards. A store visit marked primary means Google is told a
//      walk-in and a ₹9,000 booking are the same event.
//   4. WHICH ACTIONS ACTUALLY FIRED, and for how much, over the last 30 days.
//
// Each question is asked separately; a failure is kept per-section so one
// rejected field cannot blank the panel.
// ─────────────────────────────────────────────────────────────────────────────

export type ConversionAction = {
  name: string | null;
  category: string | null;
  type: string | null;
  origin: string | null;
  status: string | null;
  /** Campaigns bid towards this action when true. */
  primaryForGoal: boolean | null;
  /** Counted in the headline "Conversions" column when true. */
  includeInConversions: boolean | null;
  defaultValue: number | null;
  /** The giveaway: every conversion recorded at defaultValue, whatever was paid. */
  alwaysUseDefaultValue: boolean | null;
  defaultCurrency: string | null;
  countingType: string | null;
};

export type ConversionPerformance = {
  name: string | null;
  category: string | null;
  conversions: number;
  value: number;
};

export type ConversionSetup = {
  actions: ConversionAction[];
  /** Last 30 days, by action — which ones actually fire, and for how much. */
  performance: ConversionPerformance[];
  problems: string[];
};

type Row = Record<string, unknown>;
const get = (row: Row, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, k) => (acc == null ? acc : (acc as Row)[k]), row);
const str = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s ? s : null;
};
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0);

/** Reads the account's conversion tracking. Never throws; see `problems`. */
export async function loadConversionSetup(conn: Conn): Promise<ConversionSetup> {
  const problems: string[] = [];
  const accessToken = await getValidAccessToken(conn);
  const login = conn.loginCustomerId ?? loginCustomerId();
  const ask = async (label: string, query: string): Promise<Row[]> => {
    try {
      return (await searchStream(accessToken, conn.customerId, query, login)) as Row[];
    } catch (err) {
      problems.push(`${label} could not be read: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  };

  const actionRows = await ask(
    "The account's conversion actions",
    `SELECT conversion_action.name,
            conversion_action.category,
            conversion_action.type,
            conversion_action.origin,
            conversion_action.status,
            conversion_action.primary_for_goal,
            conversion_action.include_in_conversions_metric,
            conversion_action.counting_type,
            conversion_action.value_settings.default_value,
            conversion_action.value_settings.always_use_default_value,
            conversion_action.value_settings.default_currency_code
       FROM conversion_action`,
  );

  const perfRows = await ask(
    "Conversions by action, last 30 days",
    `SELECT segments.conversion_action_name,
            segments.conversion_action_category,
            metrics.all_conversions,
            metrics.all_conversions_value
       FROM campaign
      WHERE segments.date DURING LAST_30_DAYS`,
  );

  const actions: ConversionAction[] = actionRows.map((r) => ({
    name: str(get(r, "conversionAction.name")),
    category: str(get(r, "conversionAction.category")),
    type: str(get(r, "conversionAction.type")),
    origin: str(get(r, "conversionAction.origin")),
    status: str(get(r, "conversionAction.status")),
    primaryForGoal: bool(get(r, "conversionAction.primaryForGoal")),
    includeInConversions: bool(get(r, "conversionAction.includeInConversionsMetric")),
    defaultValue:
      get(r, "conversionAction.valueSettings.defaultValue") == null
        ? null
        : num(get(r, "conversionAction.valueSettings.defaultValue")),
    alwaysUseDefaultValue: bool(get(r, "conversionAction.valueSettings.alwaysUseDefaultValue")),
    defaultCurrency: str(get(r, "conversionAction.valueSettings.defaultCurrencyCode")),
    countingType: str(get(r, "conversionAction.countingType")),
  }));

  const byName = new Map<string, ConversionPerformance>();
  for (const r of perfRows) {
    const name = str(get(r, "segments.conversionActionName")) ?? "(unnamed)";
    const row = byName.get(name) ?? {
      name,
      category: str(get(r, "segments.conversionActionCategory")),
      conversions: 0,
      value: 0,
    };
    row.conversions += num(get(r, "metrics.allConversions"));
    row.value += num(get(r, "metrics.allConversionsValue"));
    byName.set(name, row);
  }

  return {
    actions: actions.sort(
      (a, b) =>
        Number(b.primaryForGoal ?? false) - Number(a.primaryForGoal ?? false) ||
        (a.name ?? "").localeCompare(b.name ?? ""),
    ),
    performance: [...byName.values()].sort((a, b) => b.conversions - a.conversions),
    problems,
  };
}

/**
 * The reading a person would give this account, in their terms.
 *
 * Stated as findings, not instructions: what is true, and what it means for the
 * numbers. Empty when nothing is wrong.
 */
export function readConversionSetup(setup: ConversionSetup): string[] {
  const found: string[] = [];
  const live = setup.actions.filter((a) => a.status === "ENABLED");

  const fixedValue = live.filter((a) => a.alwaysUseDefaultValue === true);
  if (fixedValue.length > 0) {
    found.push(
      `${fixedValue.length} live conversion action(s) record the SAME value every time ` +
        `(${fixedValue.map((a) => `${a.name ?? "unnamed"} = ${a.defaultValue ?? "?"}`).join(", ")}). ` +
        "A booking worth ₹9,000 and one worth ₹900 are counted as the same amount.",
    );
  }

  const purchase = live.filter(
    (a) => a.category === "PURCHASE" || /purchase|booking|revenue/i.test(a.name ?? ""),
  );
  if (purchase.length === 0) {
    found.push(
      "No live conversion action is a purchase or booking. Nothing in this account " +
        "records that a booking happened, so Google cannot attribute booking revenue at all.",
    );
  }

  const primaryStoreVisits = live.filter(
    (a) => a.primaryForGoal === true && /STORE_VISIT|STORE_SALE/.test(a.category ?? ""),
  );
  if (primaryStoreVisits.length > 0) {
    found.push(
      `Store visits are a PRIMARY goal (${primaryStoreVisits
        .map((a) => a.name ?? "unnamed")
        .join(", ")}), so campaigns bid towards them as if a walk-in equalled a booking.`,
    );
  }

  const noPrimary = live.filter((a) => a.primaryForGoal === true).length === 0;
  if (noPrimary && live.length > 0) {
    found.push("No live conversion action is marked primary, so bidding has nothing to optimise towards.");
  }

  return found;
}
