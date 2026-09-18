import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import {
  BULK_LOAD_PER_MINUTE,
  NONE_PARAM,
  UNSORTED_PIPELINE,
  adPlacement,
  dayLabel,
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
  test("the counts read no guest number, lead id or name", () => {
    // Scoped to the counts loader: the admin-only guest list below it reads the
    // number on purpose, one opened cell at a time.
    // Ends where the counts loader ends: the guest-list helpers follow it.
    const counts = LOADER.slice(
      LOADER.indexOf("export async function loadLeadBreakdown"),
      LOADER.indexOf("export const NONE_PARAM"),
    );
    expect(counts).not.toMatch(/phoneEncrypted|phoneLast4|krayaLeadId|guestName/);
    expect(LOADER).not.toMatch(/krayaLeadId|guestName/);
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
    // Whitespace-insensitive: the formatter re-wraps JSX text freely.
    const text = VIEW.replace(/\s+/g, " ");
    expect(text).toMatch(/tracked since 11 Sep 2026/);
    expect(text).toMatch(/Google ad through the website is not counted as from ads/);
  });
});

describe("6. contacts loaded into Kraya in bulk are on their own line", () => {
  // A bulk load stamps every contact with the moment it was loaded, so their
  // "first message" is the load, not the guest. On Aster: 1,980 contacts in
  // 12:55–12:56 IST on 25 Jul and 27 at 21:54 on 3 Aug, while real enquiries
  // never exceeded 2 in a minute.

  test("the threshold sits well above any real minute", () => {
    expect(BULK_LOAD_PER_MINUTE).toBe(10);
  });

  test("a bulk load is carried separately, never added to the counts", () => {
    const [box] = shapeBreakdown(
      [row(UNSORTED_PIPELINE, "New Lead", 8, 376)],
      [{ pipeline: UNSORTED_PIPELINE, count: 1979, booked: 0, days: ["25 Jul 2026"] }],
    );
    expect(box.all).toBe(376);
    expect(box.fromAds).toBe(8);
    expect(box.bulk).toEqual({ count: 1979, booked: 0, days: ["25 Jul 2026"] });
  });

  test("a property holding only bulk-loaded contacts still gets a box", () => {
    const boxes = shapeBreakdown([], [{ pipeline: "Coffeeberry", count: 27, booked: 0, days: ["3 Aug 2026"] }]);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].all).toBe(0);
    expect(boxes[0].bulk?.count).toBe(27);
  });

  test("no box has a bulk line when nothing was bulk-loaded", () => {
    const [box] = shapeBreakdown([row("3hills", "Qualified", 1, 2)]);
    expect(box.bulk).toBeNull();
  });

  test("days are named chronologically, not alphabetically", () => {
    // "10 Aug" sorts before "3 Aug" as text; ISO dates are sorted first.
    expect(dayLabel("2026-07-25")).toBe("25 Jul 2026");
    expect(["2026-08-10", "2026-08-03"].sort().map(dayLabel)).toEqual(["3 Aug 2026", "10 Aug 2026"]);
    expect(LOADER).toMatch(/days: \[\.\.\.b\.days\]\.sort\(\)\.map\(dayLabel\)/);
  });

  test("the main counts exclude bulk minutes; the bulk line counts only them", () => {
    expect(LOADER).toMatch(/HAVING COUNT\(\*\) >= \$\{BULK_LOAD_PER_MINUTE\}/);
    expect(LOADER).toMatch(/date_trunc\('minute', c\."firstMessageAt"\) NOT IN \(SELECT m FROM bulk_minutes\)/);
    expect(LOADER).toMatch(/date_trunc\('minute', c\."firstMessageAt"\) IN \(SELECT m FROM bulk_minutes\)/);
  });

  test("bulk minutes are found in the query, not passed back in as a parameter", () => {
    // A timestamp list re-cast through the session timezone could silently
    // match nothing.
    expect(LOADER).not.toMatch(/::timestamp\[\]/);
    // Counts, the bulk line, and the guest list — each finds its own.
    expect((LOADER.match(/WITH bulk_minutes AS/g) ?? []).length).toBe(3);
  });

  test("the bulk minutes are judged across all the hotel's leads, tenant-scoped", () => {
    const cte = LOADER.slice(LOADER.indexOf("WITH bulk_minutes AS"));
    const body = cte.slice(0, cte.indexOf("HAVING"));
    expect(body).toMatch(/"agencyId" = \$\{agencyId\} AND "hotelClientId" = \$\{hotelClientId\}/);
    expect(body).not.toMatch(/since|until/);
  });

  test("the screen says what they are and that they are not counted", () => {
    const text = VIEW.replace(/\s+/g, " ");
    expect(text).toMatch(/contacts loaded into Kraya in bulk/);
    expect(text).toMatch(/not enquiries, so not counted above/);
  });
});

