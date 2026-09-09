import { presentMetric, type MetricFormat } from "@/lib/metrics/present";
import { isOk, type MetricValue } from "@/lib/metrics/metric-value";
import { formatNumber, formatPercent } from "@/lib/format";
import {
  DISPOSITION_GROUPS,
  DISPOSITION_GROUP_LABEL,
  DISPOSITION_GROUP_SOURCES,
} from "@/lib/ops-tracker/metrics";
import {
  BLENDED_COST_NOTE,
  CONVERSIONS_UNTYPED,
  type BlockA,
  type PlatformBlock,
  type SourceFreshness,
} from "@/lib/metrics/contact-report";

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER CONTACT — three blocks that must never be added together.
//
// The layout carries the argument. Each block has its own heading, its own
// provenance line and its own freshness stamp, and no total spans them, because
// a call recorded by the front desk may be the same customer as a Meta
// "conversation started" and nothing can tell us. Putting them in one table with
// a sum would double count by an unknown amount.
//
// Unavailable states are DESIGNED here, not broken. They appear often by
// intention — most of Block B is unavailable today — so they get the same care
// as the figures: quiet, legible, and carrying their reason in the open rather
// than only in a title attribute nobody hovers on a phone.
// ─────────────────────────────────────────────────────────────────────────────

function Figure({
  label,
  value,
  format = "number",
  hint,
}: {
  label: string;
  value: MetricValue<number>;
  format?: MetricFormat;
  hint?: string;
}) {
  const p = presentMetric(value, format);
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">{label}</p>
      <p
        className={`mt-0.5 tabular-nums ${p.known ? "text-xl font-semibold text-ink" : "text-sm font-medium text-ink-disabled"}`}
        title={p.title}
      >
        {p.text}
      </p>
      {/* The reason sits in the layout, not only in a tooltip — nobody hovers on
          a phone, and these states are common here by design. */}
      {!p.known && "reason" in value && (
        <p className="mt-0.5 text-[11px] leading-snug text-ink-tertiary">{value.reason}</p>
      )}
      {/* The hint shows whether or not the figure resolved. It carries the
          framing — "room nights, not bookings", "a yield figure, not a
          conversion rate" — and that framing matters MOST when the number is
          withheld, because a reader who cannot see the value will otherwise
          guess at what it would have meant. */}
      {hint && <p className="mt-0.5 text-[11px] leading-snug text-ink-tertiary">{hint}</p>}
    </div>
  );
}

function Freshness({ f }: { f: SourceFreshness }) {
  return (
    <div className="mt-2 space-y-1">
      <p className="text-[11px] text-ink-tertiary">
        {f.label} ·{" "}
        {f.lastUpdatedAt
          ? `last updated ${f.lastUpdatedAt.toISOString().slice(0, 10)}`
          : "never received"}
      </p>
      {f.staleNote && <p className="text-[11px] font-medium text-warning">{f.staleNote}</p>}
      {!f.health.trustworthy && !f.staleNote && (
        <p className="text-[11px] text-warning">{f.health.message}</p>
      )}
    </div>
  );
}

