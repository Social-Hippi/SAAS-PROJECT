import { describe, expect, test } from "vitest";

import {
  buildPeriodNarrative,
  buildRecommendedActions,
  type NarrativeFacts,
} from "@/lib/summary-templates";
import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// GATES 6 and 9 — the period narrative and the recommended actions.
//
// Both are templates with computed values and threshold conditions. The rules
// they must never break:
//
//   • no model call at render time — a generated sentence can assert something
//     the data does not support, and an owner spends money on this page;
//   • every sentence carries a computed figure, so it could not have been
//     written in advance for any period and any property;
//   • no sentence asserts CAUSATION between a channel and a contact. Nothing
//     records which channel produced a call, so "Google drove your enquiries"
//     is not a bolder claim, it is a false one.
// ─────────────────────────────────────────────────────────────────────────────

const base: NarrativeFacts = {
  periodLabel: "1–9 Sep 2026",
  comparisonLabel: "23–31 Aug 2026",
  propertyName: null,
  visits: 1000,
  previousVisits: 800,
  visitChange: 0.25,
  topSourceLabel: "Google Ads",
  topSourceVisits: 400,
  topSourceShare: 0.4,
  noSourceShare: 0.2,
  aiAssistantVisits: 50,
  metaVisits: 100,
  unassignedShare: 0.1,
  recordedContacts: 160,
  roomNightsConfirmed: 45,
  trackerCompleteThrough: "2026-09-09",
  trackerDaysMissing: 0,
  propertiesMissingData: [],
  measuredBookings: 3,
  staleSources: [],
  lostToAvailabilityShare: 0.1,
  junkShareDeltaPoints: null,
  topNoOutcomeCampaign: null,
};

const f = (over: Partial<NarrativeFacts> = {}): NarrativeFacts => ({ ...base, ...over });

describe("1. every sentence carries a computed figure", () => {
  test("a fully-populated period produces only figure-bearing sentences", () => {
    const out = buildPeriodNarrative(
      f({
        propertyName: "Coffeeberry Hills",
        noSourceShare: 0.5,
        aiAssistantVisits: 200,
        metaVisits: 100,
        trackerDaysMissing: 3,
        staleSources: [{ label: "Google Ads", lastUpdated: "2026-09-02" }],
      }),
    );
    expect(out.length).toBeGreaterThan(5);
    for (const s of out) {
      // The one deliberate exception states an ABSENCE; inventing a number to
      // satisfy the rule would be worse than the exception.
      if (s.startsWith("Booking confirmations are not connected")) continue;
      expect(s, s).toMatch(/[0-9]/);
    }
  });

  test("no sentence claims a channel produced a contact", () => {
    const out = buildPeriodNarrative(f({ noSourceShare: 0.5, aiAssistantVisits: 200, metaVisits: 10 }));
    const joined = out.join(" ").toLowerCase();
    for (const claim of [
      "google drove", "meta drove", "google produced", "meta produced",
      "calls from google", "calls from meta", "leads from google",
    ]) {
      expect(joined, claim).not.toContain(claim);
    }
    // And the disclaimer is present wherever contacts are mentioned.
    expect(joined).toContain("not attributable to google");
  });

  test("contacts and room nights always carry the not-attributable note", () => {
    const out = buildPeriodNarrative(f());
    const contacts = out.find((s) => s.includes("customer contacts"))!;
    const nights = out.find((s) => s.includes("room nights"))!;
    expect(contacts).toMatch(/not attributable/i);
    expect(nights).toMatch(/not attributable/i);
  });
});

describe("2. threshold conditions fire only when they should", () => {
  test("untagged traffic above 35% states the share and the remedy", () => {
    expect(buildPeriodNarrative(f({ noSourceShare: 0.36 })).join(" ")).toMatch(/36\.0% of visits arrived with no source tag/);
    expect(buildPeriodNarrative(f({ noSourceShare: 0.34 })).join(" ")).not.toMatch(/no source tag/);
  });

  test("AI above Meta states both figures and the ordering", () => {
    const on = buildPeriodNarrative(f({ aiAssistantVisits: 200, metaVisits: 100 })).join(" ");
    expect(on).toMatch(/AI assistants sent more visits than Meta and Instagram/);
    expect(on).toMatch(/200 against 100/);
    expect(buildPeriodNarrative(f({ aiAssistantVisits: 50, metaVisits: 100 })).join(" ")).not.toMatch(/AI assistants sent more/);
  });

  test("unassigned above 20% fires only in the group view", () => {
    expect(buildPeriodNarrative(f({ unassignedShare: 0.25 })).join(" ")).toMatch(/shared by both properties/);
    // A property is selected, so there is no group split to describe.
    expect(buildPeriodNarrative(f({ unassignedShare: 0.25, propertyName: "Three Hills" })).join(" "))
      .not.toMatch(/shared by both properties/);
  });

  test("incomplete tracker data names the date it is complete through", () => {
    expect(buildPeriodNarrative(f({ trackerDaysMissing: 4 })).join(" "))
      .toMatch(/complete through 2026-09-09; 4 days/);
  });

  test("one property missing is named rather than silently blended", () => {
    expect(buildPeriodNarrative(f({ propertiesMissingData: ["Three Hills"] })).join(" "))
      .toMatch(/No tracker data was recorded for Three Hills/);
  });

  test("no measured booking states the wiring gap, without apology", () => {
    const s = buildPeriodNarrative(f({ measuredBookings: 0 })).join(" ");
    expect(s).toMatch(/Booking confirmations are not connected to website sessions/);
    expect(s).toMatch(/wiring gap, not a result/);
    expect(s.toLowerCase()).not.toContain("sorry");
    expect(s.toLowerCase()).not.toContain("unfortunately");
  });

  test("a stale source is named with its last update", () => {
    expect(
      buildPeriodNarrative(f({ staleSources: [{ label: "Google Ads", lastUpdated: "2026-09-02" }] })).join(" "),
    ).toMatch(/Google Ads \(2026-09-02\) last updated before the end of this period/);
  });

  test("a selected property is named", () => {
    expect(buildPeriodNarrative(f({ propertyName: "Coffeeberry Hills" }))[0])
      .toMatch(/describe Coffeeberry Hills only/);
  });

  test("no baseline produces a sentence that says so, not a fake change", () => {
    const s = buildPeriodNarrative(f({ previousVisits: null, visitChange: null })).join(" ");
    expect(s).toMatch(/no comparable earlier window/);
    expect(s).not.toMatch(/\+100/);
  });
});

