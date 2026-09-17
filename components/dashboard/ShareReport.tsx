import Link from "next/link";

import { presentMetric, type MetricFormat } from "@/lib/metrics/present";
import { isOk, type MetricValue } from "@/lib/metrics/metric-value";
import {
  ADS_CAPTION,
  CLIENT_CAPTION,
  type ShareViews,
} from "@/lib/metrics/share-views";

// ─────────────────────────────────────────────────────────────────────────────
// The hotel's report, in two views that are never mixed.
//
// One report used to show platform figures beside the property's own record, and
// the two invite an arithmetic nobody can defend: ad spend next to calls the
// property logged reads as a cost per call, and it is not one — nothing records
// which channel produced those calls.
//
// So the switch is not a convenience. It is the thing that stops the two being
// divided by one another, and the copy on each view is written to keep them
// apart: the ads view says "from your ads" on every tile, the client view says
// "recorded by the property" and carries no ratio at all.
// ─────────────────────────────────────────────────────────────────────────────

export type ShareView = "ads" | "client";

export function ShareReport({
  data,
  view,
  basePath,
  showAdSpend,
  timezone,
  preserve = {},
}: {
  data: ShareViews;
  view: ShareView;
  basePath: string;
  showAdSpend: boolean;
  timezone: string;
  preserve?: Record<string, string | undefined>;
}) {
  return (
    <div className="space-y-6">
      <ViewSwitch view={view} basePath={basePath} preserve={preserve} />
      {view === "ads" ? (
        <AdsView data={data} showAdSpend={showAdSpend} timezone={timezone} />
      ) : (
        <ClientDataView data={data} />
      )}
    </div>
  );
}

function ViewSwitch({
  view,
  basePath,
  preserve,
}: {
  view: ShareView;
  basePath: string;
  preserve: Record<string, string | undefined>;
}) {
  const href = (v: ShareView) => {
    const p = new URLSearchParams();
    // The period and property must survive the switch, or changing view silently
    // resets the window the reader was looking at.
    for (const [k, val] of Object.entries(preserve)) if (val) p.set(k, val);
    if (v !== "ads") p.set("view", v);
    const qs = p.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  const tab = (active: boolean) =>
    `rounded-lg border px-3 py-1.5 text-sm font-medium ${
      active
        ? "border-brand bg-brand text-white"
        : "border-line-strong bg-elevated text-ink-secondary hover:bg-line-strong"
    }`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-xs font-semibold uppercase tracking-widest text-ink-disabled">
        Showing
      </span>
      <Link href={href("ads")} className={tab(view === "ads")} prefetch={false}>
        From your ads
      </Link>
      <Link href={href("client")} className={tab(view === "client")} prefetch={false}>
        Your own records
      </Link>
    </div>
  );
}

