import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import {
  ok,
  ratio,
  sum,
  unavailable,
  isOk,
  METRIC_LABEL,
} from "@/lib/metrics/metric-value";
import { CAPTION, INSTAGRAM_DM_UNTRACEABLE } from "@/lib/metrics/client-report";

// ─────────────────────────────────────────────────────────────────────────────
// THE NINE-FIGURE CLIENT REPORT.
//
// /share/<uuid> answers four questions and stops: what came in, what it cost,
// who got in touch, how many booked. The risk on a report this small is the
// opposite of the risk on the full dashboard: with only nine numbers, every one
// of them is read, and a missing signal rendered as 0 will be believed and acted
// on. So the rules pinned here are all about the difference between a zero and a
// gap.
//
// The loader is database-bound, so its wiring is pinned by source assertion —
// the same approach as tests/spend-display-integrity.test.ts, and for the same
// reason: what regresses is the binding, not the arithmetic. The arithmetic it
// delegates to (`ratio`, `sum`) is pure and IS exercised behaviourally below,
// because those two functions are where an unknown would get laundered into a
// number.
// ─────────────────────────────────────────────────────────────────────────────

const LOADER = readCode("lib/metrics/client-report.ts");
const COMPONENT = readCode("components/dashboard/ClientReport.tsx");
const SHARE_PAGE = readCode("app/share/[uuid]/page.tsx");

const NINE = [
  "totalRevenue",
  "returnOnAdSpend",
  "googleSpend",
  "metaSpend",
  "calls",
  "whatsappMessages",
  "instagramMessages",
  "totalBookings",
  "totalRoomNights",
] as const;

// ── 1. Nine figures, every one a MetricValue ────────────────────────────────

describe("1. the report is exactly nine metrics", () => {
  test.each(NINE)("%s is declared MetricValue<number>", (field) => {
    expect(LOADER).toMatch(new RegExp(`${field}:\\s*MetricValue<number>;`));
  });

  test("no tenth figure has been added without a decision", () => {
    const declared = [...LOADER.matchAll(/^  (\w+):\s*MetricValue<number>;/gm)].map((m) => m[1]);
    expect(new Set(declared)).toEqual(new Set(NINE));
  });

  test("every one is rendered", () => {
    for (const field of NINE) expect(COMPONENT).toContain(`data.${field}`);
  });
});

// ── 2. A gap may never become a zero ────────────────────────────────────────