describe("3. the narrative differs in SUBSTANCE between periods", () => {
  test("a period with no visits says so instead of describing sources", () => {
    const empty = buildPeriodNarrative(f({ visits: 0, topSourceLabel: null, topSourceVisits: null, topSourceShare: null }));
    const full = buildPeriodNarrative(f());
    expect(empty.join(" ")).toMatch(/No website visits were recorded/);
    expect(empty.join(" ")).not.toMatch(/largest identified source/);
    expect(full.join(" ")).toMatch(/largest identified source/);
    // Different rules fired, not merely different numbers.
    expect(empty.length).not.toBe(full.length);
  });
});

describe("4. recommended actions are computed, ranked and never padded", () => {
  test("every action carries a number", () => {
    const actions = buildRecommendedActions(
      f({
        noSourceShare: 0.5,
        lostToAvailabilityShare: 0.3,
        aiAssistantVisits: 300,
        metaVisits: 100,
        measuredBookings: 0,
        staleSources: [{ label: "Google Ads", lastUpdated: "2026-09-02" }],
        topNoOutcomeCampaign: { name: "Monsoon Promo", spend: "₹45,000" },
      }),
    );
    expect(actions.length).toBeGreaterThanOrEqual(3);
    for (const a of actions) expect(a.text, a.id).toMatch(/[0-9]/);
  });

  test("they are ranked by magnitude, not by the order written", () => {
    const actions = buildRecommendedActions(
      f({ noSourceShare: 0.99, lostToAvailabilityShare: 0.16, measuredBookings: 3 }),
    );
    const mags = actions.map((a) => a.magnitude);
    expect([...mags].sort((x, y) => y - x)).toEqual(mags);
    expect(actions[0].id).toBe("tagging");
  });

  test("nothing fires when no threshold is met — fewer is correct, never padded", () => {
    const quiet = buildRecommendedActions(
      f({ noSourceShare: 0.1, lostToAvailabilityShare: 0.05, aiAssistantVisits: 1, metaVisits: 500, measuredBookings: 5 }),
    );
    expect(quiet).toEqual([]);
  });

  test("capped at five even when everything fires", () => {
    const many = buildRecommendedActions(
      f({
        noSourceShare: 0.9, lostToAvailabilityShare: 0.9, junkShareDeltaPoints: 20,
        aiAssistantVisits: 900, metaVisits: 1, measuredBookings: 0,
        staleSources: [
          { label: "Google Ads", lastUpdated: "2026-09-01" },
          { label: "Meta Ads", lastUpdated: "2026-09-02" },
        ],
        topNoOutcomeCampaign: { name: "X", spend: "₹1" },
      }),
    );
    expect(many.length).toBe(5);
  });

  test("the no-outcome action warns against pausing on the strength of it", () => {
    const a = buildRecommendedActions(f({ topNoOutcomeCampaign: { name: "Monsoon Promo", spend: "₹45,000" } }));
    const found = a.find((x) => x.id === "no_outcome_spend")!;
    expect(found.text).toMatch(/Monsoon Promo/);
    expect(found.text).toMatch(/₹45,000/);
    expect(found.text).toMatch(/check before pausing/i);
    // Never called wasted spend.
    expect(found.text.toLowerCase()).not.toContain("wasted");
  });

  test("each action names who acts", () => {
    const a = buildRecommendedActions(f({ noSourceShare: 0.5, lostToAvailabilityShare: 0.3 }));
    expect(a.find((x) => x.id === "tagging")!.owner).toBe("agency");
    expect(a.find((x) => x.id === "availability")!.owner).toBe("property");
  });
});

describe("5. no model call at render time", () => {
  test("the template module reaches no network or model API", () => {
    const src = readCode("lib/summary-templates.ts");
    for (const forbidden of ["fetch(", "openai", "anthropic", "claude", "http://", "https://"]) {
      expect(src.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  test("it stays pure — no database, no imports at all", () => {
    const src = readCode("lib/summary-templates.ts");
    expect(src).not.toContain("prisma");
    expect(src).not.toMatch(/^import /m);
  });
});
