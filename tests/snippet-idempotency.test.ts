// @vitest-environment happy-dom
//
// Regression: the tracking snippet must initialize AT MOST ONCE per page load,
// even when the <script> tag is accidentally included twice (a common
// WordPress/theme misconfiguration). Without the window.__HOTELTRACK_SNIPPET_INITIALIZED__
// guard, each inclusion re-runs the whole IIFE — and because the pageview
// debounce (lastPvPath/lastPvTs) lives in per-execution closure state, the
// second run is NOT debounced: it emits a second pageview, a second
// /api/track/config request, and a second set of click/form/conversion
// listeners. This test boots the REAL source (scripts/snippet.src.js — the
// source of truth) twice in one DOM and asserts nothing is duplicated.

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const SRC = path.resolve(process.cwd(), "scripts/snippet.src.js");

let captured: Record<string, unknown>[] = [];
let configCount = 0;

function eventsOfType(type: string) {
  return captured.filter((e) => e.type === type);
}
function boot() {
  // Same bootstrap the other snippet tests use: run the real IIFE. It reads its
  // own <script> via document.currentScript and self-executes.
  new Function(readFileSync(SRC, "utf8"))();
}
function loadedFlag() {
  return (window as unknown as { __HOTELTRACK_SNIPPET_INITIALIZED__?: boolean }).__HOTELTRACK_SNIPPET_INITIALIZED__;
}

beforeAll(() => {
  // Force the fetch transport (as in phase3-snippet) so we can read event bodies,
  // and count config requests separately by URL. Config returns !ok so setup()
  // never runs — isolating the counts from config-driven listeners.
  Object.defineProperty(window.navigator, "sendBeacon", { value: undefined, configurable: true });
  globalThis.fetch = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.indexOf("/api/track/config") >= 0) {
      configCount++;
      return { ok: false, json: async () => null } as unknown as Response;
    }
    if (u.indexOf("/api/track/event") >= 0 && init?.body != null) {
      try { captured.push(JSON.parse(String(init.body))); } catch {}
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }
    return { ok: false, json: async () => null } as unknown as Response;
  }) as never;

  const s = document.createElement("script");
  s.src = "https://app.example.com/t.js?id=test-site-idem&debug=1";
  Object.defineProperty(document, "currentScript", { value: s, configurable: true });
  (window as unknown as { HT_DEBUG: boolean }).HT_DEBUG = true;

  // The scenario under test: the exact same snippet tag included twice.
  boot();
  boot();
});

describe("snippet idempotency guard (double inclusion)", () => {
  it("sets the window.__HOTELTRACK_SNIPPET_INITIALIZED__ guard flag on first init", () => {
    expect(loadedFlag()).toBe(true);
  });

  it("fires exactly ONE pageview across two inclusions", () => {
    // The pageview debounce is per-closure, so a missing guard would yield 2 here.
    expect(eventsOfType("pageview").length).toBe(1);
  });

  it("makes exactly ONE /api/track/config request across two inclusions", () => {
    expect(configCount).toBe(1);
  });

  it("registers interaction listeners only once (single click ⇒ one beacon)", () => {
    captured = [];
    document.body.innerHTML = `<button data-ht-click="book-now">Book Now</button>`;
    document.querySelector("button")!.dispatchEvent(new Event("click", { bubbles: true }));
    // A double-registered capture listener on document.body would report 2.
    expect(eventsOfType("click").length).toBe(1);
  });

  it("a further inclusion is a no-op: no extra pageview, no extra config request", () => {
    captured = [];
    const configBefore = configCount;
    boot();
    expect(eventsOfType("pageview").length).toBe(0);
    expect(configCount).toBe(configBefore);
  });
});
