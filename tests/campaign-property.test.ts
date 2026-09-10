import { describe, expect, test } from "vitest";

import {
  groupCampaignsByProperty,
  matchCampaignToSegment,
  type CampaignSegmentRule,
} from "@/lib/campaign-property";
import { UNASSIGNED_SEGMENT } from "@/lib/segments";
import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// ATTRIBUTING AD SPEND TO A PROPERTY.
//
// A Meta campaign carries no property field. The only signal is the name a
// person typed, so this is an inference from a naming convention and is built to
// behave like one: the patterns are data, an unmatched campaign is visibly
// Unassigned, and a campaign two properties both claim is Unassigned too rather
// than awarded to a winner picked by the matcher.
//
// The fixtures are Aster's REAL campaign names, read from production.
// ─────────────────────────────────────────────────────────────────────────────

const CBH: CampaignSegmentRule = {
  id: "seg_cbh",
  name: "Coffeeberry Hills",
  campaignNamePatterns: ["CBH", "Coffeeberry"],
};
const TH: CampaignSegmentRule = {
  id: "seg_th",
  name: "Three Hills",
  campaignNamePatterns: ["3 Hills", "3Hills", "Three Hills", "THC"],
};
const SEGMENTS = [CBH, TH];

// Exactly the six campaigns that ran 12 Aug – 10 Sep 2026, with their spend.
const REAL_CAMPAIGNS = [
  { campaignName: "SH|CBH| Sales campaign", spend: 5115 },
  { campaignName: "ANG - Leads WhatsApp - 3 Hills - 2026", spend: 3497 },
  { campaignName: "ANG - Leads -  WhatsApp - CBH - 2026", spend: 3347 },
  { campaignName: "SH|THC | COUPLES | SALES-WA", spend: 3118 },
  { campaignName: "CBH_LEADS_3D2N-12K-COUPLE_KA-SOUTH_AUG26", spend: 998 },
  { campaignName: "SH|Independence", spend: 466 },
];

describe("1. the real campaign names", () => {
  test("each one lands where a person would put it", () => {
    const got = Object.fromEntries(
      REAL_CAMPAIGNS.map((c) => [c.campaignName, matchCampaignToSegment(c.campaignName, SEGMENTS).segmentKey]),
    );
    expect(got).toEqual({
      "SH|CBH| Sales campaign": "seg_cbh",
      "ANG - Leads -  WhatsApp - CBH - 2026": "seg_cbh",
      "CBH_LEADS_3D2N-12K-COUPLE_KA-SOUTH_AUG26": "seg_cbh",
      "ANG - Leads WhatsApp - 3 Hills - 2026": "seg_th",
      "SH|THC | COUPLES | SALES-WA": "seg_th",
      "SH|Independence": UNASSIGNED_SEGMENT,
    });
  });

  test("the unattributable campaign is a visible row, not a rounding error", () => {
    const groups = groupCampaignsByProperty(REAL_CAMPAIGNS, SEGMENTS);
    const unassigned = groups.get(UNASSIGNED_SEGMENT) ?? [];
    expect(unassigned.map((c) => c.campaignName)).toEqual(["SH|Independence"]);
  });

  test("every campaign is counted exactly once, and spend adds up", () => {
    // The property of a partition, asserted rather than assumed: nothing is
    // dropped and nothing is counted twice.
    const groups = groupCampaignsByProperty(REAL_CAMPAIGNS, SEGMENTS);
    const all = [...groups.values()].flat();
    expect(all).toHaveLength(REAL_CAMPAIGNS.length);
    expect(all.reduce((s, c) => s + c.spend, 0)).toBe(16541);
  });

  test("the double separator in the real CBH name does not defeat the match", () => {
    // "ANG - Leads -  WhatsApp - CBH - 2026" has two spaces mid-name. Matching
    // on raw text would still work here, but whitespace is collapsed so a
    // pattern typed with single spaces matches a name typed with several.
    expect(matchCampaignToSegment("ANG - Leads -  WhatsApp - CBH - 2026", SEGMENTS).segmentKey).toBe("seg_cbh");
    expect(matchCampaignToSegment("ANG  -  Leads  -  3   Hills", SEGMENTS).segmentKey).toBe("seg_th");
  });
});

describe("2. matching is case- and separator-tolerant", () => {
  test("case does not matter", () => {
    for (const name of ["sh|cbh| sales", "SH|CBH| SALES", "Sh|Cbh| Sales"]) {
      expect(matchCampaignToSegment(name, SEGMENTS).segmentKey, name).toBe("seg_cbh");
    }
  });

  test("the matched pattern is reported, so the rule can be shown to a reader", () => {
    expect(matchCampaignToSegment("SH|THC | COUPLES", SEGMENTS).matchedPatterns).toEqual(["THC"]);
  });

  test("an empty pattern matches nothing rather than everything", () => {
    // "".includes() is true for every string — an empty rule would silently
    // claim the entire account.
    const sloppy: CampaignSegmentRule = { id: "x", name: "X", campaignNamePatterns: ["", "  "] };
    expect(matchCampaignToSegment("anything at all", [sloppy]).segmentKey).toBe(UNASSIGNED_SEGMENT);
  });
});

describe("3. a campaign two properties claim is NOT awarded to one", () => {
  test("it goes to Unassigned and is flagged ambiguous", () => {
    const overlapping = [
      { id: "a", name: "A", campaignNamePatterns: ["SALES"] },
      { id: "b", name: "B", campaignNamePatterns: ["WA"] },
    ];
    const got = matchCampaignToSegment("SH|THC | COUPLES | SALES-WA", overlapping);
    expect(got.segmentKey).toBe(UNASSIGNED_SEGMENT);
    expect(got.ambiguous).toBe(true);
    expect(got.matchedPatterns.sort()).toEqual(["SALES", "WA"]);
  });

  test("picking the longest or first match is NOT what happens", () => {
    // Both would be plausible tie-breaks, and both would hide a broken rule set
    // behind a confident answer.
    const overlapping = [
      { id: "a", name: "A", campaignNamePatterns: ["CBH"] },
      { id: "b", name: "B", campaignNamePatterns: ["CBH_LEADS"] },
    ];
    expect(matchCampaignToSegment("CBH_LEADS_3D2N", overlapping).segmentKey).toBe(UNASSIGNED_SEGMENT);
  });
});

describe("4. every property appears, even with nothing running", () => {
  test("a property with no campaigns is an empty group, not a missing one", () => {
    const groups = groupCampaignsByProperty([{ campaignName: "SH|CBH| Sales" }], SEGMENTS);
    expect(groups.has("seg_th")).toBe(true);
    expect(groups.get("seg_th")).toEqual([]);
  });
});

describe("5. the patterns are data, and are seeded", () => {
  const seed = readCode("scripts/seed-property-segments.ts");

  test("both properties carry the tokens their real campaigns use", () => {
    expect(seed).toContain('campaignNamePatterns: ["CBH", "Coffeeberry"]');
    expect(seed).toContain('"3 Hills"');
    expect(seed).toContain('"THC"');
  });

  test("they are preserved on re-run like the other matching rules", () => {
    // Routing fields refresh every run; hand-corrected matching rules must not,
    // or an admin's fix is reverted by the next deploy.
    const at = seed.indexOf("UPDATE_RULES");
    expect(at).toBeGreaterThan(-1);
    expect(seed).toMatch(/UPDATE_RULES[\s\S]{0,400}campaignNamePatterns: seg\.campaignNamePatterns/);
  });
});
