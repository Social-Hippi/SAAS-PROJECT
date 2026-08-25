import { describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Track A — influencer identity, DB-free.
//
// The defect this closes: an influencer's tracking URL resolved to a
// ContentPiece, whose influencer was named in a FREE-TEXT column. Two
// influencers sharing a display name were indistinguishable, a rename orphaned
// history, and the URL path and the coupon path could not be proven to be the
// same person.
//
// These tests pin the URL contract and the resolution rules. The database half
// (ContentPiece.influencerId → Influencer, CouponCode → Influencer) lives in
// tests/influencer-attribution-persistence.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { buildUtmLink, slugify, UTM_CONTENT_PREFIX } from "@/lib/utm";
import { classifySourceType } from "@/lib/source-classifier";
import {
  contentPieceIdFromUtmContent,
  isInfluencerUtm,
} from "@/lib/influencer-attribution";

const INFLUENCER = "TEST_INFLUENCER";
const CONTENT = "TEST_INFLUENCER_CONTENT";
const CAMPAIGN = "TEST_INFLUENCER_CAMPAIGN";
const CONTENT_PIECE_ID = "ck9testinfluencercontent01";
const AGENCY_ID = "TEST_AGENCY_ID";

/** The URL HotelTrack generates for influencer content — the real builder. */
const url = buildUtmLink({
  destinationUrl: "https://hotel.example/rooms",
  source: "instagram", // ContentPiece.platform
  medium: "influencer", // ContentPiece.contentType
  title: CAMPAIGN,
  contentPieceId: CONTENT_PIECE_ID,
  agencyId: AGENCY_ID,
});
const params = new URL(url).searchParams;

// ── A3 — the generated tracking URL ──────────────────────────────────────

describe("A3 — HotelTrack-generated influencer URL", () => {
  test("carries all four required parameters", () => {
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content"]) {
      expect(params.get(k)).toBeTruthy();
    }
  });

  test("uses the repository's influencer convention", () => {
    expect(params.get("utm_source")).toBe("instagram");
    expect(params.get("utm_medium")).toBe("influencer");
  });

  test("utm_content uniquely identifies the ContentPiece", () => {
    expect(params.get("utm_content")).toBe(`${UTM_CONTENT_PREFIX}${CONTENT_PIECE_ID}`);
  });

  test("utm_campaign is derived from the content title — no manual tagging", () => {
    expect(params.get("utm_campaign")).toBe(slugify(CAMPAIGN));
  });

  test("the destination path and any pre-existing query are preserved", () => {
    const withQuery = buildUtmLink({
      destinationUrl: "https://hotel.example/rooms?promo=summer",
      source: "instagram", medium: "influencer", title: CAMPAIGN,
      contentPieceId: CONTENT_PIECE_ID, agencyId: AGENCY_ID,
    });
    const u = new URL(withQuery);
    expect(u.pathname).toBe("/rooms");
    expect(u.searchParams.get("promo")).toBe("summer");
  });

  test("the URL classifies as `influencer`, not paid or organic social", () => {
    expect(
      classifySourceType({
        utmSource: params.get("utm_source"),
        utmMedium: params.get("utm_medium"),
        utmContent: params.get("utm_content"),
      }),
    ).toBe("influencer");
  });

  test("an influencer link is never mistaken for a Meta ad", () => {
    // instagram + a NON-paid medium must not reach the meta_ads branch.
    expect(
      classifySourceType({ utmSource: "instagram", utmMedium: "influencer" }),
    ).not.toBe("meta_ads");
  });
});

// ── A2 — deterministic resolution, never by name ─────────────────────────

describe("A2 — utm_content → ContentPiece resolution", () => {
  test("extracts the ContentPiece id from our tag", () => {
    expect(contentPieceIdFromUtmContent(`ht-${CONTENT_PIECE_ID}`)).toBe(CONTENT_PIECE_ID);
  });

  test("round-trips the generated URL back to the ContentPiece id", () => {
    expect(contentPieceIdFromUtmContent(params.get("utm_content"))).toBe(CONTENT_PIECE_ID);
  });

  test.each([
    ["a hand-written tag", "summer-reel"],
    ["an empty value", ""],
    ["null", null],
    ["undefined", undefined],
    ["the prefix alone", "ht-"],
    ["a tag with punctuation", "ht-abc/def"],
    ["a too-short id", "ht-abc"],
  ])("returns null for %s", (_label, value) => {
    expect(contentPieceIdFromUtmContent(value as string | null)).toBeNull();
  });

  test("an influencer's NAME is never a resolution key", () => {
    // The old failure mode: matching ContentPiece.influencerName as a string.
    expect(contentPieceIdFromUtmContent(INFLUENCER)).toBeNull();
    expect(contentPieceIdFromUtmContent(CONTENT)).toBeNull();
  });

  test("isInfluencerUtm recognises the medium, case/space-insensitively", () => {
    expect(isInfluencerUtm("influencer")).toBe(true);
    expect(isInfluencerUtm("  Influencer ")).toBe(true);
    expect(isInfluencerUtm("cpc")).toBe(false);
    expect(isInfluencerUtm(null)).toBe(false);
  });
});

// ── Schema: the FK exists and the free-text column is preserved ──────────

