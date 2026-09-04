import { describe, expect, test } from "vitest";

import {
  displayValue,
  platformHealth,
  trackingHealth,
  worstOf,
  DATA_HEALTH_STATES,
  SNIPPET_SILENCE_BROKEN_HOURS,
  SYNC_STALE_HOURS,
  UNAVAILABLE,
  type DataHealth,
} from "@/lib/data-health";

// ─────────────────────────────────────────────────────────────────────────────
// "Can I trust this number?"
//
// The defect being closed: a dashboard showing "Bookings: 0" gave the reader no
// way to tell whether that meant no bookings happened, tracking was never
// installed, tracking broke, no ad account was connected, or the sync failed.
// Five different situations rendered identically — and four of them are not 0.
//
// The case that matters most is `broken`: page views keep flowing while a
// changed thank-you page stops conversions, so "0 bookings" reads as a business
// outcome rather than a measurement failure. Nothing in the product could
// previously tell those apart.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-04T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

// ── 1. Tracking — the source of every visit, conversion and revenue figure ──

describe("1. trackingHealth", () => {
  test("never installed → not_installed, and nothing downstream is trustworthy", () => {
    const h = trackingHealth({
      snippet: "not_installed",
      lastEventAt: null,
      hasEventsInWindow: false,
      now: NOW,
    });
    expect(h.state).toBe("not_installed");
    expect(h.trustworthy).toBe(false);
    expect(h.action).toMatch(/snippet/i);
  });

  test("installed but nothing ever arrived → never_received, not 'zero'", () => {
    // The documented real incident: a mistyped siteId discarded 100% of a
    // hotel's traffic for weeks, and the dashboard showed zeros the whole time.
    const h = trackingHealth({
      snippet: "awaiting",
      lastEventAt: null,
      hasEventsInWindow: false,
      now: NOW,
    });
    expect(h.state).toBe("never_received");
    expect(h.trustworthy).toBe(false);
    expect(h.action).toMatch(/ID matches|live site/i);
  });

  test("worked, then went silent → broken (THE case that destroys trust)", () => {
    const h = trackingHealth({
      snippet: "live",
      lastEventAt: hoursAgo(SNIPPET_SILENCE_BROKEN_HOURS + 1),
      hasEventsInWindow: false,
      now: NOW,
    });
    expect(h.state).toBe("broken");
    expect(h.trustworthy).toBe(false);
    expect(h.message).toMatch(/may have stopped working/i);
  });

  test("a REAL zero is trustworthy and says so", () => {
    // This is the whole point of the module: separating "nothing happened" from
    // "we couldn't see what happened" so a genuine zero stays believable.
    const h = trackingHealth({
      snippet: "live",
      lastEventAt: hoursAgo(1),
      hasEventsInWindow: false,
      now: NOW,
    });
    expect(h.state).toBe("no_activity");
    expect(h.trustworthy).toBe(true);
    expect(h.message).toMatch(/no activity in this period/i);
    expect(h.action).toBeNull();
  });

  test("live with activity → healthy", () => {
    const h = trackingHealth({
      snippet: "live",
      lastEventAt: hoursAgo(1),
      hasEventsInWindow: true,
      now: NOW,
    });
    expect(h.state).toBe("healthy");
    expect(h.trustworthy).toBe(true);
    expect(h.action).toBeNull();
  });

  test("the silence threshold is exact at the boundary", () => {
    const at = trackingHealth({
      snippet: "live",
      lastEventAt: hoursAgo(SNIPPET_SILENCE_BROKEN_HOURS),
      hasEventsInWindow: true,
      now: NOW,
    });
    const just_under = trackingHealth({
      snippet: "live",
      lastEventAt: hoursAgo(SNIPPET_SILENCE_BROKEN_HOURS - 0.5),
      hasEventsInWindow: true,
      now: NOW,
    });
    expect(at.state).toBe("broken");
    expect(just_under.state).toBe("healthy");
  });

  test("silence outranks 'no activity in window' — broken is reported first", () => {
    // A hotel that went silent 5 days ago also has no events in a 30-day window.
    // Reporting "no activity" there would hide the breakage behind a real-looking
    // zero, which is exactly the failure being fixed.
    const h = trackingHealth({
      snippet: "live",
      lastEventAt: hoursAgo(24 * 5),
      hasEventsInWindow: false,
      now: NOW,
    });
    expect(h.state).toBe("broken");
  });
});

// ── 2. Platform sources — spend and analytics ───────────────────────────────

