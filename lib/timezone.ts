// ─────────────────────────────────────────────────────────────────────────────
// Property-timezone day boundaries.
//
// WHY THIS EXISTS
// Every event timestamp is UTC, and every day boundary used to be computed in
// UTC too (Date.UTC(d.getUTCFullYear(), ...) in lib/attribution.ts). For a
// property in Asia/Kolkata that is wrong by 5h30m in a way nobody notices until
// they check: "Today" began at 05:30 IST and ended at 05:29 the next morning, so
// every figure a client read under the Today and Yesterday chips was a five-and-
// a-half-hour-shifted window. "1 September" to a hotelier means 1 September
// where the hotel is — 2026-08-31T18:30:00Z to 2026-09-01T18:30:00Z — and that
// is what this module produces.
//
// NO DEPENDENCY. Intl carries the IANA database already. A date library would be
// a second source of truth for the one thing that must not have two.
//
// NOT FOR PLATFORM DATA. Google and Meta deliver rows already bucketed into
// THEIR account's day (`date @db.Date`), which is not this timezone and cannot
// be re-derived from a bare calendar date. Those rows are selected by date, in
// the property's interpretation, and labelled as the platform's own buckets —
// never converted. See the methodology note on the report.
// ─────────────────────────────────────────────────────────────────────────────

/** Every property defaults here until one says otherwise. */
export const DEFAULT_TIMEZONE = "Asia/Kolkata";

const DAY_MS = 86_400_000;

/** Is this a timezone Intl actually knows? Guards a bad DB value. */
export function isValidTimeZone(tz: string | null | undefined): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A stored timezone, or the default when it is missing or unknown to Intl. */
export function safeTimeZone(tz: string | null | undefined): string {
  return isValidTimeZone(tz) ? (tz as string) : DEFAULT_TIMEZONE;
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/**
 * The wall-clock reading in `tz` at instant `date`.
 *
 * hourCycle "h23" is deliberate: with `hour12: false` some ICU builds render
 * midnight as hour "24", which silently pushes every start-of-day one day
 * forward. h23 is the only spelling that always yields 0-23.
 */
function wallClockIn(date: Date, tz: string): Wall {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** `tz`'s offset from UTC at this instant, in ms (+5.5h for IST). */
function offsetMsAt(date: Date, tz: string): number {
  const w = wallClockIn(date, tz);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, date.getUTCMilliseconds());
  return asIfUtc - date.getTime();
}

/**
 * The UTC instant at which the given WALL-CLOCK time occurs in `tz`.
 *
 * Two passes, not one: the offset is a function of the instant, and near a DST
 * transition the offset at the naive guess differs from the offset at the answer.
 * Re-evaluating once at the corrected instant converges for every real zone.
 * Asia/Kolkata has no DST and converges on the first pass; the second exists so
 * this stays correct for a property that later sets a DST-observing zone.
 */
function utcFromWallClock(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number, ms: number,
  tz: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const firstPass = naive - offsetMsAt(new Date(naive), tz);
  const secondPass = naive - offsetMsAt(new Date(firstPass), tz);
  return new Date(secondPass);
}

/** "YYYY-MM-DD" as read in `tz` — the calendar date a hotelier would name. */
export function zonedDayString(date: Date, tz: string): string {
  const w = wallClockIn(date, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** First instant of the `tz` calendar day containing `date`. */
export function startOfZonedDay(date: Date, tz: string): Date {
  const w = wallClockIn(date, tz);
  return utcFromWallClock(w.year, w.month, w.day, 0, 0, 0, 0, tz);
}

/** Last instant of the `tz` calendar day containing `date`. */
export function endOfZonedDay(date: Date, tz: string): Date {
  const w = wallClockIn(date, tz);
  return utcFromWallClock(w.year, w.month, w.day, 23, 59, 59, 999, tz);
}

/** First instant of the `tz` calendar month containing `date`. */
export function startOfZonedMonth(date: Date, tz: string): Date {
  const w = wallClockIn(date, tz);
  return utcFromWallClock(w.year, w.month, 1, 0, 0, 0, 0, tz);
}

/**
 * Parse "YYYY-MM-DD" STRICTLY, returning the first instant of that day in `tz`.
 *
 * Strictly, because the previous shape-only regex accepted "2026-13-45": it
 * matched, became an Invalid Date, and threw RangeError out of .toISOString()
 * — a 500 on a public, forwardable URL. A shape test is not a date test, so
 * this round-trips the parsed components and rejects anything that does not
 * survive (2026-02-30, month 13, day 45).
 */
export function parseZonedDayStart(value: string | null | undefined, tz: string): Date | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Round-trip: Date.UTC normalises overflow (Feb 30 → Mar 2), so a component
  // that comes back changed was never a real calendar date.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return utcFromWallClock(year, month, day, 0, 0, 0, 0, tz);
}

/** As `parseZonedDayStart`, but the LAST instant of that day. */
export function parseZonedDayEnd(value: string | null | undefined, tz: string): Date | null {
  const start = parseZonedDayStart(value, tz);
  if (!start) return null;
  return endOfZonedDay(start, tz);
}

/**
 * Whole days from `a` to `b`, counted on the calendar rather than in
 * milliseconds — a DST day is 23 or 25 hours long and a raw division by
 * 86_400_000 drifts. Rounding absorbs that; the callers only need day counts.
 */
export function zonedDaySpan(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** `date` shifted by `days` calendar days, snapped to start-of-day in `tz`. */
export function addZonedDays(date: Date, days: number, tz: string): Date {
  return startOfZonedDay(new Date(date.getTime() + days * DAY_MS), tz);
}