describe("2. unknowns are never coerced", () => {
  test("the loader contains no `?? 0` against a metric", () => {
    // The one `?? 0` permitted is inside the room-nights reduce, where the null
    // rows have ALREADY been filtered out — so it can only ever see a number.
    const offenders = LOADER.split("\n").filter(
      (l) => /\?\?\s*0/.test(l) && !/roomNightsConfirmed \?\? 0/.test(l),
    );
    expect(offenders).toEqual([]);
  });

  test("Instagram DMs are not_traceable, permanently and unconditionally", () => {
    // Not `unavailable`: there is no integration to reconnect and no setting to
    // turn on. Rendering it as a gap the agency could close would send the hotel
    // to ask for something nobody can deliver.
    expect(LOADER).toMatch(/instagramMessages:\s*notTraceable\(INSTAGRAM_DM_UNTRACEABLE\)/);
    expect(INSTAGRAM_DM_UNTRACEABLE).toMatch(/cannot report this/);
  });

  test("an unfiled room-night period is not_traceable, not zero", () => {
    // Nobody filed is not nobody stayed.
    expect(LOADER).toMatch(/recorded\.length === 0\s*\?\s*notTraceable\(/);
  });

  test("a silent snippet is unavailable, not zero revenue", () => {
    // Distinguishing these needs the extra `anyTraffic` count: without it an
    // uninstalled snippet and a genuinely quiet month are the same ₹0.
    expect(LOADER).toContain("anyTraffic");
    expect(LOADER).toMatch(/anyTraffic === 0\s*\n?\s*\?\s*unavailable\(/);
  });

  test("a nullable ad column that was never captured is unavailable, not zero", () => {
    // _count on a nullable column counts NON-NULL rows, so 0 means the column
    // was never populated for this window — summing it would report 0 calls.
    expect(LOADER).toMatch(/populated === 0\s*\n?\s*\?\s*unavailable\(/);
  });
});

// ── 3. The arithmetic refuses to launder an unknown ─────────────────────────

describe("3. ratio and sum propagate, never default", () => {
  test("an unknown spend makes return on ad spend unknown, not infinite", () => {
    const got = ratio(ok(500_000), unavailable("Meta Ads is not connected."));
    expect(isOk(got)).toBe(false);
  });

  test("an unknown addend makes the spend total unknown", () => {
    // The dangerous direction: a partial total is SMALLER, which INFLATES the
    // ratio built on it and overstates the agency's own performance.
    const got = sum([ok(141_024), unavailable("Google Ads reported no days.")]);
    expect(isOk(got)).toBe(false);
  });

  test("a not-connected platform contributes a real zero", () => {
    // An account that does not exist spent nothing. Letting this make the total
    // unknown would withhold a good ratio from every single-platform hotel.
    const got = sum([ok(0), ok(141_024)]);
    expect(got).toEqual(ok(141_024));
  });

  test("zero spend yields no ratio rather than a division by zero", () => {
    const got = ratio(ok(519_443), ok(0));
    expect(isOk(got)).toBe(false);
  });

  test("zero revenue against real spend is a genuine 0x, not a gap", () => {
    // This one IS a finding, and must not be dressed up as a measurement gap.
    expect(ratio(ok(0), ok(141_024))).toEqual(ok(0));
  });
});

// ── 4. The spend gate, on both halves ───────────────────────────────────────

describe("4. showAdSpendToHotel governs three tiles, not two", () => {
  test("the loader withholds the ratio as well as the two spend figures", () => {
    // Return on ad spend is revenue ÷ spend. Published beside a known revenue it
    // hands the spend straight back by division, so it cannot survive the flag.
    for (const field of ["returnOnAdSpend", "googleSpend", "metaSpend"]) {
      expect(LOADER).toMatch(new RegExp(`${field}:\\s*showAdSpend \\? \\w+ : withheld`));
    }
  });

  test("the withheld value carries no number", () => {
    expect(LOADER).toMatch(/const withheld = unavailable\(/);
  });

  test("the component omits the spend group rather than emptying it", () => {
    expect(COMPONENT).toMatch(/\{showAdSpend && \(\s*<Group title="Advertising spend"/);
  });

  test("the page passes the hotel's flag to both loader and component", () => {
    expect(SHARE_PAGE).toMatch(/showAdSpend:\s*link\.showAdSpend/);
    expect(SHARE_PAGE).toMatch(/showAdSpend=\{link\.showAdSpend\}/);
  });
});

// ── 5. Every figure says what it is ─────────────────────────────────────────

describe("5. captions place the number", () => {
  test("return on ad spend discloses that it is blended", () => {
    // lib/owner-metrics.ts reserves "ROAS" for paid-revenue-over-paid-spend and
    // calls this one `blended`. Using the hotel's word for it is fine; using it
    // WITHOUT this sentence is how the old contaminated ROAS read.
    expect(CAPTION.returnOnAdSpend).toMatch(/direct and organic/i);
  });

  test("room nights are not passed off as bookings", () => {
    expect(CAPTION.totalRoomNights).toMatch(/One booking can be several nights/i);
  });

  test("the WhatsApp figure admits it includes Messenger and Instagram", () => {
    // The same Meta field backs this tile and makes an Instagram-only count
    // impossible — so the two tiles must not contradict each other.
    expect(CAPTION.whatsappMessages).toMatch(/Messenger and Instagram/);
  });

  test("the unknown states render in the hotel's language", () => {
    expect(METRIC_LABEL.unavailable).toBe("Data unavailable");
    expect(METRIC_LABEL.not_traceable).toBe("Not traceable");
  });

  test("a tile with no figure shows its reason, not just a label", () => {
    // "Data unavailable" alone sends the hotel to ask the agency what it means.
    expect(COMPONENT).toMatch(/!isOk\(value\)[\s\S]*?\{value\.reason\}/);
  });
});

// ── 6. Tenant isolation ─────────────────────────────────────────────────────

describe("6. every read is agency-scoped", () => {
  test("the loader reaches prisma only through agencyScoped", () => {
    const direct = LOADER.split("\n").filter(
      (l) => /prisma\.\w+/.test(l) && !/agencyScoped\(prisma\./.test(l),
    );
    expect(direct).toEqual([]);
  });

  test("the share page installs the override from the ShareLink row, not the URL", () => {
    expect(SHARE_PAGE).toMatch(/runWithAgencyScope\(link\.agencyId/);
    expect(SHARE_PAGE).not.toMatch(/runWithAgencyScope\(\s*(sp|uuid|params)/);
  });
});

// ── 7. The spend setting is reachable ───────────────────────────────────────
//
// showAdSpendToHotel governs whether a client sees ad spend, and it defaults to
// FALSE. Its toggle lived in HotelShareManager.tsx, which stopped being rendered
// when the /h/<token> hotel-login route was retired — and nothing caught it,
// because the FLAG kept working perfectly. Every hotel silently had spend
// hidden, with no way for any agency to turn it on, until the leak in
// ContactReport made spend appear regardless.
//
// The lesson is that a setting is not implemented until it is REACHABLE. These
// assertions chase the whole path — page loads the flag, passes it down, and the
// rendered component offers the server action that writes it.

const HOTEL_PAGE = readCode("app/(agency)/agency/(app)/hotel/[id]/page.tsx");
const SHARE_MANAGER = readCode("app/(agency)/agency/(app)/hotel/[id]/ShareLinkManager.tsx");

describe("7. an agency can actually change the ad-spend setting", () => {
  test("the hotel page reads the flag", () => {
    expect(HOTEL_PAGE).toMatch(/showAdSpendToHotel:\s*true/);
  });

  test("the page passes it to the component it actually renders", () => {
    // ShareLinkManager is the rendered one. Passing the flag to a component that
    // no page imports is how this broke the first time.
    expect(HOTEL_PAGE).toContain("<ShareLinkManager");
    expect(HOTEL_PAGE).toMatch(/showAdSpend=\{hotel\.showAdSpendToHotel\}/);
  });

  test("the rendered component offers the write action", () => {
    expect(SHARE_MANAGER).toContain("setShowAdSpendToHotel");
    expect(SHARE_MANAGER).toMatch(/<AdSpendToggle/);
  });

  test("the toggle shows whether or not a share link exists yet", () => {
    // An agency should be able to decide what the report will show BEFORE
    // handing the link to a client, not only after minting one.
    expect([...SHARE_MANAGER.matchAll(/<AdSpendToggle/g)]).toHaveLength(2);
  });

  test("the write action is agency-scoped", () => {
    const ACTIONS = readCode("app/(agency)/agency/(app)/hotel/[id]/hotel-share-actions.ts");
    const fn = ACTIONS.slice(ACTIONS.indexOf("export async function setShowAdSpendToHotel"));
    expect(fn).toMatch(/agencyScoped\(prisma\.hotelClient\)/);
    expect(fn).toMatch(/ownHotelId\(/);
  });
});

// ── 8. Coverage warnings ────────────────────────────────────────────────────
//
// A figure whose source stopped before the period ended is not a figure for that
// period. The full dashboard said so in words; the first cut of this report
// dropped that and would have shown ₹92,740 with no hint a day was missing.
//
// THE TIMESTAMP THAT MATTERS is the newest DAY OF DATA, never "when the sync
// last ran". Those came apart in production on 2026-09-16: Google Ads synced
// successfully at 12:00 IST and still had no row for that day, so a last-ran
// check would have called a short figure fresh.

describe("8. a short figure says it is short", () => {
  test("coverage is judged on the newest data day, not the last sync time", () => {
    // _max.date is the newest row; lastSyncedAt would be the wrong field here.
    expect(LOADER).toMatch(/_max:\s*\{\s*date:\s*true\s*\}/);
    expect(LOADER).toMatch(/coverageNote\("Meta Ads",\s*meta\._max\.date\)/);
    expect(LOADER).toMatch(/coverageNote\("Google Ads",\s*google\._max\.date\)/);
  });

  test("the comparison is by day in the property's timezone", () => {
    // A timestamp compare flags every source on every report as stale, and a
    // warning that is always on is a warning nobody reads.
    expect(LOADER).toMatch(/zonedDayString\([\s\S]*?range\.timezone/);
    expect(LOADER).toMatch(/newestDay < periodEndsOn/);
  });

  test("return on ad spend is short when EITHER platform is short", () => {
    // It divides revenue by both platforms' spend, so one missing day makes the
    // ratio overstate the return.
    expect(LOADER).toMatch(/returnOnAdSpend:\s*showAdSpend\s*\?\s*\(googleNote \?\? metaNote\)/);
  });

  test("all three Meta-fed tiles carry Meta's coverage", () => {
    for (const f of ["metaSpend", "calls", "whatsappMessages"]) {
      expect(LOADER).toMatch(new RegExp(`${f}:\\s*(showAdSpend \\? )?metaNote`));
    }
  });

  test("a covered source produces no key at all", () => {
    // Undefined entries are filtered out, so the component renders nothing
    // rather than an empty warning box.
    expect(LOADER).toMatch(/\.filter\(\(\[, v\]\) => v != null\)/);
  });

  test("the tile renders the warning above the caption", () => {
    const tile = COMPONENT.slice(COMPONENT.indexOf("function Tile"));
    expect(tile.indexOf("{staleNote &&")).toBeLessThan(tile.indexOf("{caption &&"));
  });

  test("coverage notes are withheld with the spend they describe", () => {
    // "Google Ads has data up to the 15th" on a report that hides spend would
    // leak which platforms are running at all.
    for (const f of ["metaSpend", "googleSpend", "returnOnAdSpend"]) {
      expect(LOADER).toMatch(new RegExp(`${f}:\\s*showAdSpend \\?`));
    }
  });
});
