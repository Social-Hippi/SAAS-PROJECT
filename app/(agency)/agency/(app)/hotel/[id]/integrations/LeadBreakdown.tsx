import type { ReactNode } from "react";

import { formatNumber } from "@/lib/format";
import type { PropertyBreakdown } from "@/lib/kraya-lead-breakdown";

/**
 * Kraya leads by property and bucket, for the Integrations page.
 *
 * Aggregate counts only — no guest, number or lead id — so, unlike the booking
 * values table beside it, this is shown to every agency member.
 */
export function LeadBreakdown({
  windowLabel,
  properties,
  picker,
}: {
  /** The literal dates, e.g. "19 Aug – 18 Sep 2026". */
  windowLabel: string;
  properties: PropertyBreakdown[];
  /** The section's range control — presets and a custom range. */
  picker: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-ink">Leads by property</p>
        <p className="mt-1 max-w-[70ch] text-sm text-ink-tertiary">
          Which bucket each lead is in right now, for leads whose first message
          falls in {windowLabel}.{" "}
          <span className="font-medium text-ink-secondary">From ads</span> means
          the guest tapped a Meta click-to-WhatsApp ad — tracked since 11 Sep
          2026. A guest who reached WhatsApp from a Google ad through the
          website is not counted as from ads.
        </p>
      </div>

      {picker}

      {properties.length === 0 ? (
        <p className="rounded-lg border border-line bg-card p-6 text-sm text-ink-tertiary">
          No leads first messaged in this period.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {properties.map((p) => (
            <PropertyBox key={p.pipeline ?? "__none__"} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function PropertyBox({ p }: { p: PropertyBreakdown }) {
  return (
    <section className="rounded-lg border border-line bg-card">
      <div className="border-b border-line p-4">
        <h3 className="text-sm font-semibold text-ink">{p.label}</h3>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span className="text-ink-secondary">
            From ads{" "}
            <span className="font-semibold tabular-nums text-ink">
              {formatNumber(p.fromAds)}
            </span>
          </span>
          <span className="text-ink-tertiary">
            All leads{" "}
            <span className="tabular-nums">{formatNumber(p.all)}</span>
          </span>
        </div>
        {/* Booked is counted from whether the lead ever produced a booking, not
            from the bucket: a guest who booked and then moved on to a later
            bucket would otherwise vanish from it. */}
        <p className="mt-2 text-sm text-ink-secondary">
          Booked{" "}
          <span className="font-semibold tabular-nums text-ink">
            {formatNumber(p.bookedFromAds)}
          </span>{" "}
          from ads{" "}
          <span className="text-ink-tertiary">
            · {formatNumber(p.bookedAll)} of all leads
          </span>
        </p>
        <p className="mt-1 text-xs text-ink-disabled">
          Every lead that reached a booking, including any that have since moved
          to a later bucket.
        </p>
        {/* Contacts loaded into Kraya in one go carry the load's timestamp as
            their "first message", so counting them as enquiries on that day
            would be false. Shown here instead, and left out of every figure
            above. */}
        {p.bulk && (
          <p className="mt-3 rounded-lg border-l-4 border-info bg-info/10 p-2.5 text-xs text-ink-secondary">
            <span className="font-medium text-ink">
              {formatNumber(p.bulk.count)} contacts loaded into Kraya in bulk
            </span>{" "}
            on {p.bulk.days.join(" and ")} — not enquiries, so not counted above
            {p.bulk.booked > 0 && (
              <> · {formatNumber(p.bulk.booked)} later booked</>
            )}
            .
          </p>
        )}
      </div>

      {p.buckets.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-page text-left">
                <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-disabled">
                  Bucket in Kraya now
                </th>
                <th className="px-4 py-2 text-right text-xs font-semibold uppercase tracking-wide text-ink-disabled">
                  From ads
                </th>
                <th className="px-4 py-2 text-right text-xs font-semibold uppercase tracking-wide text-ink-disabled">
                  All leads
                </th>
              </tr>
            </thead>
            <tbody>
              {p.buckets.map((b) => (
                <tr
                  key={b.bucket}
                  className="border-b border-line last:border-0"
                >
                  <td className="px-4 py-2 text-ink">{b.bucket}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink">
                    {b.fromAds === 0 ? (
                      <span className="text-ink-disabled">0</span>
                    ) : (
                      formatNumber(b.fromAds)
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-tertiary">
                    {formatNumber(b.all)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
