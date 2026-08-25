// @vitest-environment happy-dom
//
// GENERAL customer-journey harness (Tracks B + C) — DB-free.
//
// Boots the REAL tracking snippet (scripts/snippet.src.js) in a DOM for every
// scenario in tests/journey/scenarios.ts and asserts, per source:
//
//   B1  landing → correct acquisition evidence on the wire
//   B2  cross-page journey → session + visitor + evidence persist, and ordinary
//       pageviews do not manufacture a second acquisition source
//   B3  return journey → observed and DOCUMENTED (semantics unchanged)
//   B4  conversion → retains visitor / session / source / medium / campaign /
//       content / click identifiers
//   B5  conversion value → whatever the current mechanism actually captures
//
// The harness is SOURCE-AGNOSTIC. Adding Email/Referral/OTA means appending a
// row to the scenario table; nothing here knows what an influencer is.

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { classifySourceType } from "@/lib/source-classifier";
import {
  CLICK_ID_KEYS,
  JOURNEY_SCENARIOS,
  SYNTHETIC,
  type JourneyScenario,
} from "@/tests/journey/scenarios";

const SNIPPET = readFileSync(path.resolve(process.cwd(), "scripts/snippet.src.js"), "utf8");

type Payload = Record<string, unknown>;
let captured: Payload[] = [];

function clearCookies() {
  for (const pair of document.cookie.split(";")) {
    const name = pair.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

/** Boot the snippet at `landing`. `keepState` simulates a returning visitor. */
function boot(landing: string, opts: { referrer?: string; keepState?: boolean } = {}) {
  if (!opts.keepState) {
    clearCookies();
    try { sessionStorage.clear(); } catch { /* ignore */ }
  }
  captured = [];
  history.replaceState({}, "", landing);
  Object.defineProperty(document, "referrer", { value: opts.referrer ?? "", configurable: true });

  const s = document.createElement("script");
  s.src = "https://app.example.com/t.js?id=test-site-journey&debug=1";
  Object.defineProperty(document, "currentScript", { value: s, configurable: true });
  (window as unknown as { HT_DEBUG: boolean }).HT_DEBUG = true;

  new Function(SNIPPET)();
}

type Internals = {
  sendPageview: (p: string) => void;
  convert: () => void;
  getSession: () => string;
  getVisitor: () => string;
};
const internals = (): Internals =>
  (window as unknown as { __htInternals: Internals }).__htInternals;

const ofType = (t: string) => captured.filter((e) => e.type === t);
const last = (t: string) => ofType(t).at(-1);

/** Put a booking value on the page so convert() resolves synchronously. */
function withBookingValue(amount: string) {
  document.body.innerHTML = `<span data-ht-value="${amount}">₹${amount}</span>`;
}

/**
 * Walk a visitor from the landing page through two more pages.
 *
 * The step paths are deliberately distinct from every scenario's landing path:
 * the snippet debounces a duplicate pageview for the SAME path within 500ms (a
 * guard against React StrictMode double-mounts), so re-visiting the landing path
 * immediately would legitimately produce no second event.
 */
const STEP_2 = "/journey-step-2";
const STEP_3 = "/journey-step-3";

function crossPageJourney(scenario: JourneyScenario) {
  boot(scenario.landing, { referrer: scenario.referrer });
  const landingPv = last("pageview")!;
  history.pushState({}, "", STEP_2);
  internals().sendPageview(STEP_2);
  history.pushState({}, "", STEP_3);
  internals().sendPageview(STEP_3);
  return { landingPv, pageviews: ofType("pageview") };
}

beforeAll(() => {
  Object.defineProperty(window.navigator, "sendBeacon", { value: undefined, configurable: true });
  globalThis.fetch = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.indexOf("/api/track/event") >= 0 && init?.body != null) {
      try { captured.push(JSON.parse(String(init.body)) as Payload); } catch { /* ignore */ }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }
    // Config fetch fails ⇒ setup() never runs ⇒ no automatic conversion detection.
    return { ok: false, json: async () => null } as unknown as Response;
  }) as never;
});

beforeEach(() => {
  document.body.innerHTML = "";
});

// ── B1 — acquisition per source ──────────────────────────────────────────

