import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import { CLICK_TYPE_MEANING } from "@/lib/google-ads-call-setup";

// ─────────────────────────────────────────────────────────────────────────────
// Why Google reports taps on a call button but no connected calls.
//
// Aster's Coffeeberry search campaign shows 36 taps and no connected calls over
// three weeks, while 3Hills — in the SAME account — connects 43 of 100. This
// check asks Google the three questions that separate a misconfiguration from a
// different kind of click, and it only ever asks.
// ─────────────────────────────────────────────────────────────────────────────

const SETUP = readCode("lib/google-ads-call-setup.ts");
const PANEL = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/CallSetupPanel.tsx");
const PAGE = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/page.tsx");
const ADS = readCode("lib/google-ads.ts");

describe("1. it only ever reads", () => {
  test("no mutate anywhere in the check or the client", () => {
    for (const src of [SETUP, ADS]) {
      expect(src).not.toMatch(/:mutate|googleAds:mutate|mutateOperations/);
    }
    // Every Google call this check makes is a search.
    const calls = SETUP.match(/searchStream\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
  });

  test("every query is a SELECT", () => {
    const queries = SETUP.match(/`SELECT[\s\S]*?`/g) ?? [];
    // account setting · campaign assets · account assets · click types · connected calls
    expect(queries.length).toBe(5);
    for (const q of queries) {
      expect(q).not.toMatch(/\b(UPDATE|INSERT|DELETE|CREATE|SET)\b/);
    }
  });
});

describe("2. it asks the questions that decide the diagnosis", () => {
  test("the account switch that turns on Google forwarding numbers", () => {
    // customer.proto: CallReportingSetting.call_reporting_enabled.
    expect(SETUP).toMatch(/customer\.call_reporting_setting\.call_reporting_enabled/);
    expect(SETUP).toMatch(/customer\.call_reporting_setting\.call_conversion_reporting_enabled/);
  });

  test("call assets, on campaigns AND on the account", () => {
    // An account-level asset applies to every campaign, so a campaign showing
    // none may still have one.
    expect(SETUP).toMatch(/FROM campaign_asset\s+WHERE campaign_asset\.field_type = 'CALL'/);
    expect(SETUP).toMatch(/FROM customer_asset\s+WHERE customer_asset\.field_type = 'CALL'/);
    // asset_types.proto: CallAsset fields.
    expect(SETUP).toMatch(/asset\.call_asset\.phone_number/);
    expect(SETUP).toMatch(/asset\.call_asset\.call_conversion_reporting_state/);
  });

  test("what KIND of taps they are, beside the connected calls", () => {
    expect(SETUP).toMatch(/segments\.click_type, metrics\.clicks/);
    expect(SETUP).toMatch(/metrics\.phone_calls/);
  });

  test("a location-asset call is explained, since it never connects", () => {
    // The likeliest innocent explanation for taps with no connected calls.
    expect(CLICK_TYPE_MEANING.LOCATION_FORMAT_CALL).toMatch(/never reports these as connected/);
    expect(CLICK_TYPE_MEANING.CALL_TRACKING).toMatch(/dialled by hand/);
    expect(CLICK_TYPE_MEANING.CALLS).toMatch(/call button/);
  });
});

describe("3. one failure never blanks the panel", () => {
  test("each query's failure is kept as a problem, not thrown", () => {
    expect(SETUP).toMatch(/problems\.push\(/);
    const ask = SETUP.slice(SETUP.indexOf("const ask = async"));
    expect(ask.slice(0, ask.indexOf("};"))).toMatch(/catch \(err\)/);
  });

  test("the panel shows whatever could not be read", () => {
    expect(PANEL).toMatch(/setup\.problems\.length > 0/);
    expect(PANEL).toMatch(/could not be read/);
  });

  test("a check that fails outright says so instead of vanishing", () => {
    expect(PAGE).toMatch(/\.catch\(\(err\) => \{/);
    expect(PAGE).toMatch(/could not be read from Google Ads just now/);
  });
});

describe("4. it costs Google calls only when asked for", () => {
  test("nothing runs unless the check is opened", () => {
    expect(PAGE).toMatch(/sp\.gcall === "1" && gads\?\.customerId\s*\?\s*await loadCallSetup\(/);
    expect(PAGE).toMatch(/gcall=1#google-ads/);
  });

  test("the panel can be closed again", () => {
    expect(PANEL).toMatch(/closeHref/);
  });
});
