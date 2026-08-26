// @vitest-environment happy-dom
//
// Phase 1A — click-id capture and PERSISTENCE, exercised against the REAL
// snippet (scripts/snippet.src.js) booted in a DOM. sendBeacon is disabled so
// the snippet falls back to fetch, whose body we capture as each event payload.
//
// What these prove, end to end in the browser half of the system:
//   • the four identifiers are read off the landing URL
//   • they are stored in a FIRST-PARTY cookie (no third-party cookie, no
//     localStorage) so they outlive the query string
//   • they ride on every later event — including a conversion fired pages later,
//     long after the query string is gone
//   • an internal navigation cannot erase them
//   • junk values never reach the wire
//
// The server-side half (persisting them onto Session/Touchpoint/TrackingEvent)
// needs database columns and is deliberately NOT implemented yet.

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SRC = path.resolve(process.cwd(), "scripts/snippet.src.js");
const SNIPPET = readFileSync(SRC, "utf8");
/** Snippet source with comments stripped, for "this API is never called" checks. */
const CODE_ONLY = SNIPPET.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

const GCLID = "TEST_GCLID_123";
const GBRAID = "TEST_GBRAID_123";
const WBRAID = "TEST_WBRAID_123";
const FBCLID = "TEST_FBCLID_123";

const COOKIE = "_ht_clk";

let captured: Record<string, unknown>[] = [];

type Internals = {
  VERSION: string;
  getClickIds: () => Record<string, string>;
  urlClickIds: () => Record<string, string> | null;
  normClickId: (v: unknown) => string | null;
  sendPageview: (path: string) => void;
  convert: () => void;
};

function internals(): Internals {
  const i = (window as unknown as { __htInternals?: Internals }).__htInternals;
  if (!i) throw new Error("snippet did not expose __htInternals — bootstrap failed");
  return i;
}

/** Wipe every cookie the snippet owns, so each boot starts clean. */
function clearCookies() {
  for (const pair of document.cookie.split(";")) {
    const name = pair.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

/**
 * Boot the snippet at `url`. `keepCookies` simulates a RETURNING visitor: the
 * browser still holds the cookies from the previous boot.
 */
function boot(url: string, opts: { keepCookies?: boolean } = {}) {
  if (!opts.keepCookies) {
    clearCookies();
    try { sessionStorage.clear(); } catch { /* ignore */ }
  }
  captured = [];
  history.replaceState({}, "", url);

  const s = document.createElement("script");
  s.src = "https://app.example.com/t.js?id=test-site-clk&debug=1";
  Object.defineProperty(document, "currentScript", { value: s, configurable: true });
  (window as unknown as { HT_DEBUG: boolean }).HT_DEBUG = true;

  new Function(SNIPPET)();
}

const eventsOfType = (type: string) => captured.filter((e) => e.type === type);
const lastOfType = (type: string) => eventsOfType(type).at(-1);

beforeAll(() => {
  Object.defineProperty(window.navigator, "sendBeacon", { value: undefined, configurable: true });
  globalThis.fetch = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.indexOf("/api/track/event") >= 0 && init?.body != null) {
      try { captured.push(JSON.parse(String(init.body))); } catch { /* ignore */ }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }
    // Config fetch: not ok ⇒ setup() never runs, so no conversion auto-detection.
    return { ok: false, json: async () => null } as unknown as Response;
  }) as never;
});

beforeEach(() => {
  document.body.innerHTML = "";
});

// ── Version ────────────────────────────────────────────────────────────────

describe("snippet version", () => {
  it("reports v2.5.0 on every event", () => {
    boot("/?gclid=" + GCLID);
    expect(internals().VERSION).toBe("2.5.0");
    expect(lastOfType("pageview")!.v).toBe("2.5.0");
  });
});

// ── 1–4. Capture from the landing URL ─────────────────────────────────────

