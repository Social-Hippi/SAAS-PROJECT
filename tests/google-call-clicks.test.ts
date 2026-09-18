import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// Google Ads "clicks to call" — taps on a call button, beside calls connected.
//
// Two Google figures, deliberately never added:
//
//   clicks to call    taps on the call button, whether or not the call went
//                     through (clicks segmented by click type)
//   calls connected   calls received through Google's forwarding number
//                     (metrics.phone_calls), including hand-dialled ones
//
// A guest who taps and connects is in both, so a total would count them twice.
// ─────────────────────────────────────────────────────────────────────────────

const SYNC = readCode("lib/google-ads-sync.ts");
const LOADER = readCode("lib/metrics/share-views.ts");
const REPORT = readCode("components/dashboard/ShareReport.tsx");
const SCHEMA = readCode("prisma/schema.prisma");

describe("1. which clicks count as a tap to call", () => {
  test("the sync segments clicks by click type", () => {
    expect(SYNC).toMatch(/segments\.click_type,\s*metrics\.clicks/);
  });

  test("the three call click types from Google's enum, and only those", () => {
    // ClickTypeEnum, Google Ads API v24:
    //   CALLS = 6                 "Phone calls"
    //   MOBILE_CALL_TRACKING = 17 "Mobile phone calls"
    //   LOCATION_FORMAT_CALL = 10 "Call"
    expect(SYNC).toMatch(
      /new Set\(\["CALLS", "MOBILE_CALL_TRACKING", "LOCATION_FORMAT_CALL"\]\)/,
    );
  });

  test("a manually dialled call is not a tap", () => {
    // CALL_TRACKING = 5, "Manually dialed phone calls": someone typed the number.
    const set = SYNC.slice(SYNC.indexOf("CALL_CLICK_TYPES = new Set"));
    expect(set.slice(0, set.indexOf(")"))).not.toMatch(/"CALL_TRACKING"/);
  });
});

describe("2. a real zero and a gap are stored differently", () => {
  test("a query that ran writes 0 for a campaign-day with no call taps", () => {
    // Segmenting by click type makes Google omit the day entirely, which would
    // otherwise be indistinguishable from a failed query.
    expect(SYNC).toMatch(/callClicksQueried = true;/);
    expect(SYNC).toMatch(
      /callClicks: callClicksQueried\s*\?\s*Math\.round\(callClicksByKey\.get\(`\$\{campaignId\}\|\$\{dateStr\}`\) \?\? 0\)\s*:\s*null/,
    );
  });

  test("the success flag is set only after every row was read", () => {
    const body = SYNC.slice(SYNC.indexOf("const clickRows = await searchStream("));
    const flag = body.indexOf("callClicksQueried = true;");
    expect(flag).toBeGreaterThan(body.indexOf("for (const r of clickRows)"));
    expect(flag).toBeLessThan(body.indexOf("} catch (err)"));
  });

  test("the column is nullable, so a gap can be stored as one", () => {
    expect(SCHEMA).toMatch(/callClicks\s+Int\?/);
  });
});

describe("3. the report keeps the two Google figures apart", () => {
  test("clicks to call is its own metric, read from its own column", () => {
    expect(LOADER).toMatch(/google\._count\.callClicks > 0\s*\?\s*ok\(num\(google\._sum\.callClicks\)\)/);
  });

  test("never summed with calls connected", () => {
    for (const src of [LOADER, SYNC, REPORT]) {
      expect(src).not.toMatch(/callClicks\s*\+\s*[^)\n]*phoneCalls/);
      expect(src).not.toMatch(/phoneCalls\s*\+\s*[^)\n]*callClicks/);
      expect(src).not.toMatch(/googleCallClicks[^;\n]*\+[^;\n]*googleCalls/);
    }
  });

  test("no figure yet renders not_traceable, never 0", () => {
    expect(LOADER).toMatch(/notTraceable<number>\(GOOGLE_CALL_CLICKS_NOT_RETRIEVED\)/);
    expect(LOADER).toMatch(/It is not a zero/);
  });

  test("a window reaching past the sync's 30 days says how much it covers", () => {
    expect(LOADER).toMatch(/google\._count\.callClicks < google\._count\._all/);
    expect(LOADER).toMatch(/covers only part of it/);
    expect(LOADER).toMatch(/googleCallClicks: callClicksNote \?\? googleNote/);
  });

  test("the two Google tiles sit side by side, labelled apart", () => {
    expect(REPORT).toMatch(/<Group title="Calls from ads" columns=\{2\}>/);
    expect(REPORT).toMatch(/label="Google Ads · clicks to call"/);
    expect(REPORT).toMatch(/label="Google Ads · calls connected"/);
    expect(REPORT).toMatch(/value=\{data\.ads\.googleCallClicks\}/);
  });

  test("the caption tells the hotel a tap is not a connected call", () => {
    expect(LOADER).toMatch(/googleCallClicks:\s*"Taps on the call button/);
    expect(LOADER).toMatch(/whether or not the call went through/);
  });
});