function AdsView({
  data,
  showAdSpend,
  timezone,
}: {
  data: ShareViews;
  showAdSpend: boolean;
  timezone: string;
}) {
  const n = data.staleNote;
  const since = data.whatsappAttributionSince;

  return (
    <div className="space-y-8">
      <p className="max-w-[70ch] text-sm text-ink-tertiary">
        Everything on this view is what your advertising produced. Enquiries and
        bookings that arrived another way are under{" "}
        <span className="font-medium text-ink-secondary">Your own records</span>.
      </p>

      {/* Two revenue lines before the ratio that divides their sum, in the order
          the reader has to add them: website, then WhatsApp, then the result.
          They are separate tiles because they are known in different ways — the
          first is traced, the second is typed in by the agency — and one merged
          "revenue" figure would hide which half is measured. */}
      <Group title="Results" columns={showAdSpend ? 3 : 2}>
        <Tile
          label="Revenue from ads / website"
          value={data.ads.totalRevenue}
          format="currency"
          caption={ADS_CAPTION.totalRevenue}
          staleNote={n.totalRevenue}
        />
        <Tile
          label="Revenue from WhatsApp ad bookings"
          value={data.ads.whatsappAdRevenue}
          format="currency"
          caption={ADS_CAPTION.whatsappAdRevenue}
          staleNote={n.whatsappAdRevenue}
        />
        {showAdSpend && (
          <Tile
            label="Return on ad spend"
            value={data.ads.returnOnAdSpend}
            format="multiple"
            caption={ADS_CAPTION.returnOnAdSpend}
            staleNote={n.returnOnAdSpend}
          />
        )}
      </Group>

      {showAdSpend && (
        <Group title="Advertising spend" columns={2}>
          <Tile
            label="Google Ads"
            value={data.ads.googleSpend}
            format="currency"
            caption={ADS_CAPTION.googleSpend}
            staleNote={n.googleSpend}
          />
          <Tile
            label="Meta Ads"
            value={data.ads.metaSpend}
            format="currency"
            caption={ADS_CAPTION.metaSpend}
            staleNote={n.metaSpend}
          />
        </Group>
      )}

      {/* Google and Meta calls are kept apart rather than summed: they are
          counted by different platforms on different definitions, and one total
          would hide which channel produced them. */}
      <Group title="Calls from ads" columns={2}>
        <Tile
          label="Google Ads"
          value={data.ads.googleCalls}
          caption={ADS_CAPTION.googleCalls}
        />
        <Tile
          label="Meta Ads"
          value={data.ads.metaCalls}
          caption={ADS_CAPTION.metaCalls}
          staleNote={n.metaCalls}
        />
      </Group>

      <Group title="Messages and enquiries from ads" columns={3}>
        <Tile
          label="Messages generated"
          value={data.ads.messagesGenerated}
          caption={ADS_CAPTION.messagesGenerated}
          staleNote={n.messagesGenerated}
        />
        <Tile
          label="Enquiries from ads"
          value={data.ads.enquiriesFromAds}
          caption={ADS_CAPTION.enquiriesFromAds}
        />
        <Tile
          label="WhatsApp bookings"
          value={data.ads.whatsappBookings}
          caption={ADS_CAPTION.whatsappBookings}
        />
      </Group>

      {since && (
        /* "The ads produced nothing" and "we were not recording which ad yet"
           look identical in a total, and a report read weeks later has no other
           way to tell them apart. */
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-snug text-ink-secondary">
          Tracking which ad produced a WhatsApp enquiry began{" "}
          {new Intl.DateTimeFormat("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
            timeZone: timezone,
          }).format(since)}
          . Enquiries before that date carry no ad, so they cannot be traced — a
          gap in the record, not a sign the ads produced nothing.
        </p>
      )}
    </div>
  );
}

function ClientDataView({ data }: { data: ShareViews }) {
  const n = data.staleNote;
  return (
    <div className="space-y-8">
      <p className="max-w-[70ch] text-sm text-ink-tertiary">
        Everything on this view is recorded by the property&apos;s own team. None
        of it can be credited to advertising — nothing in these records says which
        channel produced a call or a message, so these figures are deliberately
        never divided by ad spend.
      </p>

      <Group title="Your own records" columns={2}>
        <Tile
          label="WhatsApp messages"
          value={data.client.whatsappMessages}
          caption={CLIENT_CAPTION.whatsappMessages}
          staleNote={n.clientWhatsappMessages}
        />
        <Tile
          label="Calls"
          value={data.client.calls}
          caption={CLIENT_CAPTION.calls}
          staleNote={n.clientCalls}
        />
        <Tile
          label="Total room nights"
          value={data.client.totalRoomNights}
          caption={CLIENT_CAPTION.totalRoomNights}
          staleNote={n.clientTotalRoomNights}
        />
        <Tile
          label="Total revenue"
          value={data.client.totalRevenue}
          format="currency"
          caption={CLIENT_CAPTION.totalRevenue}
        />
      </Group>
    </div>
  );
}

function Group({
  title,
  columns,
  children,
}: {
  title: string;
  columns: 2 | 3;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-widest text-ink-disabled">
        {title}
      </h2>
      <div
        className={`mt-3 grid gap-4 sm:grid-cols-2 ${columns === 3 ? "lg:grid-cols-3" : ""}`}
      >
        {children}
      </div>
    </section>
  );
}

function Tile({
  label,
  value,
  format = "number",
  caption,
  staleNote,
}: {
  label: string;
  value: MetricValue<number>;
  format?: MetricFormat;
  caption?: string;
  staleNote?: string;
}) {
  const p = presentMetric(value, format);
  return (
    <div className="rounded-card border border-line bg-card p-5 shadow-card">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
        {label}
      </p>
      <p
        className={`mt-2 tabular-nums ${
          p.known
            ? "text-4xl font-semibold tracking-tight text-ink"
            : "text-2xl font-medium text-ink-tertiary"
        }`}
        title={p.title}
      >
        {p.text}
      </p>
      {staleNote && (
        <p className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs leading-snug text-ink-secondary">
          {staleNote}
        </p>
      )}
      {/* The reason first: a reader looking at a tile with no number wants to
          know why before being told what the number would have meant. */}
      {!isOk(value) && "reason" in value && (
        <p className="mt-2 text-sm leading-snug text-ink-tertiary">{value.reason}</p>
      )}
      {caption && <p className="mt-2 text-sm leading-snug text-ink-tertiary">{caption}</p>}
    </div>
  );
}
