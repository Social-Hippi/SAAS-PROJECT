import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1A — marketing click identity. PURE tests (no DB, no session).
//
// The defect this closes: Google Ads AUTO-TAGGING is the default, and it sends
// traffic with a `gclid` and NO utm parameters. classifySourceType only looked at
// UTMs, so every auto-tagged Google click was classified `direct` — Google-driven
// revenue credited to Direct, and the paid ROAS corrected in Phase 0 understating
// Google by exactly that amount.
//
// The asymmetry these tests pin down: gclid/gbraid/wbraid are minted ONLY by
// Google Ads, so they prove a paid click. `fbclid` is appended by Meta to organic
// post links too, so it proves "came from Meta" and NOT "came from a Meta ad" —
// treating it as paid would re-inflate the number Phase 0 just fixed.
// ─────────────────────────────────────────────────────────────────────────────

import {
  CLICK_ID_KEYS,
  EVIDENCE_RANK,
  GOOGLE_CLICK_ID_KEYS,
  MAX_CLICK_ID_LENGTH,
  describeClickIds,
  evidenceStrength,
  hasAnyClickId,
  isAtLeastAsStrong,
  isGoogleAdsClick,
  isMetaClick,
  mergeClickIds,
  normalizeClickId,
  parseClickIds,
  redactClickId,
} from "@/lib/click-ids";
import { classifySourceType, NO_CLICK_IDS } from "@/lib/source-classifier";

const GCLID = "TEST_GCLID_123";
const GBRAID = "TEST_GBRAID_123";
const WBRAID = "TEST_WBRAID_123";
const FBCLID = "TEST_FBCLID_123";

const qs = (search: string) => new URLSearchParams(search);

// ── 1–4. Capture ───────────────────────────────────────────────────────────

describe("capture", () => {
  test("1. gclid is captured from the landing query string", () => {
    expect(parseClickIds(qs(`?gclid=${GCLID}`)).gclid).toBe(GCLID);
  });

  test("2. gbraid is captured (iOS app→web)", () => {
    expect(parseClickIds(qs(`?gbraid=${GBRAID}`)).gbraid).toBe(GBRAID);
  });

  test("3. wbraid is captured (iOS web→app)", () => {
    expect(parseClickIds(qs(`?wbraid=${WBRAID}`)).wbraid).toBe(WBRAID);
  });

  test("4. fbclid is captured", () => {
    expect(parseClickIds(qs(`?fbclid=${FBCLID}`)).fbclid).toBe(FBCLID);
  });

  test("all four can be present at once, and absent ones are null (not '')", () => {
    const ids = parseClickIds(qs(`?gclid=${GCLID}&fbclid=${FBCLID}`));
    expect(ids.gclid).toBe(GCLID);
    expect(ids.fbclid).toBe(FBCLID);
    expect(ids.gbraid).toBeNull();
    expect(ids.wbraid).toBeNull();
  });

  test("reads from a payload object as well as a query string", () => {
    expect(parseClickIds({ gclid: GCLID, unrelated: "x" }).gclid).toBe(GCLID);
  });

  test("the key list and the Google subset are what downstream code assumes", () => {
    expect([...CLICK_ID_KEYS]).toEqual(["gclid", "gbraid", "wbraid", "fbclid"]);
    expect([...GOOGLE_CLICK_ID_KEYS]).toEqual(["gclid", "gbraid", "wbraid"]);
  });
});

// ── 5. UTMs still work, untouched ──────────────────────────────────────────

describe("5. existing UTM capture is preserved", () => {
  test("a plain UTM visit still classifies from the UTMs alone", () => {
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: "facebook", utmMedium: "cpc" })).toBe("meta_ads");
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: "google", utmMedium: "cpc" })).toBe("google_ads");
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: "instagram", utmMedium: "social" })).toBe("instagram_organic");
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: "email", utmMedium: "newsletter" })).toBe("email");
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: null, utmMedium: null })).toBe("direct");
  });

  test("UTM classification is unchanged when no click id is present", () => {
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: "whatsapp", utmMedium: "referral", gclid: null })).toBe("whatsapp");
  });
});

