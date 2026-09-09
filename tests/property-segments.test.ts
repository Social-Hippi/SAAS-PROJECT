import { describe, expect, test } from "vitest";

import {
  UNASSIGNED_SEGMENT,
  classifyConversion,
  classifyVisit,
  countBySegment,
  unassignedShare,
  type SegmentRule,
} from "@/lib/segments";
import {
  DISPOSITION_GROUPS,
  summariseTrackerDays,
  contactsByWeekday,
  VARIANCE_DISTRUST_THRESHOLD,
  type TrackerDay,
} from "@/lib/ops-tracker/metrics";
import { isOk } from "@/lib/metrics/metric-value";

// ─────────────────────────────────────────────────────────────────────────────
// PROPERTY SEGMENTS + TRACKER METRICS.
//
// Aster Holidays is ONE HotelClient covering TWO properties. The danger this
// suite guards is a per-property number that was really a group number, or a
// group number that silently covers only one property. Unassigned traffic — the
// home page, the blog, every shared page — belongs to the group and is NEVER
// distributed across properties by ratio.
// ─────────────────────────────────────────────────────────────────────────────

const SEGMENTS: SegmentRule[] = [
  {
    id: "cbh",
    name: "Coffeeberry Hills",
    slug: "coffeeberry-hills",
    displayOrder: 1,
    pathPrefixes: ["/coffeeberry-hills"],
    bookingHosts: ["bookings.coffeeberryhills.in"],
  },
  {
    id: "th",
    name: "Three Hills",
    slug: "three-hills",
    displayOrder: 2,
    pathPrefixes: ["/three-hills-coorg-resort"],
    bookingHosts: [],
  },
];

describe("1. the verification list from the brief", () => {
  test("a Three Hills page classifies as Three Hills", () => {
    expect(classifyVisit("https://asterholidays.com/three-hills-coorg-resort/rooms", SEGMENTS)).toBe("th");
    expect(classifyVisit("/three-hills-coorg-resort/", SEGMENTS)).toBe("th");
  });

  test("a Coffeeberry Hills page classifies as Coffeeberry Hills", () => {
    expect(classifyVisit("https://asterholidays.com/coffeeberry-hills/gallery", SEGMENTS)).toBe("cbh");
  });

  test("the home page classifies as Unassigned", () => {
    // Shared pages belong to the GROUP. Attributing them to a property would be
    // inventing a per-property figure out of a group one.
    expect(classifyVisit("https://asterholidays.com/", SEGMENTS)).toBe(UNASSIGNED_SEGMENT);
    expect(classifyVisit("https://asterholidays.com/blog/monsoon-guide", SEGMENTS)).toBe(UNASSIGNED_SEGMENT);
  });

  test("the real ₹7,475 conversion classifies as Coffeeberry Hills by booking host", () => {
    expect(
      classifyConversion(
        "https://bookings.coffeeberryhills.in/payment/razorpay-callback/MPG0QE_1_1",
        SEGMENTS,
      ),
    ).toBe("cbh");
  });

  test("an unknown booking host falls to Unassigned, never to a guessed property", () => {
    // Three Hills' booking-engine hostname is not known. Guessing it would put
    // real bookings under the wrong property, silently.
    expect(classifyConversion("https://book.somewhere-unknown.example/done", SEGMENTS)).toBe(
      UNASSIGNED_SEGMENT,
    );
  });

  test("an empty rule set matches nothing — the safe failure", () => {
    const empty: SegmentRule[] = [
      { id: "x", name: "X", slug: "x", displayOrder: 1, pathPrefixes: [], bookingHosts: [] },
    ];
    expect(classifyVisit("https://asterholidays.com/anything", empty)).toBe(UNASSIGNED_SEGMENT);
  });
});

