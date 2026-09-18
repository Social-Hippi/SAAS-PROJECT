import { resolveRange, type ResolvedRange } from "@/lib/attribution";
import { addZonedDays, startOfZonedDay, zonedDayString } from "@/lib/timezone";

// ─────────────────────────────────────────────────────────────────────────────
// A date range for ONE section of a page that has several.
//
// The Integrations page has two sections with their own ranges (Kraya leads by
// property, WhatsApp booking values), each under its own query-param prefix so
// they can be set independently. This turns that prefix's params into a window
// through resolveRange — the same validation every report uses: swapped dates
// put right, future ends pulled back to today, over-long windows capped, every
// change reported in words.
//
// "LAST YEAR" IS BUILT HERE, NOT PASSED AS A PRESET. resolveRange knows 7, 30
// and 90 as rolling windows and treats any other number as 30. The first cut of
// these sections passed "365" straight through, so "Last year" silently showed
// the last 30 days — under a description saying "the last year". It is now a
// custom window of the 365 property days ending today, so the dates shown are
// the dates counted.
// ─────────────────────────────────────────────────────────────────────────────

export const SECTION_PRESETS = [
  ["7", "Last 7 days"],
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
  ["365", "Last year"],
] as const;

type PresetKey = (typeof SECTION_PRESETS)[number][0];

export type SectionRangeState =
  | { key: PresetKey }
  | { key: "custom"; from: string; to: string };

const PRESET_KEYS = new Set<string>(SECTION_PRESETS.map(([k]) => k));
const DEFAULT: SectionRangeState = { key: "30" };

type SearchParams = { [key: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** A YYYY-MM-DD string, or null. The shape check only — resolveRange validates. */
function dayOrNull(v: string | undefined): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** Reads `<prefix>`, `<prefix>From`, `<prefix>To`. Anything unreadable → last 30 days. */
export function readSectionRange(sp: SearchParams, prefix: string): SectionRangeState {
  const key = one(sp[prefix]);
  if (key === "custom") {
    const from = dayOrNull(one(sp[`${prefix}From`]));
    const to = dayOrNull(one(sp[`${prefix}To`]));
    return from && to ? { key: "custom", from, to } : DEFAULT;
  }
  return key && PRESET_KEYS.has(key) ? ({ key } as SectionRangeState) : DEFAULT;
}

/** The query params that reproduce this section's state — to carry across links. */
export function sectionRangeParams(prefix: string, s: SectionRangeState): Record<string, string> {
  return s.key === "custom"
    ? { [prefix]: "custom", [`${prefix}From`]: s.from, [`${prefix}To`]: s.to }
    : { [prefix]: s.key };
}

/** The window this state means, in the property's timezone. */
export function resolveSectionRange(
  s: SectionRangeState,
  timezone: string,
  now: Date = new Date(),
): ResolvedRange {
  if (s.key === "custom") return resolveRange({ from: s.from, to: s.to }, { timezone, now });
  if (s.key === "365") {
    const today = startOfZonedDay(now, timezone);
    return resolveRange(
      {
        from: zonedDayString(addZonedDays(today, -364, timezone), timezone),
        to: zonedDayString(today, timezone),
      },
      { timezone, now },
    );
  }
  return resolveRange({ range: s.key }, { timezone, now });
}
