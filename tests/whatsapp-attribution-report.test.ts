import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// Showing a hotel which ad produced a WhatsApp booking.
//
// The payoff of the whole chain — and the place it is easiest to overclaim. Meta
// naming the ad IS a fact; "the person who messaged is the person who booked" is
// an inference. A family shares a number, an agent books for ten guests.
//
// So the rules pinned here are all about not overstating, and about the
// difference between "the ads produced nothing" and "we were not yet recording
// which ad" — which look identical in a total.
// ─────────────────────────────────────────────────────────────────────────────

const LOADER = readCode("lib/metrics/whatsapp-attribution-report.ts");
const PANEL = readCode("components/dashboard/WhatsAppAttribution.tsx");
const PAGE = readCode("app/share/[uuid]/page.tsx");

describe("1. the join cannot inflate a count", () => {
  test("a booking is counted once even across several conversations", () => {
    // One guest can hold more than one conversation — a repeat visitor, or the
    // same number reaching two pipelines. A plain count would credit the booking
    // to each and inflate every ad it touched.
    expect(LOADER).toMatch(/COUNT\(DISTINCT b\.id\)/);
  });

  test("an enquiry starting AFTER the booking cannot claim it", () => {
    // Otherwise an ad clicked in October is credited with a September booking:
    // attribution running backwards, worse than none.
    expect(LOADER).toMatch(/c\."firstMessageAt" <= b\."bookedAt"/);
  });

  test("the join is scoped to one agency and one hotel", () => {
    expect(LOADER).toMatch(/b\."agencyId" = \$\{agencyId\}/);
    expect(LOADER).toMatch(/c\."agencyId" = b\."agencyId"/);
    expect(LOADER).toMatch(/b\."hotelClientId" = \$\{hotelClientId\}/);
  });
});

describe("2. three numbers, never one", () => {
  test("enquiries, bookings and traced-to-an-ad are all reported", () => {
    // Only the traced figure reads as "your ads produced one booking". Only the
    // total implies the marketing earned all of them. The gap is the subject.
    for (const f of ["enquiries", "bookings", "bookingsFromAds"]) {
      expect(LOADER).toMatch(new RegExp(`${f}:`));
    }
    expect(PANEL).toMatch(/label="Enquiries"/);
    expect(PANEL).toMatch(/label="Bookings"/);
    expect(PANEL).toMatch(/label="Traced to an ad"/);
  });

  test("the untraced remainder is explained, not hidden", () => {
    expect(PANEL).toMatch(/The rest arrived another way, or before tracking began/);
  });
});

describe("3. when tracking started is part of the data", () => {
  test("the loader reports the first ad-carrying enquiry", () => {
    expect(LOADER).toMatch(/attributionSince/);
    expect(LOADER).toMatch(/orderBy: \{ firstMessageAt: "asc" \}/);
  });

  test("the panel says so, and says what it means", () => {
    // "The ads produced nothing" and "we were not recording which ad" look
    // identical in a total. A report read weeks later has no other way to know.
    expect(PANEL).toMatch(/Ad tracking on WhatsApp began/);
    expect(PANEL).toMatch(/not a sign the ads produced nothing/);
  });

  test("the date is rendered in the property's timezone", () => {
    expect(PANEL).toMatch(/timeZone: timezone/);
  });
});

describe("4. a hotel without WhatsApp sees nothing, not a zero", () => {
  test("no connection is distinguished from no activity", () => {
    expect(LOADER).toMatch(/notConnected: true/);
    expect(LOADER).toMatch(/if \(!connection\) return empty;/);
  });

  test("the panel renders nothing at all in that case", () => {
    // A confident "0 enquiries" for a hotel whose WhatsApp simply is not linked
    // would be a measurement gap dressed as a finding.
    expect(PANEL).toMatch(/if \(data\.notConnected\) return null;/);
  });
});

describe("5. it reaches the client report", () => {
  test("the share page renders the panel under the tenant override", () => {
    expect(PAGE).toContain("<WhatsAppAttribution");
    expect(PAGE).toMatch(/loadWhatsAppAttribution\(\{[\s\S]{0,120}agencyId: link\.agencyId/);
  });

  test("the ad is identified by Meta's own id", () => {
    // No friendlier name is guaranteed correct — an ad renamed mid-campaign
    // would have one invented for it.
    expect(PANEL).toMatch(/\{ad\.adId\}/);
  });
});