describe("capture from the landing URL", () => {
  it("1. captures gclid", () => {
    boot(`/?gclid=${GCLID}`);
    expect(internals().getClickIds().gclid).toBe(GCLID);
    expect(lastOfType("pageview")!.gclid).toBe(GCLID);
  });

  it("2. captures gbraid", () => {
    boot(`/?gbraid=${GBRAID}`);
    expect(lastOfType("pageview")!.gbraid).toBe(GBRAID);
  });

  it("3. captures wbraid", () => {
    boot(`/?wbraid=${WBRAID}`);
    expect(lastOfType("pageview")!.wbraid).toBe(WBRAID);
  });

  it("4. captures fbclid", () => {
    boot(`/?fbclid=${FBCLID}`);
    expect(lastOfType("pageview")!.fbclid).toBe(FBCLID);
  });

  it("captures a Google and a Meta id together", () => {
    boot(`/?gclid=${GCLID}&fbclid=${FBCLID}`);
    const ids = internals().getClickIds();
    expect(ids.gclid).toBe(GCLID);
    expect(ids.fbclid).toBe(FBCLID);
  });

  it("omits absent identifiers from the payload entirely (no null noise)", () => {
    boot(`/?gclid=${GCLID}`);
    const pv = lastOfType("pageview")!;
    expect(pv.gclid).toBe(GCLID);
    expect("gbraid" in pv).toBe(false);
    expect("fbclid" in pv).toBe(false);
  });

  it("a visit with no click ids sends none", () => {
    boot("/");
    const pv = lastOfType("pageview")!;
    for (const k of ["gclid", "gbraid", "wbraid", "fbclid"]) expect(k in pv).toBe(false);
  });
});

// ── 5. UTMs still captured alongside ──────────────────────────────────────

describe("5. UTM capture is unaffected", () => {
  it("keeps the existing first-touch UTM fields", () => {
    boot(`/?utm_source=facebook&utm_medium=paid_social&utm_campaign=Summer&fbclid=${FBCLID}`);
    const pv = lastOfType("pageview")!;
    expect(pv.utmSource).toBe("facebook");
    expect(pv.utmMedium).toBe("paid_social");
    expect(pv.utmCampaign).toBe("Summer");
    expect(pv.fbclid).toBe(FBCLID);
  });

  it("an auto-tagged Google click has a click id and NO utms — the whole point", () => {
    boot(`/?gclid=${GCLID}`);
    const pv = lastOfType("pageview")!;
    expect(pv.gclid).toBe(GCLID);
    expect(pv.utmSource).toBeNull();
    expect(pv.utmMedium).toBeNull();
  });
});

// ── Persistence: cookie, navigation, session, conversion ──────────────────

describe("persistence", () => {
  it("stores the ids in a first-party cookie", () => {
    boot(`/?gclid=${GCLID}`);
    expect(document.cookie).toContain(COOKIE);
    const raw = decodeURIComponent(document.cookie.split(`${COOKIE}=`)[1]!.split(";")[0]!);
    expect(JSON.parse(raw).gclid).toBe(GCLID);
  });

  it("does not use localStorage anywhere (source-level, environment-independent)", () => {
    // Asserted against the source rather than the runtime: localStorage is not
    // available in this Node/happy-dom setup, and the guarantee we care about is
    // that the snippet never reaches for it in the first place. Comments are
    // stripped so the word appearing in a "no localStorage" note doesn't count.
    expect(CODE_ONLY).not.toContain("localStorage");
    // Persistence is cookies (cross-session) + sessionStorage (per-tab), both
    // first-party. sessionStorage is the pre-existing session-id mechanism.
    expect(SNIPPET).toContain("document.cookie");
  });

  it("8. survives internal navigation, after the query string is gone", () => {
    boot(`/?gclid=${GCLID}`);
    captured = [];
    // Navigate to a clean internal URL — no query string at all.
    history.pushState({}, "", "/rooms");
    internals().sendPageview("/rooms");

    const pv = lastOfType("pageview")!;
    expect(pv.pagePath).toBe("/rooms");
    expect(pv.gclid).toBe(GCLID); // still there
  });

  it("9. survives into a NEW session (returning visitor, cookies intact)", () => {
    boot(`/?gclid=${GCLID}`);
    const firstSession = lastOfType("pageview")!.sessionId;

    // Returning later: same browser (cookies kept), fresh tab (sessionStorage
    // cleared ⇒ new session id), and a plain URL with no ad parameters.
    try { sessionStorage.clear(); } catch { /* ignore */ }
    boot("/offers", { keepCookies: true });

    const pv = lastOfType("pageview")!;
    expect(pv.sessionId).not.toBe(firstSession); // genuinely a new session
    expect(pv.gclid).toBe(GCLID); // evidence carried across
  });

  it("10. reaches the conversion event fired pages later", () => {
    boot(`/?gclid=${GCLID}&fbclid=${FBCLID}`);
    history.pushState({}, "", "/rooms");
    internals().sendPageview("/rooms");
    history.pushState({}, "", "/thank-you");
    internals().sendPageview("/thank-you");
    captured = [];

    // convert() resolves the booking value before sending. With a value already
    // in the DOM, waitForBookingValue settles synchronously (no 2s deadline).
    document.body.innerHTML = '<span data-ht-value="12500"></span>';
    internals().convert();

    const conv = lastOfType("conversion");
    expect(conv).toBeDefined();
    expect(conv!.gclid).toBe(GCLID);
    expect(conv!.fbclid).toBe(FBCLID);
  });

  it("11. an internal navigation cannot erase a stored identifier", () => {
    boot(`/?gclid=${GCLID}`);
    history.pushState({}, "", "/rooms"); // no gclid in this URL
    internals().sendPageview("/rooms");
    expect(internals().getClickIds().gclid).toBe(GCLID);

    const raw = decodeURIComponent(document.cookie.split(`${COOKIE}=`)[1]!.split(";")[0]!);
    expect(JSON.parse(raw).gclid).toBe(GCLID);
  });

  it("a genuinely new ad click replaces that platform's id", () => {
    boot(`/?gclid=${GCLID}`);
    boot("/?gclid=TEST_GCLID_456", { keepCookies: true });
    expect(internals().getClickIds().gclid).toBe("TEST_GCLID_456");
  });

  it("a Meta click after a Google click keeps BOTH", () => {
    boot(`/?gclid=${GCLID}`);
    boot(`/?fbclid=${FBCLID}`, { keepCookies: true });
    const ids = internals().getClickIds();
    expect(ids.gclid).toBe(GCLID);
    expect(ids.fbclid).toBe(FBCLID);
  });
});