// ── 6. Google auto-tagging is not "direct" ────────────────────────────────

describe("6. Google click id is never classified direct", () => {
  test("gclid with NO utm parameters classifies as google_ads", () => {
    // This is the exact auto-tagging journey: https://hotel.com/?gclid=…
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: null, utmMedium: null, gclid: GCLID })).toBe("google_ads");
  });

  test("gbraid alone classifies as google_ads", () => {
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: null, utmMedium: null, gbraid: GBRAID })).toBe("google_ads");
  });

  test("wbraid alone classifies as google_ads", () => {
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: null, utmMedium: null, wbraid: WBRAID })).toBe("google_ads");
  });

  test("a Google click id outranks a contradicting UTM", () => {
    // Manual tagging + auto-tagging can coexist; the platform-minted id wins.
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: "email", utmMedium: "newsletter", gclid: GCLID })).toBe("google_ads");
  });

  test("an EMPTY/invalid gclid does not fabricate google_ads", () => {
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: null, utmMedium: null, gclid: "" })).toBe("direct");
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: null, utmMedium: null, gclid: "   " })).toBe("direct");
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: null, utmMedium: null, gclid: null })).toBe("direct");
  });
});

// ── 7. Meta: captured, but NOT promoted to paid ───────────────────────────

describe("7. Meta click id", () => {
  test("fbclid is recognised as a Meta click", () => {
    expect(isMetaClick({ fbclid: FBCLID })).toBe(true);
    expect(isMetaClick({ gclid: GCLID })).toBe(false);
  });

  test("fbclid does NOT by itself make a visit paid meta_ads", () => {
    // Meta appends fbclid to organic post links too. Claiming `meta_ads` here
    // would put organic revenue into the paid ROAS numerator.
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: null, utmMedium: null, fbclid: FBCLID })).not.toBe("meta_ads");
  });

  test("the documented Meta journey still classifies as meta_ads via its UTMs", () => {
    // ?fbclid=…&utm_source=facebook&utm_medium=paid_social
    expect(
      classifySourceType({ ...NO_CLICK_IDS, utmSource: "facebook", utmMedium: "paid_social", fbclid: FBCLID }),
    ).toBe("meta_ads");
  });

  test("fbclid never downgrades an existing organic Meta classification", () => {
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: "instagram", utmMedium: "social", fbclid: FBCLID })).toBe(
      "instagram_organic",
    );
  });

  test("fbclid alongside a Google click id does not override Google", () => {
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: null, utmMedium: null, gclid: GCLID, fbclid: FBCLID })).toBe(
      "google_ads",
    );
  });
});

// ── 11. A missing id never erases a stored one ────────────────────────────

describe("11. merge never loses an identifier", () => {
  test("an internal navigation (no click ids) preserves the landing identifier", () => {
    const merged = mergeClickIds({ gclid: GCLID }, {});
    expect(merged.gclid).toBe(GCLID);
  });

  test("explicit nulls do not erase", () => {
    const merged = mergeClickIds({ gclid: GCLID }, { gclid: null, fbclid: null });
    expect(merged.gclid).toBe(GCLID);
  });

  test("an invalid incoming value does not erase a valid stored one", () => {
    const merged = mergeClickIds({ gclid: GCLID }, { gclid: "has spaces" });
    expect(merged.gclid).toBe(GCLID);
  });

  test("a genuinely NEW ad click replaces that platform's id", () => {
    const merged = mergeClickIds({ gclid: GCLID }, { gclid: "TEST_GCLID_456" });
    expect(merged.gclid).toBe("TEST_GCLID_456");
  });

  test("merging is per-platform: a Meta click after a Google click keeps both", () => {
    const merged = mergeClickIds({ gclid: GCLID }, { fbclid: FBCLID });
    expect(merged.gclid).toBe(GCLID);
    expect(merged.fbclid).toBe(FBCLID);
  });

  test("merging nothing into nothing is all-null, never undefined", () => {
    const merged = mergeClickIds(null, null);
    for (const k of CLICK_ID_KEYS) expect(merged[k]).toBeNull();
    expect(hasAnyClickId(merged)).toBe(false);
  });
});

