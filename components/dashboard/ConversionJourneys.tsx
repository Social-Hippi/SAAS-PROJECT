"use client";

import { useState } from "react";
import { formatCurrency } from "@/lib/format";

// "View journey" drill-down for tracked conversions — the proof artifact an
// agency shows the hotel owner. All data is assembled server-side (already
// agency-scoped) and passed down serialized; this component only renders.

export type ConversionJourney = {
  id: string;
  /** Booking */
  convertedAt: string; // ISO
  conversionValue: number | null;
  bookingPage: string;
  /** First touch (null when the session's first visit wasn't captured) */
  firstTouch: {
    campaign: string | null;
    adTag: string | null; // utm_content
    source: string | null; // utm_source
    date: string; // ISO
    landingPage: string;
  } | null;
  /** Distinct pages between first touch and conversion, in order */
  pagesVisited: string[];
  daysToConvert: number | null;
  /** Final attribution */
  attributedTo: string;
  attributionReason: string;
  // ── Multi-touch attribution (added by the upgrade) ──
  /** Ordered journey sources (normalized; "Direct" for direct/untagged). */
  touchpoints?: { position: number; source: string }[];
  /** True when there were no captured Touchpoint rows (legacy / single-touch). */
  isSingleTouch?: boolean;
  /** Per-model credit split, as integer percentages by source. */
  modelCredits?: {
    first: { source: string; pct: number }[];
    last: { source: string; pct: number }[];
    position: { source: string; pct: number }[];
  };
};

