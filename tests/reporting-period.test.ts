import { describe, expect, test } from "vitest";

import { resolveRange, previousRangeOf, MAX_RANGE_DAYS, type RangeParams } from "@/lib/attribution";
import {
  DEFAULT_TIMEZONE,
  parseZonedDayStart,
  parseZonedDayEnd,
  startOfZonedDay,
  zonedDayString,
  safeTimeZone,
} from "@/lib/timezone";

// ─────────────────────────────────────────────────────────────────────────────
// THE REPORTING PERIOD — one window, resolved on the server, in the property's
// own timezone, from a URL anyone can edit.
//
// /share/<uuid> is public, forwardable and mistypable. Two classes of defect are
// pinned here:
//
//   1. A 500 ON A CLIENT'S LINK. The old guard was a SHAPE test, not a date
//      test, so "2026-13-45" matched, became an Invalid Date, and threw
//      RangeError out of toISOString(). Reproduced against the pre-change tree
//      before this suite was written.
//
//   2. A FIVE-AND-A-HALF-HOUR WINDOW SHIFT. Every boundary was computed with
//      Date.UTC(), so for an Asia/Kolkata property "Today" ran 05:30 to 05:29.
//      Every figure a client read under Today and Yesterday was wrong.
// ─────────────────────────────────────────────────────────────────────────────

const IST = "Asia/Kolkata";
const NOW = new Date("2026-09-09T12:00:00.000Z"); // 17:30 IST on 9 Sep 2026
const at = (extra: Record<string, unknown> = {}) => ({ now: NOW, timezone: IST, ...extra });

describe("1. nothing the URL can carry produces an error", () => {
  const hostile: RangeParams[] = [
    { from: "banana", to: "2026-13-45" }, // the brief's Gate 1 case
    { from: "2026-13-45", to: "2026-09-09" },
    { from: "2026-02-30", to: "2026-09-09" },
    { from: "", to: "" },
    { from: "2026-09-09T00:00:00Z", to: "2026-09-10" },
    { from: "0000-00-00", to: "9999-99-99" },
    { from: "2026-9-9", to: "2026-09-10" }, // unpadded is not the contract
    { range: "'; DROP TABLE--", from: "../../etc/passwd" },
    { from: "2026-09-09" },
    { to: "2026-09-09" },
    { range: " " },
    { from: "  2026-09-01  ", to: "2026-09-05" },
  ];

  test.each(hostile)("%j resolves without throwing", (sp) => {
    const r = resolveRange(sp, at());
    expect(Number.isNaN(r.since.getTime())).toBe(false);
    expect(Number.isNaN(r.until.getTime())).toBe(false);
    expect(r.since.getTime()).toBeLessThanOrEqual(r.until.getTime());
    expect(r.dateLabel).toBeTruthy();
  });

  test("the brief's exact case falls back to the 30-day default", () => {
    const r = resolveRange({ from: "banana", to: "2026-13-45" }, at());
    expect(r.key).toBe("30");
  });

  test("a shape-valid but impossible date is rejected, not coerced", () => {
    expect(parseZonedDayStart("2026-13-45", IST)).toBeNull();
    expect(parseZonedDayStart("2026-02-30", IST)).toBeNull();
    expect(parseZonedDayStart("2026-02-29", IST)).toBeNull(); // 2026 is not a leap year
    expect(parseZonedDayStart("2024-02-29", IST)).not.toBeNull();
  });

  test("one malformed bound discards the whole custom range", () => {
    // Half a request is a broken URL, not a request for half a window.
    const r = resolveRange({ from: "2026-09-01", to: "nonsense", range: "7" }, at());
    expect(r.key).toBe("7");
  });

  test("a custom range needs BOTH bounds", () => {
    expect(resolveRange({ from: "2026-09-01" }, at()).key).toBe("30");
    expect(resolveRange({ to: "2026-09-05" }, at()).key).toBe("30");
    expect(resolveRange({ from: "2026-09-01", to: "2026-09-05" }, at()).key).toBe("custom");
  });
});

describe("2. out-of-bounds requests are clamped and REPORTED", () => {
  test("a future end date is pulled back to today", () => {
    const r = resolveRange({ from: "2026-09-01", to: "2027-06-01" }, at());
    expect(r.toInput).toBe("2026-09-09");
    expect(r.adjustments.join(" ")).toMatch(/future/i);
  });

  test("reversed bounds are swapped, not rendered as an empty window", () => {
    const r = resolveRange({ from: "2026-09-09", to: "2026-01-01" }, at());
    expect(r.fromInput).toBe("2026-01-01");
    expect(r.toInput).toBe("2026-09-09");
    expect(r.since.getTime()).toBeLessThan(r.until.getTime());
    expect(r.adjustments.join(" ")).toMatch(/wrong way round/i);
  });

  test("a span over the cap clamps FORWARD, keeping the most recent window", () => {
    const r = resolveRange({ from: "2019-01-01", to: "2026-09-09" }, at());
    expect(r.toInput).toBe("2026-09-09");
    // Most recent MAX_RANGE_DAYS, inclusive of both ends.
    expect(r.fromInput).toBe("2025-09-09");
    expect(r.adjustments.join(" ")).toMatch(new RegExp(`${MAX_RANGE_DAYS} days`));
  });

  test("the start is clamped to the property's first recorded activity", () => {
    const earliest = new Date("2026-06-15T04:00:00.000Z");
    const r = resolveRange({ from: "2020-01-01", to: "2026-09-09" }, at({ earliest }));
    expect(r.fromInput).toBe("2026-06-15");
    expect(r.adjustments.join(" ")).toMatch(/first recorded activity/i);
  });

  test("an honoured request reports no adjustments", () => {
    const r = resolveRange({ from: "2026-09-01", to: "2026-09-05" }, at());
    expect(r.adjustments).toEqual([]);
  });

  test("presets are clamped to today too", () => {
    const ceiling = new Date("2026-09-09T18:29:59.999Z").getTime();
    for (const key of ["today", "7", "30", "90", "this_month"]) {
      const r = resolveRange({ range: key }, at());
      expect(r.until.getTime(), key).toBeLessThanOrEqual(ceiling);
    }
  });
});