describe("7. opening a From-ads count to see the guests behind it", () => {
  test("each row carries Kraya's raw bucket, so a missing one can still be opened", () => {
    const [box] = shapeBreakdown([row("3hills", null, 1, 1), row("3hills", "Junk", 2, 3)]);
    const none = box.buckets.find((b) => b.bucket === "No bucket recorded")!;
    expect(none.raw).toBeNull();
    expect(box.buckets.find((b) => b.bucket === "Junk")!.raw).toBe("Junk");
  });

  test("the list uses the box's own rules, so its length equals the count clicked", () => {
    const fn = LOADER.slice(LOADER.indexOf("export async function loadBucketAdLeads"));
    expect(fn).toMatch(/c\."sourceId" IS NOT NULL/);
    expect(fn).toMatch(/c\."firstMessageAt" >= \$\{since\}/);
    expect(fn).toMatch(/c\."firstMessageAt" <= \$\{until\}/);
    expect(fn).toMatch(/NOT IN \(SELECT m FROM bulk_minutes\)/);
    // IS NOT DISTINCT FROM, so a null pipeline or bucket matches a null.
    expect(fn).toMatch(/c\."pipelineName" IS NOT DISTINCT FROM \$\{pipeline\}/);
    expect(fn).toMatch(/c\."stageName" IS NOT DISTINCT FROM \$\{bucket\}/);
  });

  test("the list query is tenant-scoped everywhere", () => {
    const fn = LOADER.slice(LOADER.indexOf("export async function loadBucketAdLeads"));
    expect(fn).toMatch(/"agencyId" = \$\{agencyId\} AND "hotelClientId" = \$\{hotelClientId\}/);
    expect(fn).toMatch(/c\."agencyId" = \$\{agencyId\}/);
    expect(fn).toMatch(/bk\."agencyId" = c\."agencyId"/);
  });

  test("numbers load only for an admin, and only for the one cell asked for", () => {
    expect(PAGE).toMatch(/const isAdmin = member\.role === "admin";/);
    const page = PAGE.replace(/\s+/g, " ");
    expect(page).toMatch(
      /isAdmin && lbpRange != null && openP != null && openB != null \? await loadBucketAdLeads\(/,
    );
    // Non-admins get no drill at all — the counts stay plain numbers.
    expect(PAGE).toMatch(/drill=\{\s*isAdmin\s*\?/);
    // The breakdown's own loader still reads no contact detail.
    const counts = LOADER.slice(
      LOADER.indexOf("export async function loadLeadBreakdown"),
      LOADER.indexOf("export const NONE_PARAM"),
    );
    expect(counts).not.toMatch(/phoneEncrypted/);
  });

  test("a count is only a link when there is someone to show and permission to show them", () => {
    const view = VIEW.replace(/\s+/g, " ");
    expect(view).toMatch(/href=\{ drill && b\.fromAds > 0 \? drill\.hrefFor\(p\.pipeline, b\.raw\) : null \}/);
  });

  test("each guest: the number with a Copy button, and the ad they came from", () => {
    expect(VIEW).toMatch(/<CopyButton\s+text=\{l\.phone\}/);
    expect(VIEW).toMatch(/text=\{numbers\.join\("\\n"\)\}/);
    expect(VIEW).toMatch(/l\.headline/);
    expect(VIEW).toMatch(/· ad \{l\.adId\}/);
    expect(VIEW).toMatch(/l\.placement/);
  });

  test("the FULL ad id is shown — every ad here ends in the same digits", () => {
    expect(LOADER).toMatch(/adId: r\.sourceId,/);
    expect(LOADER).not.toMatch(/sourceId\.slice\(-4\)/);
  });

  test("where an ad ran is read from its link", () => {
    expect(adPlacement("https://www.instagram.com/p/abc/")).toBe("Instagram");
    expect(adPlacement("https://fb.me/xyz")).toBe("Facebook");
    expect(adPlacement("https://www.facebook.com/ads/1")).toBe("Facebook");
    expect(adPlacement("https://wa.me/919000000000")).toBe("WhatsApp link");
    expect(adPlacement("https://example.org/x")).toBe("example.org");
    expect(adPlacement(null)).toBeNull();
    expect(adPlacement("not a url")).toBeNull();
  });

  test("only http(s) ad links are ever rendered as links", () => {
    const fn = LOADER.slice(LOADER.indexOf("function safeUrl"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toMatch(/u\.protocol === "https:" \|\| u\.protocol === "http:"/);
    expect(VIEW).toMatch(/rel="noopener noreferrer"/);
  });

  test("a null pipeline or bucket survives the URL", () => {
    expect(NONE_PARAM).toBe("__none__");
    expect(PAGE).toMatch(/const fromParam = \(v: string\) => \(v === NONE_PARAM \? null : v\);/);
  });
});
