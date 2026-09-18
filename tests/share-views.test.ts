import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import { ADS_CAPTION, CLIENT_CAPTION } from "@/lib/metrics/share-views";

// ─────────────────────────────────────────────────────────────────────────────
// TWO VIEWS THAT ARE NEVER MIXED.
//
// One report used to show platform figures beside the property's own record, and
// the two invite an arithmetic nobody can defend: ₹1,13,597 of ad spend next to
// 519 calls reads as ₹219 a call, and it is not one — nothing anywhere records
// which channel produced those calls.
//
// So the split is not presentation. On the ads view every figure is "what
// advertising produced" and never a total — WhatsApp bookings is bookings traced
// to an ad, not the 200 the property confirmed. On the client view nothing
// carries attribution language and no ratio appears at all.
//
// It is also what finally makes return on ad spend honest: dividing ALL revenue
// by ad spend produced 0.07x on a hotel whose business runs on WhatsApp.
// ─────────────────────────────────────────────────────────────────────────────

const LOADER = readCode("lib/metrics/share-views.ts");
const REPORT = readCode("components/dashboard/ShareReport.tsx");
const PAGE = readCode("app/share/[uuid]/page.tsx");
const SYNC = readCode("lib/google-ads-sync.ts");
const SCHEMA = readCode("prisma/schema.prisma");

