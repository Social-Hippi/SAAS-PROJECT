// @vitest-environment happy-dom
//
// Cross-domain journey handoff — the REAL snippet booted in a DOM, plus the
// server-side token contract.
//
// THE DEFECT THIS CLOSES (observed in production, Aster Holidays):
// an influencer journey persisted exactly ONE pageview and then vanished. The
// booking CTA leaves asterholidays.com for bookings.coffeeberryhills.in, and
// sessionStorage plus the visitor cookie are origin-scoped — so the visit that
// continued there began as a brand-new visitor with no UTMs. Influencer,
// campaign and content were all lost at the hop, and no downstream conversion
// could ever be joined back to the click.
//
// These tests prove the token carries the journey across, and — just as
// important — that it can NEVER overwrite stronger, first-hand evidence.

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  JOURNEY_PARAM,
  JOURNEY_TOKEN_VERSION,
  MAX_TOKEN_AGE_MS,
  MAX_TOKEN_LENGTH,
  encodeJourneyToken,
  decodeJourneyToken,
  isBookingDomain,
} from "@/lib/journey-token";

const SNIPPET = readFileSync(path.resolve(process.cwd(), "scripts/snippet.src.js"), "utf8");
const BOOKING_HOST = "bookings.coffeeberryhills.in";
const NOW = 1_800_000_000_000;

let captured: Record<string, unknown>[] = [];