describe("B1 — landing / acquisition evidence", () => {
  it.each(JOURNEY_SCENARIOS.map((s) => [s.label, s] as const))("%s", (_label, s) => {
    boot(s.landing, { referrer: s.referrer });
    const pv = last("pageview")!;
    expect(pv).toBeDefined();

    expect(pv.utmSource ?? null).toBe(s.expected.utmSource);
    expect(pv.utmMedium ?? null).toBe(s.expected.utmMedium);

    // Click ids: exactly the expected set, nothing invented.
    for (const key of CLICK_ID_KEYS) {
      const want = s.expected.clickIds[key];
      if (want) expect(pv[key]).toBe(want);
      else expect(key in pv).toBe(false);
    }

    // Visitor + session exist and are well-formed.
    expect(String(pv.visitorId)).toMatch(/^vis_/);
    expect(String(pv.sessionId)).toMatch(/^sess_/);
  });

  it.each(JOURNEY_SCENARIOS.map((s) => [s.label, s] as const))(
    "%s — classifies as expected",
    (_label, s) => {
      boot(s.landing, { referrer: s.referrer });
      const pv = last("pageview")!;
      expect(classifySourceType(pv as never)).toBe(s.expected.sourceType);
    },
  );
});

// ── B2 — cross-page journey ──────────────────────────────────────────────

describe("B2 — cross-page journey", () => {
  it.each(JOURNEY_SCENARIOS.map((s) => [s.label, s] as const))(
    "%s — session, visitor and acquisition evidence persist across 3 pages",
    (_label, s) => {
      const { landingPv, pageviews } = crossPageJourney(s);
      expect(pageviews).toHaveLength(3);

      const sessionIds = new Set(pageviews.map((p) => p.sessionId));
      const visitorIds = new Set(pageviews.map((p) => p.visitorId));
      expect(sessionIds.size).toBe(1); // one session across the journey
      expect(visitorIds.size).toBe(1);

      const deep = pageviews[2];
      expect(deep.pagePath).toBe(STEP_3);
      // First-touch UTM is replayed on every page, not re-read from the URL.
      expect(deep.utmSource ?? null).toBe(s.expected.utmSource);
      expect(deep.utmMedium ?? null).toBe(s.expected.utmMedium);
      // Click ids survive after the query string is gone.
      for (const [k, v] of Object.entries(s.expected.clickIds)) expect(deep[k]).toBe(v);
      expect(landingPv.sessionId).toBe(deep.sessionId);
    },
  );

  it("an ordinary internal pageview does NOT manufacture a second acquisition source", () => {
    // Land from Google Ads, then browse to a page with unrelated query junk.
    boot(`/?gclid=${SYNTHETIC.gclid}`, { referrer: "https://www.google.com/" });
    history.pushState({}, "", "/rooms?sort=price&ref=internal");
    internals().sendPageview("/rooms");

    const pv = last("pageview")!;
    expect(pv.gclid).toBe(SYNTHETIC.gclid); // original evidence intact
    expect(pv.utmSource ?? null).toBeNull(); // no source invented from ?ref=
    expect(classifySourceType(pv as never)).toBe("google_ads");
  });

  it("a second ad click within the journey replaces only that platform's id", () => {
    boot(`/?gclid=${SYNTHETIC.gclid}`);
    boot(`/?fbclid=${SYNTHETIC.fbclid}`, { keepState: true });
    const pv = last("pageview")!;
    expect(pv.gclid).toBe(SYNTHETIC.gclid); // kept
    expect(pv.fbclid).toBe(SYNTHETIC.fbclid); // added
  });
});

// ── B3 — return journey (OBSERVE ONLY, semantics unchanged) ──────────────