function Block({
  letter,
  title,
  provenance,
  children,
  freshness,
}: {
  letter: string;
  title: string;
  provenance: string;
  children: React.ReactNode;
  freshness: SourceFreshness;
}) {
  return (
    <section className="overflow-hidden rounded-card border border-line bg-card shadow-card">
      <div className="border-b border-line px-4 py-3 sm:px-5">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-ink-disabled">
            {letter}
          </span>
          <h3 className="font-medium text-ink">{title}</h3>
        </div>
        <p className="mt-1 text-sm text-ink-tertiary">{provenance}</p>
        <Freshness f={freshness} />
      </div>
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

export function ContactReport({
  blockA,
  platforms,
  measured,
  blendedCostPerContact,
  costPerQualifiedContact,
  periodLabel,
}: {
  blockA: BlockA;
  platforms: PlatformBlock[];
  /** Block C — what HotelTrack measured itself. */
  measured: {
    visits: MetricValue<number>;
    sessions: MetricValue<number>;
    websiteConversions: MetricValue<number>;
    attributed: MetricValue<number>;
    unattributed: MetricValue<number>;
    freshness: SourceFreshness;
  };
  blendedCostPerContact: MetricValue<number>;
  costPerQualifiedContact: MetricValue<number>;
  periodLabel: string;
}) {
  const a = blockA.summary;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">Customer contact</h2>
        <p className="mt-0.5 text-sm text-ink-tertiary">
          {periodLabel}. Three separate records of the same period. They measure different
          things and are deliberately not added together — doing so would count the same
          customer twice, by an amount nobody can determine.
        </p>
      </div>

      {/* ── A ──────────────────────────────────────────────────────────── */}
      <Block
        letter="A"
        title={`What actually happened${blockA.segmentName ? ` · ${blockA.segmentName}` : ""}`}
        provenance="Recorded by the property's own team in its operations tracker. Not measured by HotelTrack, and NOT attributable to any marketing channel — the tracker has no source or campaign column."
        freshness={blockA.freshness}
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Figure label="Calls received" value={a.totalCallsReceived} />
          <Figure label="Genuine enquiries" value={a.enquiries} />
          <Figure label="WhatsApp leads" value={a.whatsappLeads} />
          <Figure
            label="Room nights confirmed"
            value={a.roomNightsConfirmed}
            hint="Room nights, not bookings"
          />
          <Figure label="WhatsApp bookings" value={a.whatsappConfirmed} />
        </div>

        <div className="mt-4 border-t border-line pt-4">
          <Figure
            label="Room nights per recorded contact"
            value={a.roomNightsPerContact}
            format="multiple"
            hint="A yield figure, not a conversion rate — one booking can be several nights, so it can exceed 1."
          />
        </div>

        {/* Dispositions are secondary detail, not headline figures. */}
        <div className="mt-4 border-t border-line pt-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">
            Where the contacts went
          </p>
          <ul className="mt-2 space-y-1.5">
            {DISPOSITION_GROUPS.map((g) => {
              const total = a.dispositionGroups[g];
              const share = a.dispositionShare[g];
              return (
                <li key={g} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span className="text-ink-secondary" title={DISPOSITION_GROUP_SOURCES[g]}>
                    {DISPOSITION_GROUP_LABEL[g]}
                  </span>
                  <span className="tabular-nums text-ink-tertiary">
                    {isOk(total) ? formatNumber(total.value) : "—"}
                    {isOk(share) && (
                      <span className="text-ink-disabled"> · {formatPercent(share.value)}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>

          {/* 9.1's headline claim, stated only when the threshold is met. */}
          {isOk(a.dispositionShare.lost_to_availability_or_rate) &&
            a.dispositionShare.lost_to_availability_or_rate.value > 0.15 && (
              <p className="mt-3 rounded-lg border border-line bg-elevated/50 px-3 py-2 text-sm text-ink-secondary">
                {formatPercent(a.dispositionShare.lost_to_availability_or_rate.value)} of recorded
                contacts were lost to sold-out dates, rate or room size. That is demand the
                marketing produced and the property could not serve — an inventory, rate and
                availability signal, not a marketing failure.
              </p>
            )}
        </div>

        {a.daysMissing > 0 && (
          <p className="mt-4 rounded-lg border border-line bg-elevated/50 px-3 py-2 text-xs text-ink-tertiary">
            Operations data complete through{" "}
            <span className="font-medium text-ink-secondary">{a.completeThrough ?? "—"}</span>.{" "}
            {a.daysMissing} day{a.daysMissing === 1 ? "" : "s"} in this period have no tracker row
            at all. Those days are unrecorded, not zero, and are excluded from every total above.
          </p>
        )}

        {blockA.propertiesMissingData.length > 0 && (
          <p className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-ink-secondary">
            No tracker data for {blockA.propertiesMissingData.join(" or ")} in this period, so the
            figures above describe the other propert
            {blockA.propertiesMissingData.length === 1 ? "y" : "ies"} only.
          </p>
        )}

        {blockA.unmappedTabs.length > 0 && (
          <p className="mt-2 text-xs text-warning">
            {blockA.unmappedTabs.length} tracker tab
            {blockA.unmappedTabs.length === 1 ? " is" : "s are"} not mapped to a property, so
            {blockA.unmappedTabs.length === 1 ? " its" : " their"} rows are stored but not shown
            here.
          </p>
        )}

        {a.hasSevereVariance && (
          <p className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-ink-secondary">
            Some of the tracker&apos;s own columns contradict each other in this period — the
            disposition counts and the calls-received total do not reconcile. Figures that depend
            on both are withheld rather than computed from a number that cannot be right.
          </p>
        )}
      </Block>

      {/* ── B ──────────────────────────────────────────────────────────── */}
      {platforms.map((p) => (
        <Block
          key={p.platform}
          letter="B"
          title={`What ${p.label} reports`}
          provenance={`${p.label}'s own figures, in ${p.label}'s own daily buckets and attribution window. Not measured by HotelTrack and not comparable with block A.`}
          freshness={p.freshness}
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Figure label="Impressions" value={p.impressions} />
            <Figure label="Clicks" value={p.clicks} />
            <Figure label="Spend" value={p.spend} format="currency" />
            <Figure
              label="Platform-reported conversions"
              value={p.conversions}
              hint="Action type not recorded"
            />
            <Figure
              label={p.platform === "meta" ? "Messaging conversations" : "Call conversions"}
              value={p.platform === "meta" ? p.messagingConversations : p.callConversions}
            />
          </div>
          {isOk(p.conversions) && (
            <p className="mt-3 text-xs text-ink-tertiary">{CONVERSIONS_UNTYPED}</p>
          )}
        </Block>
      ))}

      {/* ── C ──────────────────────────────────────────────────────────── */}
      <Block
        letter="C"
        title="What HotelTrack measured directly"
        provenance="Recorded by the tracking snippet on the property's own website. Anything without positive evidence of a channel is Unattributed — never forced into one."
        freshness={measured.freshness}
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Figure label="Visits" value={measured.visits} />
          <Figure label="Sessions" value={measured.sessions} />
          <Figure label="Website conversions" value={measured.websiteConversions} />
          <Figure label="Attributed" value={measured.attributed} />
          <Figure label="Unattributed" value={measured.unattributed} />
        </div>
      </Block>

      {/* ── The one permitted bridge ───────────────────────────────────── */}
      <section className="rounded-card border border-line bg-card p-4 shadow-card sm:p-5">
        <h3 className="font-medium text-ink">Cost per contact</h3>
        <p className="mt-1 text-sm text-ink-tertiary">{BLENDED_COST_NOTE}</p>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Figure
            label="Blended cost per recorded contact"
            value={blendedCostPerContact}
            format="currency"
          />
          <Figure
            label="Blended cost per qualified contact"
            value={costPerQualifiedContact}
            format="currency"
            hint="Qualified = enquiries + WhatsApp leads"
          />
        </div>
        <p className="mt-3 text-xs text-ink-tertiary">
          Both sides are period totals, so no attribution is claimed or implied. This is not a
          return on ad spend and cannot be turned into one.
        </p>
      </section>
    </div>
  );
}