describe("2. the sum invariant", () => {
  const rows = [
    { pageUrl: "https://asterholidays.com/" },
    { pageUrl: "https://asterholidays.com/three-hills-coorg-resort/" },
    { pageUrl: "https://asterholidays.com/three-hills-coorg-resort/rooms" },
    { pageUrl: "https://asterholidays.com/coffeeberry-hills/" },
    { pageUrl: "https://asterholidays.com/blog/x" },
    { pageUrl: null },
    { pageUrl: "not a url at all" },
  ];

  test("segment counts plus Unassigned equal the total, exactly", () => {
    // Every row lands in exactly one bucket. If this stops holding, a visit is
    // being double counted or dropped, and either is a reporting defect.
    const counts = countBySegment(rows, SEGMENTS);
    const summed = Object.values(counts.bySegment).reduce((a, b) => a + b, 0) + counts.unassigned;
    expect(summed).toBe(counts.total);
    expect(counts.total).toBe(rows.length);
  });

  test("the counts are the ones a person would expect", () => {
    const counts = countBySegment(rows, SEGMENTS);
    expect(counts.bySegment.th).toBe(2);
    expect(counts.bySegment.cbh).toBe(1);
    expect(counts.unassigned).toBe(4);
  });

  test("the invariant holds when nothing matches", () => {
    const counts = countBySegment(rows, []);
    expect(counts.unassigned).toBe(rows.length);
    expect(counts.total).toBe(rows.length);
  });

  test("unassigned share is null on an empty period, never 0%", () => {
    expect(unassignedShare({ bySegment: {}, unassigned: 0, total: 0 })).toBeNull();
    expect(unassignedShare(countBySegment(rows, SEGMENTS))).toBeCloseTo(4 / 7, 6);
  });

  test("first match wins in displayOrder, deterministically", () => {
    const overlapping: SegmentRule[] = [
      { id: "b", name: "B", slug: "b", displayOrder: 2, pathPrefixes: ["/shared"], bookingHosts: [] },
      { id: "a", name: "A", slug: "a", displayOrder: 1, pathPrefixes: ["/shared"], bookingHosts: [] },
    ];
    expect(classifyVisit("/shared/page", overlapping)).toBe("a");
  });
});

// ── Tracker metrics ─────────────────────────────────────────────────────────

const day = (over: Partial<TrackerDay> & { date: string }): TrackerDay => ({
  enquiries: null, repeatContacts: null, roomNightsConfirmed: null, junkSpam: null,
  soldOut: null, inhouse: null, lowBudget: null, lessRoom: null, lowBudgetLessRoom: null,
  whatsappLeads: null, whatsappConfirmed: null, totalCallsReceived: null,
  storedTotalLeads: null, storedConversionRate: null,
  ...over,
});

describe("3. tracker metrics never fabricate", () => {
  test("a day with no row is unrecorded, not zero", () => {
    const s = summariseTrackerDays([], ["2026-09-01", "2026-09-02"]);
    expect(s.daysMissing).toBe(2);
    expect(s.daysRecorded).toBe(0);
    expect(s.totalCallsReceived.state).toBe("unavailable");
    expect(isOk(s.totalCallsReceived)).toBe(false);
  });

  test("a figure measured at zero renders as zero, not unavailable", () => {
    // The distinction the whole build rests on.
    const s = summariseTrackerDays(
      [day({ date: "2026-09-01", totalCallsReceived: 0, whatsappLeads: 0 })],
      ["2026-09-01"],
    );
    expect(isOk(s.recordedContacts)).toBe(true);
    if (isOk(s.recordedContacts)) expect(s.recordedContacts.value).toBe(0);
  });

  test("completeThrough names the last recorded date", () => {
    const s = summariseTrackerDays(
      [day({ date: "2026-09-01", totalCallsReceived: 3 }), day({ date: "2026-09-05", totalCallsReceived: 4 })],
      ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"],
    );
    expect(s.completeThrough).toBe("2026-09-05");
    expect(s.daysMissing).toBe(4);
  });

  test("room nights per contact is a yield figure and may exceed 1", () => {
    // Three Hills, 15 Aug: 6 room nights against 4 calls = 150%. Not a defect —
    // one booking is several nights, which is why it is never called a
    // conversion rate.
    const s = summariseTrackerDays(
      [day({ date: "2026-08-15", roomNightsConfirmed: 6, totalCallsReceived: 4, whatsappLeads: 0 })],
      ["2026-08-15"],
    );
    expect(isOk(s.roomNightsPerContact)).toBe(true);
    if (isOk(s.roomNightsPerContact)) expect(s.roomNightsPerContact.value).toBeCloseTo(1.5, 6);
  });

  test("dividing by zero contacts is not-applicable, not Infinity", () => {
    const s = summariseTrackerDays(
      [day({ date: "2026-09-01", roomNightsConfirmed: 0, totalCallsReceived: 0, whatsappLeads: 0 })],
      ["2026-09-01"],
    );
    expect(s.roomNightsPerContact.state).toBe("not_applicable");
  });
});