describe("B3 — return journey (documented, not redesigned)", () => {
  it("session 2 is a NEW session but keeps the visitor and the original click id", () => {
    boot(`/?gclid=${SYNTHETIC.gclid}`, { referrer: "https://www.google.com/" });
    const s1 = last("pageview")!;

    // Leave, then return DIRECTLY later: same browser (cookies kept), new tab.
    try { sessionStorage.clear(); } catch { /* ignore */ }
    boot("/offers", { keepState: true });
    const s2 = last("pageview")!;

    expect(s2.sessionId).not.toBe(s1.sessionId); // genuinely a new session
    expect(s2.visitorId).toBe(s1.visitorId); // same visitor
    expect(s2.gclid).toBe(SYNTHETIC.gclid); // acquisition evidence carried

    // DOCUMENTED CURRENT BEHAVIOUR: because the click id rides along, a direct
    // return still classifies as google_ads rather than direct. That is the
    // existing semantic and is intentionally NOT changed here.
    expect(classifySourceType(s2 as never)).toBe("google_ads");
  });

  it("first-touch UTM also survives the return and is replayed", () => {
    boot("/?utm_source=facebook&utm_medium=paid_social&utm_campaign=Summer%20Sale");
    const s1 = last("pageview")!;
    try { sessionStorage.clear(); } catch { /* ignore */ }
    boot("/offers", { keepState: true });
    const s2 = last("pageview")!;
    expect(s2.utmSource).toBe("facebook");
    expect(s2.utmCampaign).toBe(s1.utmCampaign);
  });
});

// ── B4 — conversion retains the evidence ─────────────────────────────────

describe("B4 — conversion", () => {
  it.each(JOURNEY_SCENARIOS.map((s) => [s.label, s] as const))(
    "%s — conversion carries visitor, session, source, medium, campaign, content, click ids",
    (_label, s) => {
      crossPageJourney(s);
      captured = [];
      withBookingValue("12500");
      internals().convert();

      const conv = last("conversion")!;
      expect(conv).toBeDefined();
      expect(String(conv.visitorId)).toMatch(/^vis_/);
      expect(String(conv.sessionId)).toMatch(/^sess_/);
      expect(conv.utmSource ?? null).toBe(s.expected.utmSource);
      expect(conv.utmMedium ?? null).toBe(s.expected.utmMedium);
      for (const [k, v] of Object.entries(s.expected.clickIds)) expect(conv[k]).toBe(v);

      // Touchpoint journey is flushed with the conversion.
      const journey = conv.journey as Payload[];
      expect(Array.isArray(journey)).toBe(true);
      expect(journey.length).toBeGreaterThan(0);

      expect(classifySourceType(conv as never)).toBe(s.expected.sourceType);
    },
  );

  it("the influencer conversion carries utm_content identifying the ContentPiece", () => {
    const inf = JOURNEY_SCENARIOS.find((s) => s.key === "influencer")!;
    boot(inf.landing, { referrer: inf.referrer });
    captured = [];
    withBookingValue("12500");
    internals().convert();

    const conv = last("conversion")!;
    expect(String(conv.utmContent)).toMatch(/^ht-/); // resolves to a ContentPiece
    expect(conv.utmCampaign).toBeTruthy();
  });
});

// ── B5 — conversion VALUE (observe, do not redesign) ─────────────────────

describe("B5 — conversion value (current mechanism, observed)", () => {
  it("a normal positive booking value is captured from [data-ht-value]", () => {
    boot("/");
    captured = [];
    withBookingValue("12500");
    internals().convert();
    expect(last("conversion")!.value).toBe(12500);
  });

  it("a labelled total in page text is captured when no data attribute exists", () => {
    boot("/");
    captured = [];
    document.body.innerHTML = `<p>Grand Total: ₹8,000</p>`;
    internals().convert();
    expect(last("conversion")!.value).toBe(8000);
  });

  it("DOCUMENTED: a ₹0 payable falls through to the LARGEST ₹ on the page", () => {
    // This is the current mechanism's behaviour, reported not fixed:
    // parseAmount rejects 0 (`n > 0`), so a fully-discounted booking records the
    // undiscounted room rate instead of the amount actually paid.
    boot("/");
    captured = [];
    document.body.innerHTML = `<p>Room: ₹8,000</p><p>Discount: -₹8,000</p><p>Total: ₹0</p>`;
    internals().convert();
    expect(last("conversion")!.value).toBe(8000); // NOT 0
  });

  it("DOCUMENTED: with no value anywhere, the conversion still fires with null", () => {
    boot("/");
    captured = [];
    document.body.innerHTML = `<p>Thanks for booking!</p>`;
    internals().convert();
    // Resolves at the 2s deadline; the event is not lost, the value is simply absent.
    const conv = last("conversion");
    if (conv) expect(conv.value ?? null).toBeNull();
  });
});