describe("2. platformHealth", () => {
  const base = { label: "Google Ads", lastSyncedAt: hoursAgo(2), now: NOW };

  test("not connected is NOT zero — it never belongs in a ROAS denominator", () => {
    const h = platformHealth({ ...base, connected: false });
    expect(h.state).toBe("not_connected");
    expect(h.trustworthy).toBe(false);
    expect(h.message).toContain("Google Ads");
    expect(h.action).toMatch(/Connect Google Ads/);
  });

  test("a credential that needs attention is broken, not merely stale", () => {
    const h = platformHealth({ ...base, connected: true, needsReconnect: true });
    expect(h.state).toBe("broken");
    expect(h.trustworthy).toBe(false);
    expect(h.action).toMatch(/Reconnect/);
  });

  test("connected but never synced is distinguished from synced-with-zero", () => {
    const h = platformHealth({ ...base, connected: true, lastSyncedAt: null });
    expect(h.state).toBe("never_received");
    expect(h.trustworthy).toBe(false);
    expect(h.action).toMatch(/overnight/i);
  });

  test("an old sync reads stale — a failing sync silently RAISES ROAS", () => {
    // Missing spend rows shrink the denominator, so a broken sync makes results
    // look better. That must never pass as healthy.
    const h = platformHealth({ ...base, connected: true, lastSyncedAt: hoursAgo(SYNC_STALE_HOURS + 1) });
    expect(h.state).toBe("stale");
    expect(h.trustworthy).toBe(false);
    expect(h.message).toMatch(/last updated/i);
  });

  test("recently synced → healthy", () => {
    const h = platformHealth({ ...base, connected: true });
    expect(h.state).toBe("healthy");
    expect(h.trustworthy).toBe(true);
  });

  test("the label is used verbatim, so each source names itself", () => {
    for (const label of ["Meta Ads", "GA4", "Instagram"]) {
      expect(platformHealth({ label, connected: false, lastSyncedAt: null, now: NOW }).message)
        .toContain(label);
    }
  });
});

// ── 3. Composite metrics are only as good as their weakest input ────────────

describe("3. worstOf", () => {
  const healthy: DataHealth = { state: "healthy", trustworthy: true, message: "", action: null };
  const stale: DataHealth = { state: "stale", trustworthy: false, message: "s", action: null };
  const broken: DataHealth = { state: "broken", trustworthy: false, message: "b", action: null };

  test("a ROAS with healthy revenue but a broken ad source is NOT trustworthy", () => {
    // Returning the first, or averaging, would let a figure be shown confidently
    // because one of its two sources happened to be fine.
    const h = worstOf(healthy, broken);
    expect(h.state).toBe("broken");
    expect(h.trustworthy).toBe(false);
  });

  test("order of arguments does not change the verdict", () => {
    expect(worstOf(broken, healthy).state).toBe(worstOf(healthy, broken).state);
  });

  test("it picks the WORST, not merely the first untrustworthy one", () => {
    expect(worstOf(stale, broken).state).toBe("broken");
    expect(worstOf(broken, stale).state).toBe("broken");
  });

  test("all-healthy stays healthy", () => {
    expect(worstOf(healthy, healthy).trustworthy).toBe(true);
  });

  test("no inputs is healthy (nothing to distrust)", () => {
    expect(worstOf().trustworthy).toBe(true);
  });
});

// ── 4. What actually reaches the screen ─────────────────────────────────────

describe("4. displayValue", () => {
  test("an untrustworthy metric renders an em dash, never 0", () => {
    const broken: DataHealth = { state: "broken", trustworthy: false, message: "", action: null };
    expect(displayValue(broken, "₹4,20,000")).toBe(UNAVAILABLE);
    expect(displayValue(broken, "0")).toBe(UNAVAILABLE);
    expect(UNAVAILABLE).not.toBe("0");
  });

  test("a trustworthy metric renders its real value, including a genuine zero", () => {
    const realZero: DataHealth = { state: "no_activity", trustworthy: true, message: "", action: null };
    expect(displayValue(realZero, "0")).toBe("0");
    expect(displayValue(realZero, "₹0")).toBe("₹0");
  });
});

// ── 5. Model hygiene ────────────────────────────────────────────────────────

describe("5. the state model is well-formed", () => {
  test("only 'healthy' and 'no_activity' are trustworthy", () => {
    // Every other state means the number on screen cannot be relied on. If a new
    // state is ever added as trustworthy, that should be a deliberate decision.
    const trustworthy = new Set(["healthy", "no_activity"]);
    for (const state of DATA_HEALTH_STATES) {
      const isTrustworthy = trustworthy.has(state);
      expect(typeof state, state).toBe("string");
      expect(isTrustworthy === (state === "healthy" || state === "no_activity"), state).toBe(true);
    }
  });

  test("every untrustworthy state produced carries an action the reader can take", () => {
    const cases: DataHealth[] = [
      trackingHealth({ snippet: "not_installed", lastEventAt: null, hasEventsInWindow: false, now: NOW }),
      trackingHealth({ snippet: "awaiting", lastEventAt: null, hasEventsInWindow: false, now: NOW }),
      trackingHealth({ snippet: "live", lastEventAt: hoursAgo(200), hasEventsInWindow: false, now: NOW }),
      platformHealth({ label: "Meta Ads", connected: false, lastSyncedAt: null, now: NOW }),
      platformHealth({ label: "Meta Ads", connected: true, needsReconnect: true, lastSyncedAt: hoursAgo(1), now: NOW }),
      platformHealth({ label: "Meta Ads", connected: true, lastSyncedAt: hoursAgo(200), now: NOW }),
    ];
    for (const h of cases) {
      expect(h.trustworthy, h.state).toBe(false);
      expect(h.action, h.state).toBeTruthy();
    }
  });

  test("messages are plain language — no ids, codes, or internal state names", () => {
    const all: DataHealth[] = [
      trackingHealth({ snippet: "live", lastEventAt: hoursAgo(200), hasEventsInWindow: false, now: NOW }),
      platformHealth({ label: "GA4", connected: false, lastSyncedAt: null, now: NOW }),
    ];
    for (const h of all) {
      expect(h.message).not.toMatch(/null|undefined|not_installed|never_received|4\d\d/);
    }
  });
});
