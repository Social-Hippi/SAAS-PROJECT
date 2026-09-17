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

describe("1. the ads view counts only what advertising produced", () => {
  test("revenue is classified per conversion, not taken as a total", () => {
    // A Google Hotel Ads free booking link is organic revenue that happens to
    // come from Google. Counting it as paid is the error the split removes.
    expect(LOADER).toMatch(/canonicalSourceType\(\{ \.\.\.c, value \}\)/);
    expect(LOADER).toMatch(/type === "meta_ads" \|\| type === "google_ads"/);
  });

  test("ROAS divides ad revenue by ad spend — both sides ads", () => {
    expect(LOADER).toMatch(/ratio\(totalRevenue, totalSpend/);
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
  test("Google and Meta are separate tiles, never summed", () => {
    // Counted by different platforms on different definitions; one total would
    // hide which channel produced them.
    expect(REPORT).toMatch(/label="Google Ads"[\s\S]{0,120}data\.ads\.googleCalls/);
    expect(REPORT).toMatch(/label="Meta Ads"[\s\S]{0,120}data\.ads\.metaCalls/);
    expect(LOADER).not.toMatch(/googleCalls \+ metaCalls|metaCalls \+ googleCalls/);
  });

  test("Google calls is not_traceable, naming the missing field", () => {
    // No integration to reconnect and no setting to switch on — the sync simply
    // does not segment by conversion action name.
    expect(LOADER).toMatch(/const googleCalls = notTraceable<number>\(GOOGLE_CALLS_NOT_CAPTURED\)/);
    // Asserted on the constant's own text, not the comment explaining it:
    // readCode strips comments so prose cannot satisfy a source assertion.
    expect(LOADER).toMatch(/does not send us calls separately/);
    expect(LOADER).toMatch(/It is not a zero/);
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