describe("1. the ads view counts only what advertising produced", () => {
  test("revenue is classified per conversion, not taken as a total", () => {
    // A Google Hotel Ads free booking link is organic revenue that happens to
    // come from Google. Counting it as paid is the error the split removes.
    expect(LOADER).toMatch(/canonicalSourceType\(\{ \.\.\.c, value \}\)/);
    expect(LOADER).toMatch(/type === "meta_ads" \|\| type === "google_ads"/);
  });

  test("ROAS divides ad revenue by ad spend — both sides ads", () => {
    // Ad revenue is now BOTH channels: website bookings traced to an ad, plus
    // the WhatsApp ad bookings the agency valued. Website-only understated it
    // badly on a property whose business runs on WhatsApp.
    expect(LOADER).toMatch(/const adRevenueAllChannels = sum\(\[totalRevenue, whatsappAdRevenue\]\)/);
    expect(LOADER).toMatch(/ratio\(adRevenueAllChannels, totalSpend/);
    // Still only advertising on both sides — the client view's own revenue must
    // never reach this ratio.
    expect(LOADER).not.toMatch(/ratio\([^,]*client[^,]*, totalSpend/i);
  });

  test("WhatsApp bookings counts only those traced to an ad", () => {
    expect(LOADER).toMatch(/c\."sourceId" IS NOT NULL/);
    expect(LOADER).toMatch(/COUNT\(DISTINCT b\.id\)/);
    // An enquiry that starts AFTER the booking cannot have caused it.
    expect(LOADER).toMatch(/c\."firstMessageAt" <= b\."bookedAt"/);
  });

  test("enquiries counts only ad-sourced leads", () => {
    expect(LOADER).toMatch(/sourceId: \{ not: null \}, firstMessageAt: eventFilter/);
  });
});

describe("2. a zero that could not have been non-zero is explained", () => {
  test("no ad-traced booking carries a note rather than a bare 0", () => {
    // ok(0) is a finding only if the measurement could have produced something
    // else. Tracing needs the click id to reach the booking engine, which only
    // began working once booking domains were configured — before that, 4,057 ad
    // clicks reached the site and none reached the booking engine.
    expect(LOADER).toMatch(/const noAdBookingsYet = adBookings === 0;/);
    expect(LOADER).toMatch(/NO_AD_BOOKING_YET/);
    expect(LOADER).toMatch(/cannot be read as the ads\s*"?\s*\+?\s*"?producing nothing/);
  });

  test("the note lands on both revenue and ROAS", () => {
    expect(LOADER).toMatch(/totalRevenue: noAdBookingsYet \? NO_AD_BOOKING_YET/);
    expect(LOADER).toMatch(/returnOnAdSpend: showAdSpend[\s\S]{0,80}noAdBookingsYet/);
  });
});

describe("3. calls are kept apart by platform", () => {
  test("Meta's calls are not on the hotel's report", () => {
    // Removed at the agency's request. Taken out of the loader too, not just
    // hidden in the page, so no other view of this data can bring it back.
    expect(REPORT).not.toMatch(/metaCalls/);
    expect(LOADER).not.toMatch(/metaCalls/);
    // Calls from ads is Google only.
    const group = REPORT.slice(REPORT.indexOf('<Group title="Calls from ads"'));
    const body = group.slice(0, group.indexOf("</Group>"));
    expect(body).not.toMatch(/Meta/);
    expect(REPORT).toMatch(/label="Google Ads · calls connected"[\s\S]{0,120}data\.ads\.googleCalls/);
  });

  test("Google's two call measurements are preferred, never added", () => {
    // They OVERLAP: a call from a call asset that the advertiser also tracks as
    // a conversion is in both, so one total double-counts it.
    expect(LOADER).toMatch(/google\._count\.phoneCalls > 0/);
    expect(LOADER).toMatch(/google\._count\.callConversions > 0/);
    expect(LOADER).not.toMatch(/callConversions\s*\+\s*[^)]*phoneCalls/);
    expect(SYNC).not.toMatch(/callConversions\s*\+\s*[^)]*phoneCalls/);
  });

  test("raw call-asset calls are preferred over the conversion count", () => {
    // Conversions are only the subset meeting the advertiser's rules. On Aster
    // the two read 56 against 15.5, and the conversion figure silently dropped
    // four calls from two campaigns with no call conversion action at all.
    const phoneAt = LOADER.indexOf("google._count.phoneCalls > 0");
    const convAt = LOADER.indexOf("google._count.callConversions > 0");
    expect(phoneAt).toBeGreaterThan(-1);
    expect(convAt).toBeGreaterThan(-1);
    expect(phoneAt).toBeLessThan(convAt);
  });

  test("the fallback conversion count is rounded before a hotel sees it", () => {
    // Google splits conversion credit across touchpoints, so that side arrives
    // fractional; "12.83 calls" is not a figure to put in front of a client.
    expect(LOADER).toMatch(/Math\.round\(num\(google\._sum\.callConversions\)\)/);
    // The preferred figure is already whole and must not be mangled.
    expect(LOADER).not.toMatch(/Math\.round\(num\(google\._sum\.phoneCalls\)\)/);
  });

  test("no call figure retrieved stays not_traceable, never zero", () => {
    expect(LOADER).toMatch(/notTraceable<number>\(GOOGLE_CALLS_NOT_CAPTURED\)/);
    // Asserted on the constant's own text, not the comment explaining it:
    // readCode strips comments so prose cannot satisfy a source assertion.
    expect(LOADER).toMatch(/has not reported calls separately/);
    expect(LOADER).toMatch(/It is not a zero/);
  });

  test("coverage is counted per field, so null never reads as zero calls", () => {
    // `_count: { _all: true }` counts rows that have spend. Only a per-field
    // count says how many campaign-days actually carry a call figure.
    expect(LOADER).toMatch(
      /_count: \{ _all: true, callConversions: true, phoneCalls: true, callClicks: true \}/,
    );
    // A day whose extra query failed has not had zero calls.
    expect(SYNC).toMatch(/callConversions: callConversionsByKey\.get\([^)]*\) \?\? null/);
    // Scoped to the write site: the accumulator's own `?? 0` is correct there,
    // it is seeding a running sum, not deciding what a missing day means.
    expect(SYNC).not.toMatch(/callConversions: callConversionsByKey\.get\([^)]*\) \?\? 0/);
    expect(SYNC).not.toMatch(/phoneCalls: phoneCallsByKey\.get\([^)]*\) \?\? 0/);
    expect(SCHEMA).toMatch(/callConversions\s+Float\?/);
    expect(SCHEMA).toMatch(/phoneCalls\s+Int\?/);
  });

  test("fetching calls can never cost the spend sync", () => {
    // Adding these fields to the main query would mean one unsupported field
    // costs spend, impressions and clicks for every hotel at once. Separate
    // queries in their own try/catch cost only the call figures.
    const main = SYNC.slice(0, SYNC.indexOf("callConversionsByKey"));
    expect(main).not.toMatch(/conversion_action_category|metrics\.phone_calls/);
    for (const q of ["segments.conversion_action_category", "metrics.phone_calls"]) {
      const at = SYNC.indexOf(q);
      expect(at).toBeGreaterThan(-1);
      // Each sits inside a try that swallows its own failure.
      const before = SYNC.slice(0, at);
      expect(before.lastIndexOf("try {")).toBeGreaterThan(before.lastIndexOf("} catch"));
    }
    expect(SYNC.match(/} catch \(err\) \{\s*console\.warn\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("the conversion category is filtered in code, not in the WHERE clause", () => {
    // An enum value Google renames turns a filtered query into an error; an
    // unrecognised value here simply matches nothing.
    expect(SYNC).toMatch(/conversionActionCategory[\s\S]{0,60}!== "PHONE_CALL_LEAD"/);
    expect(SYNC).not.toMatch(/WHERE[\s\S]{0,200}conversion_action_category\s*=/);
  });
});

describe("4. the client view carries no attribution", () => {
  test("its captions name the recorder and refuse credit", () => {
    expect(CLIENT_CAPTION.calls).toMatch(/property's own team/i);
    expect(CLIENT_CAPTION.calls).toMatch(/cannot be credited to any one channel/i);
  });

  test("it says plainly that these are never divided by ad spend", () => {
    expect(REPORT).toMatch(/never divided by ad spend/i);
  });

  test("it contains no ratio tile at all", () => {
    const client = REPORT.slice(REPORT.indexOf("function ClientDataView"));
    expect(client).not.toMatch(/format="multiple"/);
    expect(client).not.toMatch(/Return on ad spend/);
  });

  test("client revenue is not_traceable, not zero", () => {
    // The operations sheet has no money column, and website revenue belongs to
    // the ads view.
    expect(LOADER).toMatch(/totalRevenue: notTraceable\(CLIENT_REVENUE_NOT_RECORDED\)/);
  });
});

describe("5. the ads view never claims to be a total", () => {
  test("every caption says the figure is ad-produced", () => {
    for (const key of ["totalRevenue", "enquiriesFromAds", "whatsappBookings"] as const) {
      expect(ADS_CAPTION[key], key).toMatch(/ad|advertis/i);
    }
  });

  test("the bookings caption points the reader at the other view", () => {
    // Otherwise "WhatsApp bookings: 1" reads as the property having one.
    expect(ADS_CAPTION.whatsappBookings).toMatch(/Not every WhatsApp booking/i);
    expect(ADS_CAPTION.whatsappBookings).toMatch(/client view/i);
  });
});

describe("6. switching view keeps the reader's place", () => {
  test("period and property survive the switch", () => {
    // Otherwise changing view silently resets the window being looked at.
    expect(PAGE).toMatch(/preserve=\{\{[\s\S]{0,200}range: one\(sp\.range\)/);
    expect(REPORT).toMatch(/for \(const \[k, val\] of Object\.entries\(preserve\)\)/);
  });

  test("an unknown view parameter lands on the default", () => {
    expect(PAGE).toMatch(/one\(sp\.view\) === "client" \? "client" : "ads"/);
  });
});
