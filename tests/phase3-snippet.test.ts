// @vitest-environment happy-dom
//
// Snippet v2.2 source-level coverage: boots the REAL snippet (scripts/
// snippet.src.js) in a DOM and verifies that click / form-field / identify
// behaviors fire the right beacons. We disable sendBeacon so the snippet falls
// back to fetch, which we stub to capture each event payload.

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SRC = path.resolve(process.cwd(), "scripts/snippet.src.js");

let captured: Record<string, unknown>[] = [];

function eventsOfType(type: string) {
  return captured.filter((e) => e.type === type);
}

beforeAll(() => {
  // Force the fetch transport so we can read the (string) body of every event.
  Object.defineProperty(window.navigator, "sendBeacon", { value: undefined, configurable: true });
  globalThis.fetch = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.indexOf("/api/track/event") >= 0 && init?.body != null) {
      try { captured.push(JSON.parse(String(init.body))); } catch {}
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }
    // Config fetch (and anything else): not ok ⇒ snippet's setup() never runs.
    return { ok: false, json: async () => null } as unknown as Response;
  }) as never;

  const s = document.createElement("script");
  s.src = "https://app.example.com/t.js?id=test-site-p3&debug=1";
  Object.defineProperty(document, "currentScript", { value: s, configurable: true });
  (window as unknown as { HT_DEBUG: boolean }).HT_DEBUG = true;

  new Function(readFileSync(SRC, "utf8"))();

  const internals = (window as unknown as { __htInternals?: { VERSION?: string } }).__htInternals;
  if (!internals) throw new Error("snippet did not expose __htInternals — bootstrap failed");
  // v2.5 added the cross-domain journey handoff; v2.4 added ad click ids
  // (Phase 1A). Everything asserted in this file is
  // v2.2 behaviour and must keep working unchanged across that bump.
  expect(internals.VERSION).toBe("2.5.0");
});

beforeEach(() => {
  document.body.innerHTML = "";
  captured = [];
});

describe("click tracking", () => {
  it("captures a click on a [data-ht-click] element", () => {
    document.body.innerHTML = `<button data-ht-click="book-now">Book Now</button>`;
    document.querySelector("button")!.dispatchEvent(new Event("click", { bubbles: true }));

    const clicks = eventsOfType("click");
    expect(clicks.length).toBe(1);
    expect(clicks[0].clickTarget).toBe("book-now");
    expect(clicks[0].elementTag).toBe("BUTTON");
    expect(clicks[0].elementText).toBe("Book Now");
  });

  it("walks up to the nearest tagged ancestor", () => {
    document.body.innerHTML = `<a data-ht-click="cta"><span id="kid">Go</span></a>`;
    document.getElementById("kid")!.dispatchEvent(new Event("click", { bubbles: true }));

    const clicks = eventsOfType("click");
    expect(clicks.length).toBe(1);
    expect(clicks[0].clickTarget).toBe("cta");
    expect(clicks[0].elementTag).toBe("A");
  });

  it("ignores clicks on untagged elements", () => {
    document.body.innerHTML = `<button id="plain">Plain</button>`;
    document.getElementById("plain")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(eventsOfType("click").length).toBe(0);
  });
});

describe("form field tracking", () => {
  it("fires form_field_focused, then form_field_blurred with hasValue=false when empty", () => {
    document.body.innerHTML = `<input data-ht-form-field="date-picker" />`;
    const input = document.querySelector("input")!;
    input.dispatchEvent(new Event("focus", { bubbles: false }));
    input.dispatchEvent(new Event("blur", { bubbles: false }));

    const focused = eventsOfType("form_field_focused");
    const blurred = eventsOfType("form_field_blurred");
    expect(focused.length).toBe(1);
    expect(focused[0].fieldName).toBe("date-picker");
    expect(blurred.length).toBe(1);
    expect(blurred[0].hasValue).toBe(false);
  });

  it("reports hasValue=true when the field has content (never the value itself)", () => {
    document.body.innerHTML = `<input data-ht-form-field="email" />`;
    const input = document.querySelector("input")! as HTMLInputElement;
    input.value = "someone@example.com";
    input.dispatchEvent(new Event("blur", { bubbles: false }));

    const blurred = eventsOfType("form_field_blurred");
    expect(blurred.length).toBe(1);
    expect(blurred[0].hasValue).toBe(true);
    // The raw value is never part of the payload.
    expect(JSON.stringify(blurred[0])).not.toContain("someone@example.com");
  });

  it("ignores untagged inputs", () => {
    document.body.innerHTML = `<input id="plain" />`;
    document.getElementById("plain")!.dispatchEvent(new Event("focus", { bubbles: false }));
    expect(eventsOfType("form_field_focused").length).toBe(0);
  });
});

describe("visitor identification", () => {
  it("htIdentify({name, email}) fires an identify event and never sends a raw email", async () => {
    (window as unknown as { htIdentify: (o: Record<string, unknown>) => void }).htIdentify({
      name: "Test User",
      email: "test@example.com", // hashed in-browser (async) before sending
    });
    // The email is SHA-256-hashed via Web Crypto, so the beacon fires on the
    // resolved promise — flush microtasks/timers before asserting.
    await new Promise((r) => setTimeout(r, 20));

    const ids = eventsOfType("identify");
    expect(ids.length).toBe(1);
    expect(ids[0].name).toBe("Test User");
    // The email left the browser ONLY as a SHA-256 hash — never the raw value.
    expect(ids[0].emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(captured)).not.toContain("test@example.com");
    // The identity cookie is set so later sessions can be re-linked.
    expect(document.cookie).toContain("ht_visitor_identity");
  });
});