describe("3. day boundaries are the property's, not UTC", () => {
  test("1 September IST is 31 Aug 18:30Z to 1 Sep 18:29:59.999Z", () => {
    // The exact case in the brief. Under the old UTC maths this was
    // 2026-09-01T00:00:00Z to 23:59:59Z, i.e. shifted by 5h30m.
    expect(parseZonedDayStart("2026-09-01", IST)!.toISOString()).toBe("2026-08-31T18:30:00.000Z");
    expect(parseZonedDayEnd("2026-09-01", IST)!.toISOString()).toBe("2026-09-01T18:29:59.999Z");
  });

  test("an evening-IST event belongs to the IST day, not the next UTC day", () => {
    // 19:00Z on 8 Sep is 00:30 IST on 9 Sep.
    const justAfterMidnightIst = new Date("2026-09-08T19:00:00.000Z");
    expect(zonedDayString(justAfterMidnightIst, IST)).toBe("2026-09-09");
    expect(zonedDayString(justAfterMidnightIst, "UTC")).toBe("2026-09-08");
  });

  test("a period ending today includes this evening and excludes tomorrow", () => {
    const r = resolveRange({ range: "today" }, at());
    const thisEveningIst = new Date("2026-09-09T17:00:00.000Z"); // 22:30 IST today
    const tomorrowUtcEarly = new Date("2026-09-09T19:00:00.000Z"); // 00:30 IST tomorrow
    expect(thisEveningIst >= r.since && thisEveningIst <= r.until).toBe(true);
    expect(tomorrowUtcEarly > r.until).toBe(true);
  });

  test("the timezone travels on the resolved range", () => {
    expect(resolveRange({ range: "30" }, at()).timezone).toBe(IST);
    expect(resolveRange({ range: "30" }, { now: NOW }).timezone).toBe(DEFAULT_TIMEZONE);
  });

  test("an unknown stored timezone falls back to the default, it does not throw", () => {
    expect(safeTimeZone("Mars/Olympus_Mons")).toBe(DEFAULT_TIMEZONE);
    expect(safeTimeZone(null)).toBe(DEFAULT_TIMEZONE);
    expect(safeTimeZone("America/New_York")).toBe("America/New_York");
    const r = resolveRange({ range: "today" }, at({ timezone: "Mars/Olympus_Mons" }));
    expect(r.timezone).toBe(DEFAULT_TIMEZONE);
  });

  test("a non-IST property gets its own boundaries", () => {
    const r = resolveRange({ range: "today" }, at({ timezone: "America/New_York" }));
    // 12:00Z on 9 Sep is 08:00 EDT, so "today" began at 04:00Z.
    expect(r.since.toISOString()).toBe("2026-09-09T04:00:00.000Z");
  });
});

describe("4. the period is always stated as literal dates", () => {
  test("every preset carries a dateLabel containing real dates", () => {
    for (const key of ["today", "yesterday", "7", "30", "90", "this_month", "prev_month"]) {
      const r = resolveRange({ range: key }, at());
      expect(r.dateLabel, key).toMatch(/[0-9]{4}/);
    }
  });

  test("labels read naturally across day, month and year spans", () => {
    expect(resolveRange({ range: "today" }, at()).dateLabel).toBe("9 Sep 2026");
    expect(resolveRange({ from: "2026-09-01", to: "2026-09-09" }, at()).dateLabel).toBe("1–9 Sep 2026");
    expect(resolveRange({ from: "2026-08-01", to: "2026-09-09" }, at()).dateLabel).toBe(
      "1 Aug – 9 Sep 2026",
    );
    expect(resolveRange({ from: "2025-12-01", to: "2026-09-09" }, at()).dateLabel).toBe(
      "1 Dec 2025 – 9 Sep 2026",
    );
  });

  test("a custom range compares against the equal-length window before it", () => {
    const r = resolveRange({ from: "2026-09-01", to: "2026-09-10" }, at());
    const prev = previousRangeOf(r);
    expect(prev.until.getTime()).toBe(r.since.getTime() - 1);
    expect(prev.until.getTime() - prev.since.getTime()).toBe(r.until.getTime() - r.since.getTime());
    expect(prev.label).toMatch(/Aug/);
  });
});

describe("5. the resolved window is internally coherent", () => {
  test("since is always start-of-day and until always end-of-day in the property zone", () => {
    const specs = [
      { range: "today" },
      { range: "yesterday" },
      { range: "7" },
      { range: "30" },
      { range: "prev_month" },
      { from: "2026-08-02", to: "2026-09-03" },
    ];
    for (const sp of specs) {
      const r = resolveRange(sp, at());
      expect(startOfZonedDay(r.since, IST).toISOString(), JSON.stringify(sp)).toBe(
        r.since.toISOString(),
      );
      expect(r.until.toISOString().endsWith("29:59.999Z"), JSON.stringify(sp)).toBe(true);
    }
  });

  test("fromInput/toInput round-trip back to the same window", () => {
    const r = resolveRange({ from: "2026-08-02", to: "2026-09-03" }, at());
    const again = resolveRange({ from: r.fromInput, to: r.toInput }, at());
    expect(again.since.toISOString()).toBe(r.since.toISOString());
    expect(again.until.toISOString()).toBe(r.until.toISOString());
  });
});
