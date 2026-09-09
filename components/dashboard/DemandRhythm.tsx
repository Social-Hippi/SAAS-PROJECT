import { formatNumber, formatPercent } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// WHEN DEMAND ARRIVES (Phase 9.4).
//
// Two operational reads that cost nothing extra, because both series already
// exist: when enquiries actually come in (a front-desk staffing signal), and
// whether the days that generate TRAFFIC are the days that generate CONTACTS
// (a posting-time and content signal).
//
// A day is only called out when it deviates from the period mean by more than
// 25%. Below that it is noise, and pointing at noise in a client report is how
// a reader learns to stop trusting the callouts that matter.
//
// Two separate bars per weekday rather than a dual-axis chart: contacts and
// visits differ by two orders of magnitude, and putting them on one pair of axes
// would make their crossings look meaningful when they are an artefact of
// scaling. Each series is normalised against ITS OWN maximum, and the caption
// says so.
// ─────────────────────────────────────────────────────────────────────────────

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Above this, a weekday is worth naming. Below it, it is noise. */
export const RHYTHM_DEVIATION_THRESHOLD = 0.25;

function standouts(series: (number | null)[], label: string): string[] {
  const present = series.filter((v): v is number => v != null);
  if (present.length < 3) return [];
  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  if (mean === 0) return [];

  const out: string[] = [];
  series.forEach((v, i) => {
    if (v == null) return;
    const dev = (v - mean) / mean;
    if (Math.abs(dev) <= RHYTHM_DEVIATION_THRESHOLD) return;
    out.push(
      `${WEEKDAYS[i]} runs ${formatPercent(Math.abs(dev))} ${dev > 0 ? "above" : "below"} the average day for ${label}.`,
    );
  });
  return out;
}

function Row({
  values,
  max,
  tint,
}: {
  values: (number | null)[];
  max: number;
  tint: string;
}) {
  return (
    <div className="grid grid-cols-7 gap-1">
      {values.map((v, i) => (
        <div key={i} className="flex flex-col items-center gap-1">
          <div className="flex h-16 w-full items-end">
            <div
              className={`w-full rounded-t ${v == null ? "bg-line" : tint}`}
              style={{ height: v == null ? "2px" : `${Math.max(3, (v / Math.max(max, 1)) * 100)}%` }}
              title={v == null ? "Not recorded" : formatNumber(v)}
            />
          </div>
          <span className="text-[10px] tabular-nums text-ink-tertiary">
            {v == null ? "—" : formatNumber(v)}
          </span>
          <span className="text-[10px] text-ink-disabled">{SHORT[i]}</span>
        </div>
      ))}
    </div>
  );
}

export function DemandRhythm({
  contactsByWeekday,
  visitsByWeekday,
  periodLabel,
  scopeLabel,
}: {
  contactsByWeekday: (number | null)[];
  visitsByWeekday: (number | null)[];
  periodLabel: string;
  scopeLabel: string;
}) {
  const anyContacts = contactsByWeekday.some((v) => v != null && v > 0);
  const anyVisits = visitsByWeekday.some((v) => v != null && v > 0);
  if (!anyContacts && !anyVisits) return null;

  const notes = [
    ...standouts(contactsByWeekday, "customer contacts"),
    ...standouts(visitsByWeekday, "website visits"),
  ];

  return (
    <section className="rounded-card border border-line bg-card p-4 shadow-card sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-medium text-ink">When demand arrives</h2>
        <p className="text-xs text-ink-tertiary">
          {scopeLabel} · {periodLabel}
        </p>
      </div>

      {anyContacts && (
        <div className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
            Customer contacts by day — recorded by the property
          </p>
          <div className="mt-2">
            <Row
              values={contactsByWeekday}
              max={Math.max(...contactsByWeekday.map((v) => v ?? 0))}
              tint="bg-brand"
            />
          </div>
        </div>
      )}

      {anyVisits && (
        <div className="mt-5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
            Website visits by day — measured by HotelTrack
          </p>
          <div className="mt-2">
            <Row
              values={visitsByWeekday}
              max={Math.max(...visitsByWeekday.map((v) => v ?? 0))}
              tint="bg-ink-disabled"
            />
          </div>
        </div>
      )}

      {notes.length > 0 && (
        <ul className="mt-4 space-y-1 border-t border-line pt-3 text-sm text-ink-secondary">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-xs text-ink-tertiary">
        Each series is scaled against its own busiest day, so the two rows show shape rather than
        size — contacts and visits are different quantities and are not compared to one another. A
        day with no bar was not recorded, which is not the same as a day with none.
      </p>
    </section>
  );
}
