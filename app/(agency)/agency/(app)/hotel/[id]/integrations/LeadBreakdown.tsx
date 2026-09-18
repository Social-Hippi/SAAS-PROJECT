import Link from "next/link";
import type { ReactNode } from "react";

import { CopyButton } from "@/components/ui/CopyButton";
import { formatNumber } from "@/lib/format";
import {
  dayLabel,
  type BucketAdLead,
  type PropertyBreakdown,
} from "@/lib/kraya-lead-breakdown";
import { zonedDayString } from "@/lib/timezone";

/**
 * Opening a "From ads" count to see the guests behind it. Null for anyone who
 * may not see guest numbers — they get the counts only, as before.
 */
export type Drill = {
  hrefFor: (pipeline: string | null, bucket: string | null) => string;
  /** undefined = nothing open; null = the open cell's value is "none". */
  openPipeline: string | null | undefined;
  openBucket: string | null | undefined;
  leads: BucketAdLead[];
} | null;

/**
 * Kraya leads by property and bucket, for the Integrations page.
 *
 * The counts are aggregate and shown to every agency member. The guests behind
 * a "From ads" count — their numbers — are opened one cell at a time, and only
 * for those given a `drill`.
 */
export function LeadBreakdown({
  windowLabel,
  properties,
  picker,
  timezone,
  drill,
}: {
  /** The literal dates, e.g. "19 Aug – 18 Sep 2026". */
  windowLabel: string;
  properties: PropertyBreakdown[];
  /** The section's range control — presets and a custom range. */
  picker: ReactNode;
  timezone: string;
  drill: Drill;
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
            <PropertyBox
              key={p.pipeline ?? "__none__"}
              p={p}
              drill={drill}
              timezone={timezone}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PropertyBox({
  p,
  drill,
  timezone,
}: {
  p: PropertyBreakdown;
  drill: Drill;
  timezone: string;
}) {
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
              {p.buckets.map((b) => {
                const isOpen =
                  drill != null &&
                  drill.openPipeline !== undefined &&
                  drill.openPipeline === p.pipeline &&
                  drill.openBucket === b.raw;
                return (
                  <BucketRows
                    key={b.bucket}
                    label={b.bucket}
                    fromAds={b.fromAds}
                    all={b.all}
                    href={
                      drill && b.fromAds > 0
                        ? drill.hrefFor(p.pipeline, b.raw)
                        : null
                    }
                    open={isOpen}
                    leads={isOpen && drill ? drill.leads : []}
                    timezone={timezone}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BucketRows({
  label,
  fromAds,
  all,
  href,
  open,
  leads,
  timezone,
}: {
  label: string;
  fromAds: number;
  all: number;
  /** Null when this count cannot be opened (zero, or no permission). */
  href: string | null;
  open: boolean;
  leads: BucketAdLead[];
  timezone: string;
}) {
  return (
    <>
      <tr
        className={`border-b border-line last:border-0 ${open ? "bg-page" : ""}`}
      >
        <td className="px-4 py-2 text-ink">{label}</td>
        <td className="px-4 py-2 text-right tabular-nums text-ink">
          {fromAds === 0 ? (
            <span className="text-ink-disabled">0</span>
          ) : href ? (
            // A link, not a button: the open cell lives in the URL, so it is
            // server-rendered, survives a reload, and loads numbers only when
            // asked for.
            <Link
              href={href}
              scroll={false}
              aria-expanded={open}
              className="rounded-md px-1.5 py-0.5 font-semibold text-brand underline decoration-dotted underline-offset-4 hover:bg-brand/10"
            >
              {formatNumber(fromAds)}
            </Link>
          ) : (
            formatNumber(fromAds)
          )}
        </td>
        <td className="px-4 py-2 text-right tabular-nums text-ink-tertiary">
          {formatNumber(all)}
        </td>
      </tr>
      {open && (
        <tr id="lbp-open" className="border-b border-line bg-page">
          <td colSpan={3} className="px-4 pb-4 pt-1">
            <AdLeadList label={label} leads={leads} timezone={timezone} />
          </td>
        </tr>
      )}
    </>
  );
}

function AdLeadList({
  label,
  leads,
  timezone,
}: {
  label: string;
  leads: BucketAdLead[];
  timezone: string;
}) {
  const numbers = leads
    .map((l) => l.phone)
    .filter((n): n is string => n != null);
  const day = (d: Date) => dayLabel(zonedDayString(d, timezone));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-disabled">
          {label} · from ads · {leads.length}{" "}
          {leads.length === 1 ? "guest" : "guests"}
        </p>
        {numbers.length > 1 && (
          <CopyButton
            text={numbers.join("\n")}
            label="Copy all numbers"
            className="rounded-md border border-line-strong bg-elevated px-2 py-1 text-xs font-medium text-ink-secondary hover:bg-line-strong"
          />
        )}
      </div>

      {leads.length === 0 ? (
        <p className="text-sm text-ink-tertiary">
          No guests to show for this count.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-card">
          {leads.map((l, i) => (
            <li
              key={i}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 py-2.5"
            >
              <div className="min-w-0">
                {l.phone ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="font-mono text-sm text-ink">
                      {l.phone}
                    </span>
                    <CopyButton
                      text={l.phone}
                      label="Copy"
                      className="rounded-md border border-line-strong bg-elevated px-2 py-0.5 text-xs font-medium text-ink-secondary hover:bg-line-strong"
                    />
                  </span>
                ) : (
                  <span className="font-mono text-xs text-ink-tertiary">
                    {l.phoneLast4
                      ? `⋯${l.phoneLast4}`
                      : "Number not received yet"}
                  </span>
                )}
                {/* Which ad brought them: where it ran, its headline, and the
                    ad's full id, which Ads Manager can search. */}
                <p className="mt-1 text-xs text-ink-secondary">
                  {l.placement ? `${l.placement} ad` : "Ad"}
                  {l.headline && (
                    <>
                      {" "}
                      · <span className="text-ink">{l.headline}</span>
                    </>
                  )}
                  {l.adId && (
                    <span className="font-mono text-ink-disabled">
                      {" "}
                      · ad {l.adId}
                    </span>
                  )}
                  {l.adUrl && (
                    <>
                      {" · "}
                      <a
                        href={l.adUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand underline underline-offset-2"
                      >
                        view ad ↗
                      </a>
                    </>
                  )}
                </p>
              </div>
              <p className="text-xs text-ink-tertiary">
                first messaged {day(l.firstMessageAt)}
                {l.booked && (
                  <span className="ml-2 font-medium text-success">booked</span>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