// ── 12. Malformed input never reaches the wire ────────────────────────────

describe("12. malformed identifiers", () => {
  it("rejects an over-length value", () => {
    const tooLong = "a".repeat(256);
    boot(`/?gclid=${tooLong}`);
    expect("gclid" in lastOfType("pageview")!).toBe(false);
    expect(document.cookie).not.toContain(COOKIE);
  });

  it("rejects values outside the URL-safe charset", () => {
    expect(internals().normClickId("abc def")).toBeNull();
    expect(internals().normClickId("<script>")).toBeNull();
    expect(internals().normClickId("abc;def")).toBeNull();
    expect(internals().normClickId("")).toBeNull();
    expect(internals().normClickId(null)).toBeNull();
  });

  it("a malformed id on the URL leaves the visit un-tagged rather than tagged wrong", () => {
    boot("/?gclid=%3Cscript%3E");
    expect("gclid" in lastOfType("pageview")!).toBe(false);
  });

  it("accepts the real-world charset", () => {
    expect(internals().normClickId("Cj0KCQjw-abc_DEF.123-xyz")).toBe("Cj0KCQjw-abc_DEF.123-xyz");
  });
});

// ── Journey touches carry the click id of the click that happened ─────────

describe("journey touchpoints", () => {
  it("stamps the landing click id onto the touch, and flushes it on conversion", () => {
    boot(`/?gclid=${GCLID}`);
    captured = [];
    document.body.innerHTML = '<span data-ht-value="12500"></span>';
    internals().convert();

    const conv = lastOfType("conversion")!;
    const journey = conv.journey as Record<string, unknown>[];
    expect(Array.isArray(journey)).toBe(true);
    expect(journey.length).toBeGreaterThan(0);
    expect(journey[0].gclid).toBe(GCLID);
  });

  it("does NOT stamp the remembered id onto a later, un-tagged touch", () => {
    // A touch describes ONE marketing interaction. Copying the stored id onto
    // every later touch would invent ad clicks that never happened.
    boot(`/?gclid=${GCLID}`);
    boot("/", { keepCookies: true }); // a later, direct return visit
    captured = [];
    document.body.innerHTML = '<span data-ht-value="12500"></span>';
    internals().convert();

    const journey = lastOfType("conversion")!.journey as Record<string, unknown>[];
    const tagged = journey.filter((t) => t.gclid === GCLID);
    expect(tagged.length).toBe(1); // exactly the one real ad click
  });
});
