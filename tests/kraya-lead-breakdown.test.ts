import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import {
  UNSORTED_PIPELINE,
  propertyLabel,
  shapeBreakdown,
} from "@/lib/kraya-lead-breakdown";

// ─────────────────────────────────────────────────────────────────────────────
// Kraya leads by property and bucket, on the Integrations page.
//
// Agreed with the agency: "Leads" is its own box; the current bucket AND
// whether the lead ever booked; Kraya's bucket names verbatim; ad leads beside
// all leads. The window is the day the lead first messaged.
// ─────────────────────────────────────────────────────────────────────────────

const LOADER = readCode("lib/kraya-lead-breakdown.ts");
const PAGE = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/page.tsx");
const VIEW = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/LeadBreakdown.tsx");

const row = (
  pipeline: string | null,
  bucket: string | null,
  fromAds: number,
  all: number,
  bookedFromAds = 0,
  bookedAll = 0,
) => ({ pipeline, bucket, fromAds, all, bookedFromAds, bookedAll });

describe("1. one box per property, totals that add up", () => {
  const boxes = shapeBreakdown([
    row("3hills", "Qualified", 22, 80),
    row("3hills", "Interested - Follow-Up", 26, 90),
    row("3hills", "Booking Confirmed", 1, 40, 1, 40),
    row("Coffeeberry", "Junk", 4, 50),
    row(UNSORTED_PIPELINE, "New Lead", 8, 600),
    row(null, "Qualified", 0, 3),
  ]);

  test("each pipeline becomes exactly one box", () => {
    expect(boxes.map((b) => b.pipeline)).toEqual(["3hills", "Coffeeberry", UNSORTED_PIPELINE, null]);
  });

  test("a box's totals are the sum of its buckets", () => {
    const hills = boxes.find((b) => b.pipeline === "3hills")!;
    expect(hills.fromAds).toBe(49);
    expect(hills.all).toBe(210);
    expect(hills.buckets.reduce((n, b) => n + b.fromAds, 0)).toBe(hills.fromAds);
    expect(hills.buckets.reduce((n, b) => n + b.all, 0)).toBe(hills.all);
  });

  test("buckets are ordered by ad leads first", () => {
    const hills = boxes.find((b) => b.pipeline === "3hills")!;
    expect(hills.buckets.map((b) => b.bucket)).toEqual([
      "Interested - Follow-Up",
      "Qualified",
      "Booking Confirmed",
    ]);
  });

  test("the unsorted inbox is its own box, after the real properties", () => {
    expect(propertyLabel(UNSORTED_PIPELINE)).toBe("Leads — not yet sorted into a property");
    expect(propertyLabel(null)).toBe("No property recorded");
    expect(propertyLabel("3hills")).toBe("3hills");
  });
});

describe("2. Kraya's own bucket names are never merged", () => {
  test("differently named buckets stay separate", () => {
    const boxes = shapeBreakdown([
      row("Coffeeberry", "Sold out for CBH", 2, 9),
      row("Coffeeberry", "Sold out", 1, 3),
      row("Coffeeberry", "Junk / Marketing", 1, 4),
      row("Coffeeberry", "Junk", 1, 5),
    ]);
    const names = boxes[0].buckets.map((b) => b.bucket);
    expect(names).toContain("Sold out for CBH");
    expect(names).toContain("Sold out");
    expect(names).toContain("Junk / Marketing");
    expect(names).toContain("Junk");
    expect(names).toHaveLength(4);
  });

  test("a lead with no bucket is shown as such, not dropped", () => {
    const boxes = shapeBreakdown([row("3hills", null, 1, 2)]);
    expect(boxes[0].buckets[0].bucket).toBe("No bucket recorded");
    expect(boxes[0].all).toBe(2);
  });
});

describe("3. booked is counted from bookings, not from the bucket", () => {
  test("a guest who booked and moved on still counts as booked", () => {
    // Booked, then checked in: the bucket is "Inhouse", not "Booking Confirmed".
    const boxes = shapeBreakdown([
      row("3hills", "Booking Confirmed", 1, 1, 1, 1),
      row("3hills", "Inhouse", 1, 1, 1, 1),
    ]);
    expect(boxes[0].bookedFromAds).toBe(2);
    const confirmedBucket = boxes[0].buckets.find((b) => b.bucket === "Booking Confirmed")!;
    expect(confirmedBucket.fromAds).toBe(1);
  });

  test("the query decides 'booked' by an existing, uncancelled Kraya booking", () => {
    expect(LOADER).toMatch(/SELECT EXISTS \(/);
    expect(LOADER).toMatch(/bk\.provider = 'kraya'/);
    expect(LOADER).toMatch(/bk\."guestPhoneHash" = c\."phoneHash"/);
    expect(LOADER).toMatch(/bk\.status NOT IN \('CANCELLED', 'REFUNDED'\)/);
  });
});

describe("4. what the query counts", () => {
  test("'from ads' is the Meta click-to-WhatsApp sticker", () => {
    expect(LOADER).toMatch(/COUNT\(\*\) FILTER \(WHERE c\."sourceId" IS NOT NULL\)\s+AS from_ads/);
  });

  test("the window is the day the lead first messaged", () => {
    expect(LOADER).toMatch(/c\."firstMessageAt" >= \$\{since\}/);
    expect(LOADER).toMatch(/c\."firstMessageAt" <= \$\{until\}/);
  });

  test("grouped by Kraya's pipeline and stage, verbatim", () => {
    expect(LOADER).toMatch(/GROUP BY c\."pipelineName", c\."stageName"/);
  });

  test("the raw query is tenant-scoped, including the booking join", () => {
    expect(LOADER).toMatch(/c\."agencyId" = \$\{agencyId\}/);
    expect(LOADER).toMatch(/c\."hotelClientId" = \$\{hotelClientId\}/);
    expect(LOADER).toMatch(/bk\."agencyId" = c\."agencyId"/);
  });
});

describe("5. counts only — safe for every agency member", () => {
  test("no guest number, lead id or name is read", () => {
    expect(LOADER).not.toMatch(/phoneEncrypted|phoneLast4|krayaLeadId|guestName/);
  });

  test("shown whenever Kraya is connected, not gated on admin", () => {
    expect(PAGE).toMatch(/const lbpRange = krayaView != null \? resolveSectionRange\(lbpState/);
    expect(PAGE).toMatch(/const leadBreakdown =\s*lbpRange != null/);
    expect(PAGE).not.toMatch(/const lbpRange = canValueBookings/);
  });

  test("its range lives under its own prefix and carries the other section's", () => {
    // Detailed coverage — presets, custom, round-tripping — is in
    // tests/section-range.test.ts.
    expect(PAGE).toMatch(/prefix="lbp"/);
    expect(PAGE).toMatch(/preserve=\{sectionRangeParams\("wab", wabState\)\}/);
    expect(VIEW).toMatch(/\{picker\}/);
  });

  test("the screen states both limits of 'from ads'", () => {
    expect(VIEW).toMatch(/tracked since 11 Sep 2026/);
    expect(VIEW).toMatch(/Google ad through the website is not counted as from ads/);
  });
});
