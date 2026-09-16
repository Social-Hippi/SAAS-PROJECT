import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { normalizePhone } from "@/lib/pii-client";

// ─────────────────────────────────────────────────────────────────────────────
// ONE canonical phone form, on both sides of the network.
//
// normalizePhone used to be `replace(/[^0-9]/g, "")`. That is punctuation
// stripping, not normalization: one Indian mobile written the four ordinary ways
// produced three different strings, and therefore three different hashes.
//
// Nothing would have errored. The hashes simply never collide, so a guest who
// messaged from a WhatsApp ad is never recognised as the guest who booked — for
// every booking, permanently, with no symptom beyond an attribution rate that
// looks disappointing. WhatsApp Cloud API reports "919900449954"; a hotel's own
// system commonly stores "9900449954". The two sides we most need to join were
// exactly the two guaranteed to disagree.
//
// Caught before any phone hash existed in production (3 visitor identities, all
// email-only; 0 bookings), so there was nothing to migrate. It would have become
// unfixable the day WhatsApp or the booking engine started writing them.
// ─────────────────────────────────────────────────────────────────────────────

const CANON = "919900449954";

describe("every way one Indian mobile is written converges", () => {
  test.each([
    ["+91 99004 49954", "spaced international"],
    ["+919900449954", "compact international"],
    ["919900449954", "country code, no plus — what WhatsApp sends"],
    ["09900449954", "national with trunk prefix"],
    ["9900449954", "bare subscriber number — what a hotel system stores"],
    ["0091 99004 49954", "international access prefix"],
    ["+91-99004-49954", "hyphenated"],
    ["(+91) 99004 49954", "parenthesised"],
  ])("%s (%s)", (input) => {
    expect(normalizePhone(input)).toBe(CANON);
  });
});

describe("it refuses to mint junk join keys", () => {
  test.each([["", "empty"], ["   ", "blank"], ["1234", "extension"], ["abcd", "letters"]])(
    "%s (%s) yields no key",
    (input) => {
      expect(normalizePhone(input)).toBe("");
    },
  );

  test("a short value never becomes a hash that matches other short values", () => {
    // Two different extensions must not join to each other.
    expect(normalizePhone("101")).toBe("");
    expect(normalizePhone("202")).toBe("");
  });
});

describe("numbers that already carry a country code are left alone", () => {
  test("a UK mobile keeps its own code", () => {
    expect(normalizePhone("+44 7700 900123")).toBe("447700900123");
  });

  test("the default code applies only to a bare national number", () => {
    expect(normalizePhone("9900449954", "44")).toBe("449900449954");
    // Already prefixed — the default must not be stacked on top.
    expect(normalizePhone("+91 99004 49954", "44")).toBe(CANON);
  });
});

// ── The two implementations must agree ──────────────────────────────────────

describe("the snippet's copy matches this one", () => {
  // The snippet computes the hash in the browser and the server compares it. A
  // divergence between the two is silent: no error, just nothing ever matching.
  const snippetSrc = readFileSync(
    join(__dirname, "..", "scripts", "snippet.src.js"),
    "utf8",
  );

  const fn = /function normalizePhone\(v\) \{[\s\S]*?\n    \}/.exec(snippetSrc);

  test("the snippet defines its own normalizePhone", () => {
    expect(fn).not.toBeNull();
  });

  test("it no longer strips punctuation and calls it normalized", () => {
    expect(snippetSrc).not.toMatch(/info\.phone\).replace\(\/\[\^0-9\]\/g, ""\)/);
    expect(snippetSrc).toMatch(/normalizePhone\(info\.phone\)/);
  });

  test.each([
    "+91 99004 49954",
    "09900449954",
    "9900449954",
    "0091 99004 49954",
    "+44 7700 900123",
    "1234",
    "",
  ])("produces identical output for %s", (input) => {
    // Evaluate the snippet's own source, so this compares the shipped code
    // rather than a re-implementation of it.
    const snippetImpl = new Function(`${fn![0]}; return normalizePhone;`)() as (
      v: string,
    ) => string;
    expect(snippetImpl(input)).toBe(normalizePhone(input));
  });
});
