import "server-only";

import { searchStream, loginCustomerId } from "@/lib/google-ads";
import { getValidAccessToken, type Conn } from "@/lib/google-ads-sync";

// ─────────────────────────────────────────────────────────────────────────────
// Why Google reports taps on a call button but no connected calls.
//
// READ-ONLY, and on demand. The Google Ads integration never edits ad config —
// this only asks questions, and only when someone opens the check.
//
// It answers the three that decide the diagnosis:
//
//   1. Is call reporting on for the ACCOUNT? Google's forwarding number is what
//      lets it see a call at all, and the switch lives on the customer, not the
//      campaign. If it is off, no campaign reports connected calls.
//   2. Which campaigns actually carry a CALL ASSET, and is it enabled? A
//      campaign with no call asset can still show "taps" (see below), and no
//      call asset means nothing to forward.
//   3. WHAT KIND of taps are they? `metrics.clicks` segmented by click type
//      separates a tap on a call asset from a call on a LOCATION asset, which
//      Google counts under a different click type and never reports as a
//      connected call. Aster's Coffeeberry campaigns show taps with no connected
//      calls, and this is what tells us whether that is a misconfiguration or
//      simply a different kind of click.
//
// Each question is asked separately and failures are kept per-section: one
// rejected field must not blank the whole check.
// ─────────────────────────────────────────────────────────────────────────────

export type CallAsset = {
  phoneNumber: string | null;
  countryCode: string | null;
  /** Google's own enum, e.g. DISABLED or USE_ACCOUNT_LEVEL_CALL_CONVERSION_ACTION. */
  conversionReportingState: string | null;
  /** ENABLED | PAUSED | REMOVED, as Google reports it. */
  status: string | null;
  /** True when the asset is set on the account, so it applies to every campaign. */
  accountLevel: boolean;
};

export type CampaignCallSetup = {
  campaignId: string;
  campaignName: string;
  callAssets: CallAsset[];
  /** Clicks by Google click type over the window — only call-ish types. */
  tapsByType: { type: string; clicks: number }[];
  /** metrics.phone_calls over the window; null when Google reported none. */
  connectedCalls: number | null;
};

export type CallSetup = {
  customerId: string;
  /** customer.call_reporting_setting.call_reporting_enabled — the forwarding-number switch. */
  accountCallReporting: boolean | null;
  accountCallConversionReporting: boolean | null;
  campaigns: CampaignCallSetup[];
  /** Account-level call assets, which apply to every campaign. */
  accountCallAssets: CallAsset[];
  /** Whatever could not be read, in the operator's words. Never a blank panel. */
  problems: string[];
};

const str = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s ? s : null;
};
const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0);

/** Click types Google counts as a call of some kind. */
const CALL_CLICK_TYPES = new Set([
  "CALLS",
  "MOBILE_CALL_TRACKING",
  "LOCATION_FORMAT_CALL",
  "CALL_TRACKING",
]);

type Row = Record<string, unknown>;
const get = (row: Row, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, k) => (acc == null ? acc : (acc as Row)[k]), row);

function readAsset(row: Row, accountLevel: boolean): CallAsset {
  return {
    phoneNumber: str(get(row, "asset.callAsset.phoneNumber")),
    countryCode: str(get(row, "asset.callAsset.countryCode")),
    conversionReportingState: str(get(row, "asset.callAsset.callConversionReportingState")),
    status: str(get(row, accountLevel ? "customerAsset.status" : "campaignAsset.status")),
    accountLevel,
  };
}

/**
 * Reads the account's call setup for the last 30 days. Never throws: anything it
 * could not read comes back in `problems`, so the panel always says something.
 */
