import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import { campaignSnapshotData } from "@/lib/meta-campaign-row";

// ─────────────────────────────────────────────────────────────────────────────
// ONE campaign-snapshot write, not three.
//
// The same upsert was hand-written in three places — the daily cron route,
// lib/meta-sync.ts and lib/backfill.ts — and two of them wrote SEVEN columns
// where the third wrote fifteen, dropping objective, reach, messagingStarted,
// leads, calls and the three delivery rankings.
//
// Nothing errored. Prisma's `update` only touches supplied fields, so rows the
// full mapper had already written kept their values while every row the cron
// CREATED was born with six columns null. In production on Aster Holidays that
// read as messaging conversations present through 2026-09-10 — the last day
// someone pressed "Sync now", which routes through meta-sync.ts — and null every
// day after, while spend and clicks arrived perfectly. The client's report then
// said "Meta has not reported campaign-level results" about data Meta HAD
// reported and we had discarded on write.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE = readCode("app/api/meta/sync/route.ts");
const SYNC = readCode("lib/meta-sync.ts");
const BACKFILL = readCode("lib/backfill.ts");

const row = {
  date: "2026-09-16",
  campaignId: "c1",
  campaignName: "SH|{CBH}| Sales campaign",
  objective: null,
  spend: 1234.5,
  impressions: 8070,
  clicks: 46,
  conversions: 2,
  purchaseValue: 7475,
  reach: 4544,
  messagingStarted: 12,
  calls: 3,
  leads: 1,
  qualityRanking: "AVERAGE",
  engagementRateRanking: null,
  conversionRateRanking: null,
};

describe("the campaign snapshot mapper", () => {
  test("carries every column the table has", () => {
    const d = campaignSnapshotData(row, "act_1");
    // The six that were being dropped are the point of this test.
    expect(d.messagingStarted).toBe(12);
    expect(d.calls).toBe(3);
    expect(d.leads).toBe(1);
    expect(d.reach).toBe(4544);
    expect(d.qualityRanking).toBe("AVERAGE");
    expect(d.engagementRateRanking).toBeNull();
  });

  test("a zero is written as 0, never dropped", () => {
    // A campaign that genuinely started no conversations must record 0, not
    // null — null is what the report renders as "not available".
    const d = campaignSnapshotData({ ...row, messagingStarted: 0, calls: 0 }, "act_1");
    expect(d.messagingStarted).toBe(0);
    expect(d.calls).toBe(0);
  });

  test("the insight's own objective wins over the campaign lookup", () => {
    const objectives = new Map([["c1", "OUTCOME_SALES"]]);
    expect(campaignSnapshotData({ ...row, objective: "OUTCOME_LEADS" }, "a", objectives).objective)
      .toBe("OUTCOME_LEADS");
    expect(campaignSnapshotData(row, "a", objectives).objective).toBe("OUTCOME_SALES");
  });

  test("a caller without the objective lookup still writes every other column", () => {
    // Skipping the row would be worse than an unknown objective.
    const d = campaignSnapshotData(row, "act_1");
    expect(d.objective).toBeNull();
    expect(d.messagingStarted).toBe(12);
  });
});

describe("no writer hand-rolls the column list again", () => {
  test.each([
    ["cron route", ROUTE],
    ["meta-sync", SYNC],
    ["backfill", BACKFILL],
  ])("%s writes through the shared mapper", (_name, src) => {
    expect(src).toContain("campaignSnapshotData(");
  });

  test.each([
    ["cron route", ROUTE],
    ["backfill", BACKFILL],
  ])("%s no longer builds the seven-field literal", (_name, src) => {
    // The exact shape of the defect: a data object naming purchaseValue with no
    // mention of messagingStarted anywhere near it.
    const literal = /const data = \{[\s\S]{0,400}purchaseValue[\s\S]{0,200}\};/.exec(src);
    expect(literal).toBeNull();
  });
});

// ── Meta Ads has a manual sync, like every other integration ────────────────
//
// GA4, Google Ads and Instagram each shipped a "Sync now"; Meta Ads never did,
// so its only path was the 02:00 UTC cron. That gap bit on the day the
// seven-field write bug above was fixed: the repair existed but could not be
// applied, and nobody could confirm it had worked, until the next night.

const META_ACTIONS = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/meta-actions.ts");
const INTEGRATIONS = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/page.tsx");

describe("the Meta Ads card can be synced by hand", () => {
  test("the button is rendered on the card", () => {
    expect(INTEGRATIONS).toContain("<MetaSyncButton");
  });

  test("the action verifies the hotel belongs to the caller's agency", () => {
    // syncHotelAds takes a hotel id ON TRUST — its own doc says the CALLER must
    // be authorized. agencyScoped resolves nothing for another agency's hotel,
    // so this lookup IS the authorization and cannot be dropped.
    expect(META_ACTIONS).toContain("requireAdmin");
    expect(META_ACTIONS).toMatch(/agencyScoped\(prisma\.hotelClient\)[\s\S]{0,160}findFirst/);
    expect(META_ACTIONS).toMatch(/syncHotelAds\(owned\.id/);
  });

  test("it pulls a wider window than the nightly cron", () => {
    // Reached for when something looks wrong; a 7-day window cannot repair a
    // gap wider than 7 days.
    expect(META_ACTIONS).toMatch(/WINDOW_DAYS = 30/);
  });
});