// ── 12. Malformed / oversized input ───────────────────────────────────────

describe("12. malformed and oversized identifiers are handled safely", () => {
  test("over-length values are DROPPED, not truncated", () => {
    // A truncated click id is worse than none — it would never match the ad
    // platform's records while looking like valid evidence.
    const tooLong = "a".repeat(MAX_CLICK_ID_LENGTH + 1);
    expect(normalizeClickId(tooLong)).toBeNull();
    expect(normalizeClickId("a".repeat(MAX_CLICK_ID_LENGTH))).toHaveLength(MAX_CLICK_ID_LENGTH);
  });

  test.each([
    ["whitespace only", "   "],
    ["empty", ""],
    ["a space inside", "abc def"],
    ["angle brackets", "<script>"],
    ["a quote", 'abc"def'],
    ["a semicolon (cookie delimiter)", "abc;def"],
    ["a newline", "abc\ndef"],
    ["a null byte", "abc def"],
    ["a slash", "abc/def"],
  ])("rejects %s", (_label, value) => {
    expect(normalizeClickId(value)).toBeNull();
  });

  test.each([
    ["a number", 12345],
    ["null", null],
    ["undefined", undefined],
    ["an object", { gclid: "x" }],
    ["an array", ["x"]],
    ["a boolean", true],
  ])("rejects a non-string: %s", (_label, value) => {
    expect(normalizeClickId(value)).toBeNull();
  });

  test("surrounding whitespace is trimmed, not rejected", () => {
    expect(normalizeClickId(`  ${GCLID}  `)).toBe(GCLID);
  });

  test("the real-world charset is accepted (dots, dashes, underscores)", () => {
    expect(normalizeClickId("Cj0KCQjw-abc_DEF.123-xyz")).toBe("Cj0KCQjw-abc_DEF.123-xyz");
  });

  test("a malformed id cannot smuggle a classification", () => {
    expect(classifySourceType({ ...NO_CLICK_IDS, utmSource: null, utmMedium: null, gclid: "<img src=x>" })).toBe("direct");
  });
});

// ── Evidence hierarchy (recorded now; nothing re-weights attribution yet) ──

describe("evidence hierarchy", () => {
  test("click id > utm > referrer > none", () => {
    expect(EVIDENCE_RANK.click_id).toBeGreaterThan(EVIDENCE_RANK.utm);
    expect(EVIDENCE_RANK.utm).toBeGreaterThan(EVIDENCE_RANK.session);
    expect(EVIDENCE_RANK.session).toBeGreaterThan(EVIDENCE_RANK.referrer);
    expect(EVIDENCE_RANK.referrer).toBeGreaterThan(EVIDENCE_RANK.none);
  });

  test("a click-id touch is stronger evidence than a bare-UTM touch", () => {
    const withClick = evidenceStrength({ gclid: GCLID });
    const withUtm = evidenceStrength({ utmSource: "google", utmMedium: "cpc" });
    expect(withClick).toBe("click_id");
    expect(withUtm).toBe("utm");
    expect(isAtLeastAsStrong(withClick, withUtm)).toBe(true);
    expect(isAtLeastAsStrong(withUtm, withClick)).toBe(false);
  });

  test("a referrer-only touch outranks nothing at all", () => {
    expect(evidenceStrength({ referrer: "https://google.com/" })).toBe("referrer");
    expect(evidenceStrength({})).toBe("none");
    expect(evidenceStrength(null)).toBe("none");
  });
});

// ── Logging safety ────────────────────────────────────────────────────────

describe("log safety", () => {
  test("redactClickId never emits the full identifier", () => {
    const out = redactClickId(GCLID);
    expect(out).not.toContain(GCLID);
    expect(out).toContain("TEST");
    expect(out).toContain(String(GCLID.length));
  });

  test("describeClickIds names the keys present but never a value", () => {
    const out = describeClickIds({ gclid: GCLID, fbclid: FBCLID });
    expect(out).toBe("gclid,fbclid");
    expect(out).not.toContain(GCLID);
    expect(describeClickIds({})).toBe("(none)");
  });
});

