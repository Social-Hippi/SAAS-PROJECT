import { describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Evidence-based funnel stages.
//
// Every one of Aster's 10,596 PageViews has funnelStage NULL, because stages
// depended entirely on hotel-authored path rules and Aster never wrote any.
// Rather than guess stages from page names, we derive the one stage we hold
// hard evidence for: a visitor ON the hotel's own booking engine has reached
// booking INTENT. `consideration` stays rule-driven — there is no reliable
// signal for it and a guess would be worse than a null.
// ─────────────────────────────────────────────────────────────────────────────

import {
  resolveStageFromBookingDomain,
  resolvePageStage,
  parseFunnelRules,
  SENSIBLE_DEFAULTS,
} from "@/lib/funnel";

const BOOKING = ["bookings.coffeeberryhills.in", "bookings.3hills.in"];

describe("booking-domain evidence", () => {
  test("a pageview ON the booking engine is intent", () => {
    expect(resolveStageFromBookingDomain("https://bookings.coffeeberryhills.in/?propertyId=8642", BOOKING))
      .toBe("intent");
  });

  test("a true subdomain also counts", () => {
    expect(resolveStageFromBookingDomain("https://secure.bookings.3hills.in/x", BOOKING)).toBe("intent");
  });

  test("the hotel's own marketing site is NOT intent", () => {
    expect(resolveStageFromBookingDomain("https://asterholidays.com/coffeeberry-hills-chikmagalur-resort/", BOOKING))
      .toBeNull();
  });

  test("a lookalike host is never intent", () => {
    expect(resolveStageFromBookingDomain("https://evil-coffeeberryhills.in/", BOOKING)).toBeNull();
    expect(resolveStageFromBookingDomain("https://bookings.coffeeberryhills.in.attacker.com/", BOOKING)).toBeNull();
  });

  test("no domains configured means no inference at all", () => {
    expect(resolveStageFromBookingDomain("https://bookings.coffeeberryhills.in/", [])).toBeNull();
    expect(resolveStageFromBookingDomain("https://bookings.coffeeberryhills.in/", null)).toBeNull();
  });

  test.each([["null", null], ["empty", ""], ["not a url", "::::"]])(
    "returns null for %s without throwing", (_l, v) => {
      expect(resolveStageFromBookingDomain(v as string | null, BOOKING)).toBeNull();
    },
  );
});

describe("stage precedence", () => {
  const rules = parseFunnelRules(SENSIBLE_DEFAULTS);

  test("a page that DECLARES its stage always wins", () => {
    expect(resolvePageStage({
      declaredStage: "consideration",
      pageUrl: "https://bookings.coffeeberryhills.in/",
      bookingDomains: BOOKING, rules, path: "/",
    })).toBe("consideration");
  });

  test("booking-domain evidence beats a path rule that would mislabel it", () => {
    // The engine's landing path is "/", which SENSIBLE_DEFAULTS maps to
    // awareness. Being ON the booking engine is the stronger fact.
    expect(resolvePageStage({
      pageUrl: "https://bookings.coffeeberryhills.in/",
      bookingDomains: BOOKING, rules, path: "/",
    })).toBe("intent");
  });

  test("path rules still apply on the hotel's own site", () => {
    expect(resolvePageStage({
      pageUrl: "https://asterholidays.com/rooms/deluxe",
      bookingDomains: BOOKING, rules, path: "/rooms/deluxe",
    })).toBe("consideration");
  });

  test("returns null rather than guessing when nothing applies", () => {
    expect(resolvePageStage({
      pageUrl: "https://asterholidays.com/blog/coorg-guide",
      bookingDomains: BOOKING, rules: [], path: "/blog/coorg-guide",
    })).toBeNull();
  });

  test("a hotel with NO rules and NO booking domains behaves exactly as before", () => {
    expect(resolvePageStage({
      pageUrl: "https://asterholidays.com/", bookingDomains: [], rules: [], path: "/",
    })).toBeNull();
  });

  test("consideration is never inferred from evidence", () => {
    // Only an explicit declaration or a hotel rule can produce it.
    expect(resolvePageStage({
      pageUrl: "https://bookings.coffeeberryhills.in/", bookingDomains: BOOKING, rules: [], path: "/",
    })).toBe("intent");
  });
});

describe("the ingest route uses the evidence resolver", () => {
  test("route.ts resolves stages with booking-domain precedence", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "app/api/track/event/route.ts"), "utf8");
    expect(src).toContain("resolvePageStage");
    expect(src).toContain("bookingDomains: hotel.bookingDomains");
  });
});