describe("A2 — schema", () => {
  test("ContentPiece has a deterministic influencerId FK and keeps influencerName", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const schema = readFileSync(join(__dirname, "..", "prisma/schema.prisma"), "utf8");
    const block = schema.slice(schema.indexOf("model ContentPiece {"), schema.indexOf("\n}", schema.indexOf("model ContentPiece {")));

    expect(block).toMatch(/influencerId\s+String\?/);
    expect(block).toContain("influencer        Influencer?");
    expect(block).toContain("@@index([influencerId])");
    // Existing records must not be destroyed — the old column stays.
    expect(block).toMatch(/influencerName String\?/);
  });

  test("the migration is additive and does not backfill from the name column", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(
      join(__dirname, "..", "prisma/migrations/20260825000000_content_piece_influencer_fk/migration.sql"),
      "utf8",
    );
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(statements).toContain('ADD COLUMN     "influencerId" TEXT');
    expect(statements).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
    expect(statements).not.toMatch(/^\s*UPDATE /im); // no name-based backfill
  });
});

// ── A1 — the creation path actually WRITES the deterministic link ─────────
//
// The FK is worthless if no UI can set it. These assert the wiring end of the
// contract at source level (rendering the form needs Clerk + a database, which
// tests/influencer-attribution-persistence.test.ts covers instead).

describe("A1 — creating influencer content links a real Influencer", () => {
  const read = async (rel: string) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    return readFileSync(join(__dirname, "..", rel), "utf8");
  };
  const BASE = "app/(agency)/agency/(app)/content";

  test("the form submits an influencerId, not just a typed name", async () => {
    const form = await read(`${BASE}/new/ContentForm.tsx`);
    expect(form).toContain('name="influencerId"');
    expect(form).toContain('name="influencerName"'); // kept for display/history
  });

  test("the picker is fed real Influencer rows, agency-scoped and unarchived", async () => {
    const page = await read(`${BASE}/new/page.tsx`);
    expect(page).toContain("agencyScoped(prisma.influencer)");
    expect(page).toContain("archivedAt: null");
    expect(page).toContain("influencers={influencers}");
  });

  test("the server verifies the influencer belongs to the agency before storing it", async () => {
    const actions = await read(`${BASE}/actions.ts`);
    expect(actions).toContain("agencyScoped(prisma.influencer)");
    expect(actions).toContain("influencerId: linkedInfluencerId");
    // A hotel-scoped influencer must not be attached to another hotel.
    expect(actions).toMatch(/influencer\.hotelClientId\s*&&\s*influencer\.hotelClientId\s*!==\s*hotel\.id/);
  });

  test("the stored label comes from the Influencer row, not the submitted string", async () => {
    const actions = await read(`${BASE}/actions.ts`);
    expect(actions).toContain("linkedInfluencerName ?? influencerName");
  });

  test("the influencer is never resolved by matching the typed name", async () => {
    const actions = await read(`${BASE}/actions.ts`);
    const resolve = await read("lib/influencer-resolve.ts");
    const code = [actions, resolve]
      .map((f) => f.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n"))
      .join("\n");
    expect(code).not.toMatch(/where:\s*\{[^}]*\bname:\s*influencerName/);
    expect(code).not.toMatch(/influencerName:\s*\{\s*(equals|contains)/);
  });

  test("coupon suggestions are scoped to the influencer AND the hotel", async () => {
    const form = await read(`${BASE}/new/ContentForm.tsx`);
    expect(form).toMatch(/couponCodes\.filter\(\(c\) =>[^)]*c\.hotelClientId === hotelClientId/);
  });
});

// ── A4 — the tracked-link route reaches the influencer REPORT ────────────
//
// Resolving the influencer is only half the loop; before this, an influencer's
// revenue was visible ONLY when a coupon was redeemed, so a booking driven by
// their link with no code used counted for nobody. These pin the reporting
// contract at source level; the numbers themselves are exercised DB-backed in
// tests/influencer-attribution-persistence.test.ts.

describe("A4 — influencer channel reports both routes without double-counting", () => {
  const readSrc = async (rel: string) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    return readFileSync(join(__dirname, "..", rel), "utf8");
  };

  test("the loader resolves link conversions through the ContentPiece FK", async () => {
    const src = await readSrc("lib/channel-view.ts");
    expect(src).toContain("contentPieceIdFromUtmContent");
    expect(src).toMatch(/influencerId:\s*\{\s*not:\s*null\s*\}/);
  });

  test("a conversion already counted as a redemption is excluded from link revenue", async () => {
    const src = await readSrc("lib/channel-view.ts");
    expect(src).toContain("redeemedEventIds");
    expect(src).toMatch(/if \(redeemedEventIds\.has\(c\.id\)\) continue/);
  });

  test("the view exposes the two routes separately AND a combined total", async () => {
    const types = await readSrc("lib/channel-view-types.ts");
    for (const field of ["linkAttributedBookings", "linkAttributedRevenue", "linkBookings", "linkRevenue", "attributedRevenue"]) {
      expect(types).toContain(field);
    }
  });

  test("an influencer with link bookings but no redemptions still appears", async () => {
    const src = await readSrc("lib/channel-view.ts");
    // The row set is the UNION of both routes, not just the redemption keys.
    expect(src).toMatch(/allInfluencerIds\s*=\s*new Set\(\[\.\.\.byInfluencer\.keys\(\), \.\.\.byInfluencerLink\.keys\(\)\]\)/);
    expect(src).toContain("activeInfluencers = allInfluencerIds.size");
  });

  test("the dashboard labels coupon revenue and link revenue distinctly", async () => {
    const ui = await readSrc("components/dashboard/ChannelView.tsx");
    expect(ui).toContain("Coupon revenue");
    expect(ui).toContain("Tracked-link revenue");
  });
});