export async function loadCallSetup(conn: Conn): Promise<CallSetup> {
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

  // 1 · The account switch that turns on Google forwarding numbers.
  const customerRows = await ask(
    "The account's call reporting setting",
    `SELECT customer.id,
            customer.call_reporting_setting.call_reporting_enabled,
            customer.call_reporting_setting.call_conversion_reporting_enabled
       FROM customer`,
  );
  const cust = customerRows[0];
  const boolOrNull = (v: unknown) => (typeof v === "boolean" ? v : null);

  // 2 · Call assets, per campaign and on the account.
  const campaignAssetRows = await ask(
    "Call assets on campaigns",
    `SELECT campaign.id, campaign.name, campaign_asset.status,
            asset.call_asset.phone_number, asset.call_asset.country_code,
            asset.call_asset.call_conversion_reporting_state
       FROM campaign_asset
      WHERE campaign_asset.field_type = 'CALL'`,
  );
  const accountAssetRows = await ask(
    "Call assets on the account",
    `SELECT customer_asset.status,
            asset.call_asset.phone_number, asset.call_asset.country_code,
            asset.call_asset.call_conversion_reporting_state
       FROM customer_asset
      WHERE customer_asset.field_type = 'CALL'`,
  );

  // 3 · What kind of taps, and how many calls connected.
  const clickRows = await ask(
    "Clicks by type",
    `SELECT campaign.id, campaign.name, segments.click_type, metrics.clicks
       FROM campaign
      WHERE segments.date DURING LAST_30_DAYS`,
  );
  const phoneRows = await ask(
    "Connected calls",
    `SELECT campaign.id, metrics.phone_calls
       FROM campaign
      WHERE segments.date DURING LAST_30_DAYS`,
  );

  const byCampaign = new Map<string, CampaignCallSetup>();
  const campaign = (id: string, name: string): CampaignCallSetup => {
    let c = byCampaign.get(id);
    if (!c) {
      c = { campaignId: id, campaignName: name, callAssets: [], tapsByType: [], connectedCalls: null };
      byCampaign.set(id, c);
    }
    if (name && c.campaignName !== name) c.campaignName = name;
    return c;
  };

  for (const r of campaignAssetRows) {
    const id = str(get(r, "campaign.id"));
    if (!id) continue;
    campaign(id, str(get(r, "campaign.name")) ?? "(unnamed)").callAssets.push(readAsset(r, false));
  }

  const taps = new Map<string, Map<string, number>>();
  for (const r of clickRows) {
    const id = str(get(r, "campaign.id"));
    const type = str(get(r, "segments.clickType"))?.toUpperCase();
    if (!id || !type || !CALL_CLICK_TYPES.has(type)) continue;
    const clicks = num(get(r, "metrics.clicks"));
    if (clicks === 0) continue;
    campaign(id, str(get(r, "campaign.name")) ?? "(unnamed)");
    const t = taps.get(id) ?? new Map<string, number>();
    t.set(type, (t.get(type) ?? 0) + clicks);
    taps.set(id, t);
  }

  for (const r of phoneRows) {
    const id = str(get(r, "campaign.id"));
    if (!id) continue;
    const calls = num(get(r, "metrics.phoneCalls"));
    if (calls === 0) continue;
    const c = byCampaign.get(id);
    if (c) c.connectedCalls = (c.connectedCalls ?? 0) + calls;
  }

  for (const [id, t] of taps) {
    const c = byCampaign.get(id);
    if (c) c.tapsByType = [...t].map(([type, clicks]) => ({ type, clicks })).sort((a, b) => b.clicks - a.clicks);
  }

  return {
    customerId: conn.customerId,
    accountCallReporting: boolOrNull(get(cust ?? {}, "customer.callReportingSetting.callReportingEnabled")),
    accountCallConversionReporting: boolOrNull(
      get(cust ?? {}, "customer.callReportingSetting.callConversionReportingEnabled"),
    ),
    accountCallAssets: accountAssetRows.map((r) => readAsset(r, true)),
    campaigns: [...byCampaign.values()].sort(
      (a, b) =>
        b.tapsByType.reduce((n, t) => n + t.clicks, 0) - a.tapsByType.reduce((n, t) => n + t.clicks, 0) ||
        a.campaignName.localeCompare(b.campaignName),
    ),
    problems,
  };
}

/** What each call click type means, in the operator's terms. */
export const CLICK_TYPE_MEANING: Record<string, string> = {
  CALLS: "Tap on a call button in the ad",
  MOBILE_CALL_TRACKING: "Tap to call on mobile",
  LOCATION_FORMAT_CALL: "Call from a location asset — Google never reports these as connected calls",
  CALL_TRACKING: "Number dialled by hand, not a tap",
};