describe("4. the sheets' own contradictions are detected, not smoothed", () => {
  test("Total Leads disagreeing with its components is counted", () => {
    // Coffeeberry Hills: CBH Enquiry + WhatsApp Leads differs from Total Leads
    // by 1-2 on sampled rows.
    const s = summariseTrackerDays(
      [day({ date: "2026-08-01", enquiries: 8, whatsappLeads: 4, storedTotalLeads: 13, totalCallsReceived: 9 })],
      ["2026-08-01"],
    );
    const check = s.variances.find((v) => v.id === "total_leads_vs_components");
    expect(check?.comparable).toBe(1);
    expect(check?.disagreeing).toBe(1);
    expect(check?.examples[0]).toMatchObject({ date: "2026-08-01", stored: 13, computed: 12 });
  });

  test("a small disagreement keeps the computed value; a severe one distrusts both", () => {
    const mild = summariseTrackerDays(
      [day({ date: "2026-08-01", enquiries: 8, whatsappLeads: 4, storedTotalLeads: 13, totalCallsReceived: 9, roomNightsConfirmed: 5 })],
      ["2026-08-01"],
    );
    expect(mild.hasSevereVariance).toBe(false);
    expect(isOk(mild.roomNightsPerContact)).toBe(true);

    // Three Hills, 31 Jul: dispositions total 26 against 9 calls received.
    const severe = summariseTrackerDays(
      [day({
        date: "2026-07-31", totalCallsReceived: 9, whatsappLeads: 2, roomNightsConfirmed: 3,
        repeatContacts: 6, junkSpam: 4, soldOut: 5, inhouse: 4, lowBudgetLessRoom: 7,
      })],
      ["2026-07-31"],
    );
    expect(severe.hasSevereVariance).toBe(true);
    // Neither side can be trusted, so the ratio is withheld rather than guessed.
    const ratio = severe.roomNightsPerContact;
    expect(ratio.state).toBe("unavailable");
    // `in` narrows the discriminated union where isOk()'s predicate cannot:
    // its readonly members are not subtractable from MetricValue<number>.
    if (!("reason" in ratio)) throw new Error("expected an unavailable ratio");
    expect(ratio.reason).toMatch(/contradict/i);
  });

  test("the distrust threshold separates the two observed cases", () => {
    // 13 vs 12 is ~7.7%; 26 vs 9 is ~65%.
    expect(1 / 13).toBeLessThan(VARIANCE_DISTRUST_THRESHOLD);
    expect(17 / 26).toBeGreaterThan(VARIANCE_DISTRUST_THRESHOLD);
  });
});

describe("5. disposition groups", () => {
  test("both column shapes land in the same groups without splitting or duplicating", () => {
    const cbh = summariseTrackerDays(
      [day({ date: "2026-08-01", soldOut: 1, lowBudget: 2, lessRoom: 1, totalCallsReceived: 9, whatsappLeads: 1 })],
      ["2026-08-01"],
    );
    const th = summariseTrackerDays(
      [day({ date: "2026-08-01", soldOut: 1, lowBudgetLessRoom: 3, totalCallsReceived: 9, whatsappLeads: 1 })],
      ["2026-08-01"],
    );
    const lost = (s: ReturnType<typeof summariseTrackerDays>) =>
      isOk(s.dispositionGroups.lost_to_availability_or_rate)
        ? s.dispositionGroups.lost_to_availability_or_rate.value
        : null;
    expect(lost(cbh)).toBe(4);
    expect(lost(th)).toBe(4);
  });

  test("every group is present, and shares are unavailable when contacts are not recorded", () => {
    const s = summariseTrackerDays([day({ date: "2026-08-01", soldOut: 2 })], ["2026-08-01"]);
    for (const g of DISPOSITION_GROUPS) {
      expect(s.dispositionGroups[g]).toBeDefined();
      expect(s.dispositionShare[g]).toBeDefined();
    }
    expect(s.dispositionShare.lost_to_availability_or_rate.state).toBe("unavailable");
  });

  test("qualified new demand is enquiries plus WhatsApp leads", () => {
    const s = summariseTrackerDays(
      [day({ date: "2026-08-01", enquiries: 8, whatsappLeads: 4, totalCallsReceived: 9 })],
      ["2026-08-01"],
    );
    expect(isOk(s.qualifiedNewDemand)).toBe(true);
    if (isOk(s.qualifiedNewDemand)) expect(s.qualifiedNewDemand.value).toBe(12);
  });
});

describe("6. demand rhythm", () => {
  test("contacts bucket by weekday, and an unrecorded day stays null", () => {
    // 2026-09-07 is a Monday.
    const buckets = contactsByWeekday([
      day({ date: "2026-09-07", totalCallsReceived: 5, whatsappLeads: 2 }),
      day({ date: "2026-09-14", totalCallsReceived: 3, whatsappLeads: 1 }),
    ]);
    expect(buckets[1]).toBe(11);
    expect(buckets[0]).toBeNull(); // no Sunday row: unrecorded, not zero
  });
});
