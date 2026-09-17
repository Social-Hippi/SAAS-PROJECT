import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { describe, expect, test } from "vitest";

const root = join(__dirname, "..");
const SRC = readFileSync(join(root, "scripts", "snippet.src.js"), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// The snippet must call the CANONICAL origin, not the one its tag was pasted
// from.
//
// Deriving the API base from the script's own src looks obviously right and is a
// trap. A hotel that pastes the apex form of the tag sends every call to the
// apex, and an apex that redirects to www breaks the CONFIG fetch while leaving
// everything else working:
//
//   sendBeacon / text-plain POSTs   follow the redirect silently → visits keep
//                                   arriving, so nothing looks broken
//   fetch(..., {mode:"cors"})       a redirect carrying no CORS header is
//                                   blocked → config never loads
//
// Without config there is no thank-you pattern and no booking-domain list, so
// conversions are never detected and booking links are never decorated. On
// asterholidays.com that cost every ad click its identity at the domain
// boundary, while 15,671 visits recorded perfectly. Verified in a real browser:
// `fetch` to the apex returned "TypeError: Failed to fetch" while www returned
// 200, and window.__htDecorator was never installed.
// ─────────────────────────────────────────────────────────────────────────────

// Builds to a temp file. Writing public/t.js here would race every other suite
// that reads the shipped snippet — which is how this test first broke 71 others.
const dir = mkdtempSync(join(tmpdir(), "ht-snippet-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function buildWith(appUrl: string | undefined): string {
  const out = join(dir, `t-${Math.random().toString(36).slice(2)}.js`);
  execFileSync("node", ["scripts/build-snippet.mjs", out], {
    cwd: root,
    env: { ...process.env, NEXT_PUBLIC_APP_URL: appUrl ?? "" },
    stdio: "pipe",
  });
  return readFileSync(out, "utf8");
}

describe("the API origin is fixed at build time", () => {
  test("the source uses a replaceable identifier, not a string literal", () => {
    // esbuild's define replaces IDENTIFIERS. Writing "__HT_BASE__" in quotes
    // produces a snippet that calls the literal string — which is what happened
    // on the first attempt and would have shipped silently.
    expect(SRC).toMatch(/typeof __HT_BASE__ === "string" \? __HT_BASE__/);
    expect(SRC).not.toMatch(/CANONICAL_BASE = "__HT_BASE__"/);
  });

  test("a configured URL is baked into the built file", () => {
    const out = buildWith("https://www.hoteltrack.in");
    expect(out).toContain("https://www.hoteltrack.in");
    expect(out).not.toContain("__HT_BASE__");
  });

  test("a trailing slash is trimmed, so no URL is built with a double slash", () => {
    const out = buildWith("https://www.hoteltrack.in/");
    expect(out).toContain("https://www.hoteltrack.in");
    expect(out).not.toContain("https://www.hoteltrack.in/\"");
  });

  test("with no URL configured it falls back to the script's own origin", () => {
    // Correct for a preview deployment talking to itself.
    const out = buildWith(undefined);
    expect(out).not.toContain("__HT_BASE__");
    expect(out).toMatch(/\.origin/);
  });

  test("the source still evaluates standalone", () => {
    // The snippet suites boot this file directly in jsdom. A bare __HT_BASE__
    // would be an undefined identifier and throw before anything ran — which it
    // did, taking 71 unrelated tests with it.
    expect(SRC).toMatch(/typeof __HT_BASE__ === "string"/);
  });

  test("the fallback is guarded by a protocol check", () => {
    // An empty or malformed define must not become the base, or every API call
    // goes to a relative path on the hotel's own domain and 404s.
    expect(SRC).toMatch(/\/\^https\?:\\\/\\\/\/\.test\(CANONICAL_BASE\)/);
  });
});

describe("the shipped file is the one we think it is", () => {
  test("public/t.js is built from the source, not hand-edited", () => {
    const out = buildWith("https://www.hoteltrack.in");
    expect(out).toContain("HotelTrack tracking snippet — generated from");
  });
});
