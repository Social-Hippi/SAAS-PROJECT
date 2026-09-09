import { DEMAND_BUCKET_DEFINITION, DEMAND_BUCKET_LABEL, DEMAND_BUCKETS } from "@/lib/metrics/demand-source";
import { DISPOSITION_GROUPS, DISPOSITION_GROUP_LABEL, DISPOSITION_GROUP_SOURCES } from "@/lib/ops-tracker/metrics";
import { BLENDED_COST_NOTE, CONVERSIONS_UNTYPED, MISSING_MESSAGING, MISSING_CALL_CONVERSIONS } from "@/lib/metrics/contact-report";

// ─────────────────────────────────────────────────────────────────────────────
// HOW WE COUNT.
//
// Every metric on the page: what it means, which system it came from, when that
// system last updated, and whether it can be credited to a marketing channel.
//
// This exists because the honest gaps in this report are numerous and, without
// it, they read as missing features rather than as rigour. A client who can
// audit a definition and find it accurate stops doubting the rest — and the two
// facts that would otherwise look most like defects (booking confirmations are
// not linked; operations figures are the property's own) are stated here plainly
// rather than buried.
//
// Collapsed by default: it is a reference, not a headline. Native <details>, so
// it works without JavaScript and prints expanded.
// ─────────────────────────────────────────────────────────────────────────────

export type MetricDefinition = {
  metric: string;
  definition: string;
  /** The system it came from, in words the reader will recognise. */
  source: string;
  /** When that system last updated, or a plain statement that it has not. */
  lastUpdated: string;
  channelAttributable: "yes" | "no" | "partly";
};

export function MethodologyPanel({
  definitions,
  timezone,
}: {
  definitions: MetricDefinition[];
  timezone: string;
}) {
  const attributionLabel = (v: MetricDefinition["channelAttributable"]) =>
    v === "yes" ? "Yes" : v === "partly" ? "Partly" : "No";

  return (
    <details className="group rounded-card border border-line bg-card shadow-card">
      <summary className="cursor-pointer list-none px-4 py-3 sm:px-5">
        <span className="font-medium text-ink">How we count</span>
        <span className="ml-2 text-sm text-ink-tertiary">
          Every metric on this page, where it comes from, and what it can and cannot be
          credited to.
        </span>
      </summary>

      <div className="border-t border-line px-4 py-4 sm:px-5">
        {/* The two facts that would otherwise look like defects. */}
        <div className="space-y-2 rounded-lg border border-line bg-elevated/50 p-3 text-sm text-ink-secondary">
          <p>
            <span className="font-medium text-ink">Booking confirmations are not linked to
            website sessions.</span>{" "}
            The booking engine sits on a different domain from the marketing site, and identity
            does not survive that hand-off. Until it does, no booking revenue can be credited to
            a marketing channel, and any figure claiming otherwise would be invented.
          </p>
          <p>
            <span className="font-medium text-ink">Operations figures are recorded by the
            property&apos;s own team.</span>{" "}
            Calls, WhatsApp leads and confirmed room nights come from the property&apos;s
            spreadsheet, not from HotelTrack. That tracker has no source or campaign column, so
            none of those contacts can be attributed to a marketing channel.
          </p>
          <p>
            <span className="font-medium text-ink">Days are cut in the property&apos;s own
            timezone ({timezone}).</span>{" "}
            Google and Meta deliver figures already bucketed into their own account day, which
            is not the same day. Platform days and site days may therefore differ by up to one
            day at each boundary. That gap is not reconciled here, because it cannot be
            reconstructed from the data either platform supplies.
          </p>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[42rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-tertiary">
              <tr>
                <th className="py-2 pr-3 font-medium">Metric</th>
                <th className="py-2 pr-3 font-medium">What it means</th>
                <th className="py-2 pr-3 font-medium">Source</th>
                <th className="py-2 pr-3 font-medium">Last updated</th>
                <th className="py-2 font-medium">Channel-attributable</th>
              </tr>
            </thead>
            <tbody>
              {definitions.map((d) => (
                <tr key={d.metric} className="border-t border-line align-top">
                  <td className="py-2 pr-3 font-medium text-ink">{d.metric}</td>
                  <td className="py-2 pr-3 text-ink-secondary">{d.definition}</td>
                  <td className="py-2 pr-3 text-ink-tertiary">{d.source}</td>
                  <td className="py-2 pr-3 tabular-nums text-ink-tertiary">{d.lastUpdated}</td>
                  <td className="py-2">
                    <span
                      className={
                        d.channelAttributable === "yes"
                          ? "text-ink-secondary"
                          : "text-ink-tertiary"
                      }
                    >
                      {attributionLabel(d.channelAttributable)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h4 className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary">
          Traffic source buckets
        </h4>
        <dl className="mt-2 space-y-1.5 text-sm">
          {DEMAND_BUCKETS.map((b) => (
            <div key={b} className="sm:flex sm:gap-3">
              <dt className="shrink-0 font-medium text-ink-secondary sm:w-52">
                {DEMAND_BUCKET_LABEL[b]}
              </dt>
              <dd className="text-ink-tertiary">{DEMAND_BUCKET_DEFINITION[b]}</dd>
            </div>
          ))}
        </dl>

        <h4 className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary">
          Contact disposition groups
        </h4>
        <dl className="mt-2 space-y-1.5 text-sm">
          {DISPOSITION_GROUPS.map((g) => (
            <div key={g} className="sm:flex sm:gap-3">
              <dt className="shrink-0 font-medium text-ink-secondary sm:w-52">
                {DISPOSITION_GROUP_LABEL[g]}
              </dt>
              <dd className="text-ink-tertiary">{DISPOSITION_GROUP_SOURCES[g]}</dd>
            </div>
          ))}
        </dl>

        <h4 className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary">
          Known gaps
        </h4>
        <ul className="mt-2 space-y-1.5 text-sm text-ink-tertiary">
          <li>{CONVERSIONS_UNTYPED}</li>
          <li>{MISSING_MESSAGING}</li>
          <li>{MISSING_CALL_CONVERSIONS}</li>
          <li>{BLENDED_COST_NOTE}</li>
          <li>
            &ldquo;Room nights confirmed&rdquo; counts NIGHTS, not bookings — one booking can be
            several nights. Any ratio built on it is a yield figure and can legitimately exceed
            100%. It is never called a conversion rate.
          </li>
          <li>
            The operations tracker&apos;s own columns do not always reconcile with each other.
            Where a stored total contradicts its components by more than 25%, the figure that
            depends on both is withheld rather than computed from a number that cannot be right.
          </li>
        </ul>
      </div>
    </details>
  );
}