function clearCookies() {
  for (const pair of document.cookie.split(";")) {
    const n = pair.split("=")[0]?.trim();
    if (n) document.cookie = `${n}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

/** Boot the snippet at `url`, with `bookingDomains` returned by the config fetch. */
function boot(url: string, opts: { domains?: string[]; keepCookies?: boolean } = {}) {
  if (!opts.keepCookies) {
    clearCookies();
    try { sessionStorage.clear(); } catch { /* ignore */ }
  }
  captured = [];
  history.replaceState({}, "", url);
  (globalThis as unknown as { __htDomains: string[] }).__htDomains = opts.domains ?? [];

  const s = document.createElement("script");
  s.src = "https://app.example.com/t.js?id=test-site-xdomain&debug=1";
  Object.defineProperty(document, "currentScript", { value: s, configurable: true });
  new Function(SNIPPET)();
}

type Internals = { VERSION: string; getSession: () => string; getVisitor: () => string };
const internals = () => (window as unknown as { __htInternals: Internals }).__htInternals;
const lastOfType = (t: string) => captured.filter((e) => e.type === t).at(-1);

/** Click an anchor the way a real visitor would, so the capture listener runs. */
/** Let the async config fetch resolve so decoration is armed. */
const flushConfig = () => new Promise((r) => setTimeout(r, 0));

function clickAnchor(href: string): string {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  a.textContent = "Book now";
  // Swallow the default action. The snippet's decorator runs in the CAPTURE
  // phase, so it has already rewritten the href by the time this bubble-phase
  // listener fires — but without it happy-dom follows the link and mutates
  // `location`, leaking the booking-engine origin into later tests.
  a.addEventListener("click", (e) => e.preventDefault());
  document.body.appendChild(a);
  a.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  return a.getAttribute("href") ?? "";
}

const tokenFrom = (href: string) => new URL(href, "https://hotel.example").searchParams.get(JOURNEY_PARAM);

beforeAll(() => {
  Object.defineProperty(window.navigator, "sendBeacon", { value: undefined, configurable: true });
  globalThis.fetch = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.includes("/api/track/event") && init?.body != null) {
      try { captured.push(JSON.parse(String(init.body))); } catch { /* ignore */ }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }
    if (u.includes("/api/track/config")) {
      const domains = (globalThis as unknown as { __htDomains: string[] }).__htDomains ?? [];
      return {
        ok: true,
        json: async () => ({ method: "url_change", thankYouUrlPattern: null, bookingDomains: domains }),
      } as unknown as Response;
    }
    return { ok: false, json: async () => null } as unknown as Response;
  }) as never;
});

beforeEach(() => { document.body.innerHTML = ""; });

// ── Token contract (pure) ────────────────────────────────────────────────

describe("journey token contract", () => {
  const base = { sessionId: "sess_a", visitorId: "vis_a", now: NOW };

  it("round-trips session, visitor, UTMs and click ids", () => {
    const tok = encodeJourneyToken({
      ...base,
      utms: { utm_source: "instagram", utm_medium: "influencer", utm_content: "ht-abc123" },
      clickIds: { gclid: "G-1" },
    })!;
    const p = decodeJourneyToken(tok, NOW)!;
    expect(p.s).toBe("sess_a");
    expect(p.i).toBe("vis_a");
    expect(p.u.utm_source).toBe("instagram");
    expect(p.u.utm_content).toBe("ht-abc123");
    expect(p.c.gclid).toBe("G-1");
    expect(p.v).toBe(JOURNEY_TOKEN_VERSION);
  });

  it("is URL-safe — survives a query string untouched", () => {
    const tok = encodeJourneyToken({ ...base, utms: { utm_campaign: "summer/sale+2026 &x" } })!;
    const u = new URL(`https://${BOOKING_HOST}/?propertyId=8642`);
    u.searchParams.set(JOURNEY_PARAM, tok);
    expect(decodeJourneyToken(new URL(u.toString()).searchParams.get(JOURNEY_PARAM), NOW)!.u.utm_campaign)
      .toBe("summer/sale+2026 &x");
    expect(tok).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("carries NO personally identifying data", () => {
    const tok = encodeJourneyToken({ ...base, utms: { utm_source: "instagram" } })!;
    const decoded = Buffer.from(tok.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    for (const k of ["email", "phone", "name", "ip", "@"]) expect(decoded).not.toContain(k);
    expect(Object.keys(JSON.parse(decoded)).sort()).toEqual(["c", "i", "s", "t", "u", "v"]);
  });

  it.each([
    ["expired", MAX_TOKEN_AGE_MS + 1],
    ["minted in the future (skew/tamper)", -1000],
  ])("rejects a token %s", (_label, offset) => {
    const tok = encodeJourneyToken({ ...base, now: NOW - offset })!;
    expect(decodeJourneyToken(tok, NOW)).toBeNull();
  });

  it.each([
    ["garbage", "!!!not-base64!!!"],
    ["empty", ""],
    ["null", null],
    ["oversized", "A".repeat(MAX_TOKEN_LENGTH + 1)],
  ])("rejects %s without throwing", (_l, v) => {
    expect(decodeJourneyToken(v as string | null, NOW)).toBeNull();
  });

  it("rejects a token from a different format version", () => {
    const raw = JSON.stringify({ s: "s", i: "i", u: {}, c: {}, t: NOW, v: 99 });
    const tok = Buffer.from(raw, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeJourneyToken(tok, NOW)).toBeNull();
  });

  it("returns null when there is no session or visitor to carry", () => {
    expect(encodeJourneyToken({ sessionId: "", visitorId: "v", now: NOW })).toBeNull();
    expect(encodeJourneyToken({ sessionId: "s", visitorId: null, now: NOW })).toBeNull();
  });
});

// ── Booking-domain matching (security) ───────────────────────────────────

describe("booking-domain matching", () => {
  it("matches the exact host and true subdomains", () => {
    expect(isBookingDomain("coffeeberryhills.in", ["coffeeberryhills.in"])).toBe(true);
    expect(isBookingDomain("bookings.coffeeberryhills.in", ["coffeeberryhills.in"])).toBe(true);
  });

  it("NEVER matches a lookalike suffix", () => {
    expect(isBookingDomain("evil-coffeeberryhills.in", ["coffeeberryhills.in"])).toBe(false);
    expect(isBookingDomain("coffeeberryhills.in.attacker.com", ["coffeeberryhills.in"])).toBe(false);
  });

  it("is empty-safe — no domains configured means no decoration", () => {
    expect(isBookingDomain("bookings.example.com", [])).toBe(false);
    expect(isBookingDomain("bookings.example.com", null)).toBe(false);
    expect(isBookingDomain(null, ["example.com"])).toBe(false);
  });
});

// ── Sending half: decoration ─────────────────────────────────────────────

describe("sending half — outbound links to the booking engine", () => {
  const INFLUENCER_URL =
    "/coffeeberry-hills-chikmagalur-resort/?utm_source=instagram&utm_medium=influencer" +
    "&utm_campaign=krishitha-panda&utm_content=ht-cmt8qzkzx002e04jx944pz800";

  it("decorates a booking-engine link with a token carrying the influencer journey", async () => {
    boot(INFLUENCER_URL, { domains: [BOOKING_HOST] });
    await flushConfig();
    const href = clickAnchor(`https://${BOOKING_HOST}/?propertyId=8642`);
    const p = decodeJourneyToken(tokenFrom(href), Date.now())!;
    expect(p).not.toBeNull();
    expect(p.u.utm_source).toBe("instagram");
    expect(p.u.utm_medium).toBe("influencer");
    expect(p.u.utm_content).toBe("ht-cmt8qzkzx002e04jx944pz800");
    expect(p.s).toBe(internals().getSession());
    expect(p.i).toBe(internals().getVisitor());
  });

  it("preserves the destination's own query parameters", async () => {
    boot(INFLUENCER_URL, { domains: [BOOKING_HOST] });
    await flushConfig();
    const u = new URL(clickAnchor(`https://${BOOKING_HOST}/?propertyId=8642`));
    expect(u.searchParams.get("propertyId")).toBe("8642");
    expect(u.host).toBe(BOOKING_HOST);
  });

  it("does NOT decorate a host that is not configured", async () => {
    boot(INFLUENCER_URL, { domains: [BOOKING_HOST] });
    await flushConfig();
    expect(tokenFrom(clickAnchor("https://someone-else.example/?x=1"))).toBeNull();
  });

  it("does NOT decorate when the hotel has configured no booking domains", async () => {
    boot(INFLUENCER_URL, { domains: [] });
    await flushConfig();
    expect(tokenFrom(clickAnchor(`https://${BOOKING_HOST}/?propertyId=8642`))).toBeNull();
  });

  it("does NOT decorate same-origin links", async () => {
    boot(INFLUENCER_URL, { domains: [BOOKING_HOST, "localhost"] });
    await flushConfig();
    expect(tokenFrom(clickAnchor("/rooms"))).toBeNull();
  });

  it("leaves non-http schemes alone (tel:, mailto:, whatsapp)", async () => {
    boot(INFLUENCER_URL, { domains: [BOOKING_HOST] });
    await flushConfig();
    for (const h of ["tel:+919243400500", "mailto:x@y.z"]) expect(clickAnchor(h)).toBe(h);
  });

  it("does not double-decorate an already-tokenised link", async () => {
    boot(INFLUENCER_URL, { domains: [BOOKING_HOST] });
    await flushConfig();
    const first = clickAnchor(`https://${BOOKING_HOST}/?propertyId=8642`);
    const a = document.querySelector("a")!;
    a.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(a.getAttribute("href")).toBe(first);
  });

  it("carries ad click ids across too", async () => {
    boot("/?gclid=G-XDOMAIN-1", { domains: [BOOKING_HOST] });
    await flushConfig();
    const p = decodeJourneyToken(tokenFrom(clickAnchor(`https://${BOOKING_HOST}/`)), Date.now())!;
    expect(p.c.gclid).toBe("G-XDOMAIN-1");
  });
});

// ── Receiving half: adoption ─────────────────────────────────────────────

describe("receiving half — the booking engine adopts the journey", () => {
  const mint = (over: Partial<Parameters<typeof encodeJourneyToken>[0]> = {}) =>
    encodeJourneyToken({
      sessionId: "sess_origin", visitorId: "vis_origin", now: Date.now(),
      utms: { utm_source: "instagram", utm_medium: "influencer", utm_content: "ht-abc123def" },
      clickIds: {},
      ...over,
    })!;

  it("adopts the visitor and the influencer attribution", () => {
    boot(`/?propertyId=8642&${JOURNEY_PARAM}=${mint()}`, { domains: [BOOKING_HOST] });
    const pv = lastOfType("pageview")!;
    expect(pv.utmSource).toBe("instagram");
    expect(pv.utmMedium).toBe("influencer");
    expect(pv.utmContent).toBe("ht-abc123def");
    expect(pv.visitorId).toBe("vis_origin");
  });

  it("CONTINUES the originating session so the journey is one visit, not two", () => {
    boot(`/?${JOURNEY_PARAM}=${mint()}`, { domains: [BOOKING_HOST] });
    expect(internals().getSession()).toBe("sess_origin");
    expect(internals().getVisitor()).toBe("vis_origin");
    expect(lastOfType("pageview")!.sessionId).toBe("sess_origin");
  });

  it("does NOT hijack a session already live on this origin", () => {
    boot("/", { domains: [BOOKING_HOST] });
    const own = internals().getSession();
    // Same tab (sessionStorage intact) now receives a token: its own live
    // session must win — a token continues a journey, it never replaces one.
    history.replaceState({}, "", `/?${JOURNEY_PARAM}=${mint()}`);
    new Function(readFileSync(path.resolve(process.cwd(), "scripts/snippet.src.js"), "utf8"))();
    expect(internals().getSession()).toBe(own);
  });

  it("NEVER overwrites attribution the receiving page already has", () => {
    boot(`/?utm_source=google&utm_medium=cpc&${JOURNEY_PARAM}=${mint()}`, { domains: [BOOKING_HOST] });
    const pv = lastOfType("pageview")!;
    expect(pv.utmSource).toBe("google");
    expect(pv.utmMedium).toBe("cpc");
  });

  it("NEVER overwrites an existing visitor identity on this origin", () => {
    boot("/", { domains: [BOOKING_HOST] });
    const original = internals().getVisitor();
    boot(`/?${JOURNEY_PARAM}=${mint()}`, { domains: [BOOKING_HOST], keepCookies: true });
    expect(internals().getVisitor()).toBe(original);
  });

  it("NEVER lets a handoff click id displace one seen on this URL", () => {
    const tok = mint({ clickIds: { gclid: "G-FROM-TOKEN" } });
    boot(`/?gclid=G-DIRECT&${JOURNEY_PARAM}=${tok}`, { domains: [BOOKING_HOST] });
    expect(lastOfType("pageview")!.gclid).toBe("G-DIRECT");
  });

  it("ignores an EXPIRED token — a shared link cannot hijack a journey", () => {
    const stale = encodeJourneyToken({
      sessionId: "sess_old", visitorId: "vis_old",
      utms: { utm_source: "instagram", utm_medium: "influencer" },
      now: Date.now() - MAX_TOKEN_AGE_MS - 60_000,
    })!;
    boot(`/?${JOURNEY_PARAM}=${stale}`, { domains: [BOOKING_HOST] });
    const pv = lastOfType("pageview")!;
    expect(pv.utmSource).toBeNull();
    expect(pv.visitorId).not.toBe("vis_old");
  });

  it("ignores a malformed token and still tracks the page normally", () => {
    boot(`/?${JOURNEY_PARAM}=!!!garbage!!!`, { domains: [BOOKING_HOST] });
    const pv = lastOfType("pageview")!;
    expect(pv).toBeTruthy();
    expect(pv.utmSource).toBeNull();
  });
});

// ── Round trip: the exact Aster failure ──────────────────────────────────

describe("the Aster journey, end to end", () => {
  it("influencer link -> hotel site -> booking engine keeps ONE visitor and the influencer", async () => {
    boot(
      "/coffeeberry-hills-chikmagalur-resort/?utm_source=instagram&utm_medium=influencer" +
        "&utm_campaign=krishitha-panda&utm_content=ht-cmt8qzkzx002e04jx944pz800",
      { domains: [BOOKING_HOST] },
    );
    await flushConfig();
    const originVisitor = internals().getVisitor();
    const href = clickAnchor(`https://${BOOKING_HOST}/?propertyId=8642`);

    // The visitor lands on the booking engine: different origin, so no cookies.
    const token = tokenFrom(href)!;
    boot(`/?propertyId=8642&${JOURNEY_PARAM}=${token}`, { domains: [BOOKING_HOST] });

    const pv = lastOfType("pageview")!;
    expect(pv.visitorId).toBe(originVisitor);
    expect(pv.utmContent).toBe("ht-cmt8qzkzx002e04jx944pz800");
    expect(pv.utmCampaign).toBe("krishitha-panda");
  });
});
