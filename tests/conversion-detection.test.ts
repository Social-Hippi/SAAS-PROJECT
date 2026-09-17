import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import {
  normalizeThankYouPattern,
  normalizeThankYouPatterns,
  splitThankYouPatterns,
  PATTERN_SEPARATOR,
} from "@/lib/conversion-patterns";

// ─────────────────────────────────────────────────────────────────────────────
// Which URLs mean "a booking was completed".
//
// Like bookingDomains, this could only ever be set when a hotel was CREATED.
// Aster's was a single path — "/payment/razorpay-callback/*" — which catches a
// Razorpay payment and nothing else. A booking taken pay-at-hotel or through any
// other gateway lands elsewhere and is never recorded: the guest arrives from
// the ad, books, and the report shows nothing.
//
// Nothing errors, and the VISIT still records, so the hotel looks tracked while
// its bookings quietly are not.
// ─────────────────────────────────────────────────────────────────────────────

const SRC = readCode("scripts/snippet.src.js");
const ACTIONS = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/conversion-actions.ts");
const CARD = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/ConversionDetectionCard.tsx");
const PAGE = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/page.tsx");

describe("1. several paths, separated by newline not pipe", () => {
  test("the snippet splits on newline and tries each", () => {
    // NOT "|": the glob builder escapes it, so a pipe-joined list compiles to a
    // pattern matching a literal pipe — and therefore nothing, silently.
    expect(SRC).toMatch(/String\(p\)\.split\("\\n"\)/);
    expect(SRC).toMatch(/urlMatchOne\(one\)/);
  });

  test("the separator the server writes is the one the snippet splits on", () => {
    expect(PATTERN_SEPARATOR).toBe("\n");
    expect(ACTIONS).toMatch(/patterns\.join\(PATTERN_SEPARATOR\)/);
  });

  test("a single existing pattern still works untouched", () => {
    // Backwards compatibility: no newline means one entry.
    expect(splitThankYouPatterns("/payment/razorpay-callback/*")).toEqual([
      "/payment/razorpay-callback/*",
    ]);
  });

  test("round-trips through storage", () => {
    const { patterns } = normalizeThankYouPatterns("/a/*\n/b/confirmed");
    expect(splitThankYouPatterns(patterns.join(PATTERN_SEPARATOR))).toEqual(["/a/*", "/b/confirmed"]);
  });
});

describe("2. what an operator pastes is accepted", () => {
  test.each([
    ["/payment/razorpay-callback/*", "already a path"],
    ["payment/razorpay-callback/*", "no leading slash"],
    ["  /payment/done  ", "padding"],
  ])("%s (%s)", (input) => {
    expect(normalizeThankYouPattern(input)).toMatch(/^\//);
  });

  test("a full confirmation URL keeps only its path", () => {
    // An operator reads the URL out of their browser bar and pastes the lot.
    expect(normalizeThankYouPattern("https://bookings.example.com/booking/confirmed/XYZ")).toBe(
      "/booking/confirmed/XYZ",
    );
  });

  test("a query string is dropped", () => {
    // A booking reference in the query is unique per booking, so keeping it
    // would match exactly one guest's confirmation forever.
    expect(normalizeThankYouPattern("https://x.com/done?ref=MPG0QE_1_1")).toBe("/done");
  });
});

describe("3. what is refused", () => {
  test.each([["/"], ["/*"]])("%s would make every page a booking", (input) => {
    expect(normalizeThankYouPattern(input)).toBeNull();
  });

  test.each([[""], ["   "], ["https://"]])("%s yields null", (input) => {
    expect(normalizeThankYouPattern(input)).toBeNull();
  });

  test("internal whitespace is refused, not stripped", () => {
    // Stripping turns "not a path" into "/notapath" — a different,
    // valid-looking value that silently matches nothing.
    expect(normalizeThankYouPattern("not a url at all")).toBeNull();
    expect(normalizeThankYouPattern("/book ing/done")).toBeNull();
  });

  test("a list with one bad entry is refused whole", () => {
    // A half-saved list looks applied and silently drops a path — the same
    // silence this setting exists to end.
    const { rejected } = normalizeThankYouPatterns("/good/*\n/\n/also-good");
    expect(rejected).toEqual(["/"]);
    expect(ACTIONS).toMatch(/if \(rejected\.length > 0\)/);
  });

  test("an empty list is refused", () => {
    // Saving nothing would silently stop all booking detection.
    expect(ACTIONS).toMatch(/Add at least one confirmation path/);
  });

  test("duplicates collapse", () => {
    expect(normalizeThankYouPatterns("/a/*\n/a/*").patterns).toEqual(["/a/*"]);
  });
});

describe("4. the UI says what goes missing", () => {
  test("it names the consequence, not the mechanism", () => {
    expect(CARD).toMatch(/is not recorded at all/i);
    expect(CARD).toMatch(/the visit still looks\s+tracked/i);
  });

  test("a single path is flagged as probably incomplete", () => {
    expect(CARD).toMatch(/Only one path is listed/);
  });

  test("zero recorded bookings is called out as a likely misconfiguration", () => {
    // The honest check on whether the paths are right.
    expect(CARD).toMatch(/the paths above are probably wrong/);
    expect(PAGE).toMatch(/conversionsSeen/);
  });

  test("only an agency admin, scoped to their own hotel", () => {
    expect(ACTIONS).toContain("requireAdmin");
    expect(ACTIONS).toMatch(/agencyScoped\(prisma\.hotelClient\)/);
  });

  test("the card is rendered", () => {
    expect(PAGE).toContain("<ConversionDetectionCard");
  });
});