// ── Helper predicates ─────────────────────────────────────────────────────

describe("predicates", () => {
  test("isGoogleAdsClick is true for each Google id and false for fbclid", () => {
    expect(isGoogleAdsClick({ gclid: GCLID })).toBe(true);
    expect(isGoogleAdsClick({ gbraid: GBRAID })).toBe(true);
    expect(isGoogleAdsClick({ wbraid: WBRAID })).toBe(true);
    expect(isGoogleAdsClick({ fbclid: FBCLID })).toBe(false);
    expect(isGoogleAdsClick({})).toBe(false);
    expect(isGoogleAdsClick(null)).toBe(false);
  });

  test("hasAnyClickId ignores invalid values", () => {
    expect(hasAnyClickId({ gclid: "bad value" })).toBe(false);
    expect(hasAnyClickId({ gclid: GCLID })).toBe(true);
  });
});

// ── Schema + wiring (Phase 1A persistence) ────────────────────────────────
//
// Source-level assertions: the persistence path is server + database code that
// needs a live Postgres to exercise (see tests/click-id-persistence.test.ts).
// These pin the SHAPE — that the columns exist, that every classification read
// selects them, and that no code violates the security rules — so a regression
// is caught even where a database is unavailable.

describe("schema and wiring", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  const SCHEMA = read("prisma/schema.prisma");
  const MIGRATION = read("prisma/migrations/20260821000000_add_click_identifiers/migration.sql");
  const ROUTE = read("app/api/track/event/route.ts");

  const modelBlock = (name: string) =>
    SCHEMA.slice(SCHEMA.indexOf(`model ${name} {`), SCHEMA.indexOf("}", SCHEMA.indexOf(`model ${name} {`)));

  test("1. all four columns exist on Session, Touchpoint and TrackingEvent", () => {
    for (const model of ["Session", "Touchpoint", "TrackingEvent"]) {
      const block = modelBlock(model);
      for (const key of CLICK_ID_KEYS) {
        expect(block).toMatch(new RegExp(`\\b${key}\\s+String\\?`));
      }
    }
  });

  test("Touchpoint's missing utmTerm was closed alongside", () => {
    expect(modelBlock("Touchpoint")).toMatch(/\butmTerm\s+String\?/);
  });

  test("the lookup index for offline-conversion joins exists", () => {
    expect(modelBlock("TrackingEvent")).toContain("@@index([hotelClientId, gclid])");
  });

  test("every column is NULLABLE with no default and no backfill", () => {
    // A non-null default or an UPDATE would rewrite the table and manufacture
    // attribution for rows captured under the old rules.
    expect(MIGRATION).not.toMatch(/NOT NULL/);
    expect(MIGRATION).not.toMatch(/DEFAULT/);
    expect(MIGRATION).not.toMatch(/\bUPDATE\b/i);
    for (const t of ["Session", "Touchpoint", "TrackingEvent"]) {
      expect(MIGRATION).toContain(`ALTER TABLE "${t}"`);
    }
  });

  test("15/16. ingest re-validates click ids server-side (never trusts the browser)", () => {
    expect(ROUTE).toContain('from "@/lib/click-ids"');
    expect(ROUTE).toContain("parseClickIds(body)");
    expect(ROUTE).toContain("parseClickIds(tp)"); // per-touch, not the remembered value
  });

  test("9. the session UPDATE is add-only, so a null can never erase", () => {
    // Prisma treats an explicit null as "SET NULL"; presentClickIds drops them.
    expect(ROUTE).toContain("presentClickIds(eventClickIds)");
    expect(ROUTE).toMatch(/function presentClickIds/);
  });

  test("no code logs a raw click id", () => {
    for (const f of [
      "app/api/track/event/route.ts",
      "lib/click-ids.ts",
      "lib/source-classifier.ts",
    ]) {
      const src = read(f);
      expect(src).not.toMatch(/console\.[a-z]+\([^)]*\b(gclid|gbraid|wbraid|fbclid)\b/);
    }
  });
});
