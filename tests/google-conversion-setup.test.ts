import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import {
  readConversionSetup,
  type ConversionAction,
  type ConversionSetup,
} from "@/lib/google-ads-conversion-setup";

// ─────────────────────────────────────────────────────────────────────────────
// Why Google Ads is not attributing booking revenue.
//
// The symptom in the synced figures: 7,013.75 conversions worth ₹7,012.75 over
// 30 days — about one rupee each — and 6,912 of them from local store visit
// campaigns. This reads the account to find which of those is the cause.
// ─────────────────────────────────────────────────────────────────────────────

const SETUP = readCode("lib/google-ads-conversion-setup.ts");
const PANEL = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/CallSetupPanel.tsx");

const action = (over: Partial<ConversionAction> = {}): ConversionAction => ({
  name: "Website lead",
  category: "DEFAULT",
  type: "WEBPAGE",
  origin: "WEBSITE",
  status: "ENABLED",
  primaryForGoal: true,
  includeInConversions: true,
  defaultValue: null,
  alwaysUseDefaultValue: null,
  defaultCurrency: null,
  countingType: "ONE_PER_CLICK",
  ...over,
});

const setup = (actions: ConversionAction[]): ConversionSetup => ({
  actions,
  performance: [],
  problems: [],
});

describe("1. it names the cause, not the symptom", () => {
  test("a fixed value is reported with the action and the amount", () => {
    const found = readConversionSetup(
      setup([action({ name: "Book now click", alwaysUseDefaultValue: true, defaultValue: 1 })]),
    );
    expect(found.join(" ")).toMatch(/SAME value every time/);
    expect(found.join(" ")).toMatch(/Book now click = 1/);
  });

  test("no booking action at all is the strongest finding", () => {
    const found = readConversionSetup(setup([action({ category: "DEFAULT", name: "Page view" })]));
    expect(found.join(" ")).toMatch(/No live conversion action is a purchase or booking/);
  });

  test("a purchase action present means that finding is NOT raised", () => {
    const found = readConversionSetup(
      setup([action({ name: "Booking", category: "PURCHASE", alwaysUseDefaultValue: false })]),
    );
    expect(found.join(" ")).not.toMatch(/No live conversion action is a purchase/);
  });

  test("store visits bid on as a primary goal are called out", () => {
    const found = readConversionSetup(
      setup([
        action({ name: "Store visits", category: "STORE_VISIT", primaryForGoal: true }),
        action({ name: "Booking", category: "PURCHASE", primaryForGoal: true }),
      ]),
    );
    expect(found.join(" ")).toMatch(/Store visits are a PRIMARY goal/);
    expect(found.join(" ")).toMatch(/as if a walk-in equalled a booking/);
  });

  test("nothing primary at all is its own finding", () => {
    const found = readConversionSetup(
      setup([action({ category: "PURCHASE", primaryForGoal: false })]),
    );
    expect(found.join(" ")).toMatch(/nothing to optimise towards/);
  });

  test("a paused action is not judged", () => {
    // Only live actions describe what the account is doing now.
    const found = readConversionSetup(
      setup([
        action({ category: "PURCHASE", status: "ENABLED", primaryForGoal: true }),
        action({ name: "Old", status: "REMOVED", alwaysUseDefaultValue: true, defaultValue: 1 }),
      ]),
    );
    expect(found.join(" ")).not.toMatch(/SAME value every time/);
  });

  test("a healthy account produces no findings", () => {
    expect(
      readConversionSetup(
        setup([action({ name: "Booking", category: "PURCHASE", primaryForGoal: true })]),
      ),
    ).toEqual([]);
  });
});

describe("2. it only reads, and says what it could not", () => {
  test("every query is a SELECT, no mutate", () => {
    expect(SETUP).not.toMatch(/:mutate|mutateOperations/);
    const queries = SETUP.match(/`SELECT[\s\S]*?`/g) ?? [];
    expect(queries.length).toBe(2);
  });

  test("it asks for the fields that decide it", () => {
    expect(SETUP).toMatch(/conversion_action\.value_settings\.always_use_default_value/);
    expect(SETUP).toMatch(/conversion_action\.value_settings\.default_value/);
    expect(SETUP).toMatch(/conversion_action\.primary_for_goal/);
    expect(SETUP).toMatch(/conversion_action\.category/);
    // …and what actually fired, which is the evidence for the reading.
    expect(SETUP).toMatch(/segments\.conversion_action_name/);
    expect(SETUP).toMatch(/metrics\.all_conversions_value/);
  });

  test("a failed query is reported, not thrown", () => {
    expect(SETUP).toMatch(/problems\.push\(/);
    expect(PANEL).toMatch(/setup\.problems\.map/);
  });
});