function prettySource(s: string): string {
  if (!s || s === "Direct") return "Direct";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const ORDINAL = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th"];
function ordinal(pos: number): string {
  return ORDINAL[pos - 1] ?? `${pos}th`;
}

function creditLine(pcts: { source: string; pct: number }[]): string {
  if (!pcts.length) return "—";
  return pcts.map((p) => `${prettySource(p.source)} ${p.pct}%`).join(", ");
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? u.search : "") || "/";
  } catch {
    return url;
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const REASON_LABEL: Record<string, string> = {
  exact_utm_campaign: "utm_campaign matched the Meta campaign name exactly",
  utm_content_tag: "utm_content carried the campaign-identifying tag",
  first_touch_session:
    "first visit in this session carried the campaign tag (30-day first-touch)",
  unattributed: "no campaign tag or ad click id on any visit in this session",
};

export function ConversionJourneys({
  journeys,
  viewer = "agency",
}: {
  journeys: ConversionJourney[];
  /**
   * On the public /share report the per-booking drill-down is withheld. The
   * booking itself STAYS — its date, value and attribution state are the point
   * — but the journey behind it is one identifiable person's path through the
   * site, and /share/<uuid> is unauthenticated and forwardable.
   */
  viewer?: "agency" | "share";
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const canDrillDown = viewer !== "share";
  const open = canDrillDown ? (journeys.find((j) => j.id === openId) ?? null) : null;

  if (journeys.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-ink-tertiary">
        No conversions tracked in this range yet.
      </p>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="ht-table w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-tertiary">
            <tr>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 text-right font-medium">Value</th>
              <th className="px-4 py-2 font-medium">Attributed to</th>
              <th className="px-4 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {journeys.map((j) => (
              <tr key={j.id} className="border-t border-line">
                <td className="px-4 py-2 tabular-nums">{fmtDate(j.convertedAt)}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {j.conversionValue == null ? "—" : formatCurrency(j.conversionValue)}
                </td>
                <td className="px-4 py-2">{j.attributedTo}</td>
                <td className="px-4 py-2 text-right">
                  {canDrillDown && (
                    <button
                      type="button"
                      onClick={() => setOpenId(j.id)}
                      className="text-sm font-medium text-brand hover:underline"
                    >
                      View journey
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setOpenId(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-card border border-line bg-elevated p-5 shadow-float"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold text-ink">Visitor journey</h3>
                {open.isSingleTouch && (
                  <span
                    title="Recorded before multi-touch capture — credited as a single touch."
                    className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning"
                  >
                    Single-touch data
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setOpenId(null)}
                className="rounded p-1 text-ink-tertiary hover:bg-line-strong"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <dl className="mt-4 space-y-4 text-sm">
              {open.touchpoints && open.touchpoints.length > 0 && (
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                    Journey ·{" "}
                    {open.touchpoints.length}{" "}
                    touch{open.touchpoints.length === 1 ? "" : "es"}
                  </dt>
                  <dd className="mt-2">
                    <ol className="space-y-1">
                      {open.touchpoints.map((t, i) => (
                        <li key={t.position}>
                          <span className="text-ink-tertiary">{ordinal(i + 1)} touch:</span>{" "}
                          <span className="font-medium text-ink">{prettySource(t.source)}</span>
                          <span className="block pl-1 text-ink-disabled">↓</span>
                        </li>
                      ))}
                      <li>
                        <span className="font-semibold text-success">Booked</span>
                        {open.conversionValue != null && (
                          <span className="text-ink-secondary">
                            {" "}— {formatCurrency(open.conversionValue)}
                          </span>
                        )}
                      </li>
                    </ol>
                  </dd>
                </div>
              )}

              {open.modelCredits && (
                <div className="rounded-lg bg-card p-3">
                  <dt className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                    Credit by model
                  </dt>
                  <dd className="mt-1.5 space-y-1">
                    <p>
                      <span className="font-medium text-ink-secondary">First-Touch:</span>{" "}
                      {creditLine(open.modelCredits.first)}
                    </p>
                    <p>
                      <span className="font-medium text-ink-secondary">Last-Touch:</span>{" "}
                      {creditLine(open.modelCredits.last)}
                    </p>
                    <p>
                      <span className="font-medium text-ink-secondary">Strategic (Position):</span>{" "}
                      {creditLine(open.modelCredits.position)}
                    </p>
                  </dd>
                </div>
              )}

              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                  First touch
                </dt>
                {open.firstTouch ? (
                  <dd className="mt-1 space-y-0.5">
                    <p>
                      <span className="font-medium">Campaign:</span>{" "}
                      {open.firstTouch.campaign ?? "— (untagged)"}
                    </p>
                    {open.firstTouch.adTag && (
                      <p>
                        <span className="font-medium">Ad / content tag:</span>{" "}
                        <code className="rounded bg-code px-1 py-0.5 text-xs text-codeink">
                          {open.firstTouch.adTag}
                        </code>
                      </p>
                    )}
                    {open.firstTouch.source && (
                      <p>
                        <span className="font-medium">Source:</span>{" "}
                        {open.firstTouch.source}
                      </p>
                    )}
                    <p>
                      <span className="font-medium">Date:</span>{" "}
                      {fmtDate(open.firstTouch.date)}
                    </p>
                    <p>
                      <span className="font-medium">Landing page:</span>{" "}
                      <span className="break-all">{pathOf(open.firstTouch.landingPage)}</span>
                    </p>
                  </dd>
                ) : (
                  <dd className="mt-1 text-ink-tertiary">
                    No earlier visit captured for this session.
                  </dd>
                )}
              </div>

              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                  Pages visited
                </dt>
                <dd className="mt-1">
                  {open.pagesVisited.length === 0 ? (
                    <span className="text-ink-tertiary">Converted on the landing page.</span>
                  ) : (
                    <ol className="list-inside list-decimal space-y-0.5">
                      {open.pagesVisited.map((p, i) => (
                        <li key={i} className="break-all">
                          {pathOf(p)}
                        </li>
                      ))}
                    </ol>
                  )}
                </dd>
              </div>

              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                  Time to convert
                </dt>
                <dd className="mt-1">
                  {open.daysToConvert == null
                    ? "—"
                    : open.daysToConvert === 0
                      ? "Same day as first touch"
                      : `${open.daysToConvert} day${open.daysToConvert === 1 ? "" : "s"} after first touch`}
                </dd>
              </div>

              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                  Booking
                </dt>
                <dd className="mt-1 space-y-0.5">
                  <p>
                    <span className="font-medium">Date:</span> {fmtDate(open.convertedAt)}
                  </p>
                  <p>
                    <span className="font-medium">Value:</span>{" "}
                    {open.conversionValue == null
                      ? "not captured"
                      : formatCurrency(open.conversionValue)}
                  </p>
                  <p>
                    <span className="font-medium">Page:</span>{" "}
                    <span className="break-all">{pathOf(open.bookingPage)}</span>
                  </p>
                </dd>
              </div>

              <div className="rounded-lg bg-card p-3">
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                  Final attribution
                </dt>
                <dd className="mt-1">
                  <p className="font-medium">{open.attributedTo}</p>
                  <p className="mt-0.5 text-xs text-ink-tertiary">
                    Why: {REASON_LABEL[open.attributionReason] ?? open.attributionReason}
                  </p>
                </dd>
              </div>
            </dl>
          </div>
        </div>
      )}
    </>
  );
}
