import { formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import type {
  MetaCampaignBreakdownRow,
  MetaPropertyBreakdown,
  MetaPropertyGroup,
  PropertyRecorded,
} from "@/lib/metrics/meta-property-breakdown";

// ─────────────────────────────────────────────────────────────────────────────
// META ADS BY PROPERTY.
//
// One box per property — its campaigns, then its totals — then the next
// property. After the boxes, a detail table per property, then messages per day
// for both properties on one chart.
//
// EVERY FIGURE HERE IS EITHER MEASURED OR ABSENT. A dash means Meta did not
// report it, never that the value was zero: rankings are withheld below a volume
// threshold, reach is unknown for days synced before it was captured, and spend
// is hidden entirely when the hotel's ad-spend setting says so.
// ─────────────────────────────────────────────────────────────────────────────

const dash = "—";

/** A number, or a dash. Never 0 standing in for "not reported". */
const num = (v: number | null | undefined): string => (v == null ? dash : formatNumber(v));
const money = (v: number | null | undefined): string => (v == null ? dash : formatCurrency(v));
const pct = (v: number | null | undefined): string => (v == null ? dash : formatPercent(v));

function Cell({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return (
    <td className={`whitespace-nowrap px-3 py-2 text-sm ${right ? "text-right tabular-nums" : ""}`}>
      {children}
    </td>
  );
}

function Head({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`whitespace-nowrap px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary ${
        right ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

/** The per-campaign box: objective, clicks, messages, cost per contact, spend. */
function CampaignRows({ rows, spendVisible }: { rows: MetaCampaignBreakdownRow[]; spendVisible: boolean }) {
  if (rows.length === 0) {
    return (
      <p className="px-3 py-4 text-sm text-ink-tertiary">
        No campaigns ran for this property in this period.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[46rem] border-collapse">
        <thead className="border-b border-line">
          <tr>
            <Head>Campaign</Head>
            <Head>Objective</Head>
            <Head right>Clicks</Head>
            <Head right>Messages</Head>
            <Head right>Calls</Head>
            <Head right>Leads</Head>
            {spendVisible && <Head right>Cost / contact</Head>}
            {spendVisible && <Head right>Spent</Head>}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.campaignId}>
              <Cell>
                <span className="text-ink">{r.campaignName}</span>
              </Cell>
              <Cell>
                {r.objectiveLabel ? (
                  <span className="rounded-md bg-elevated px-2 py-0.5 text-xs text-ink-secondary">
                    {r.objectiveLabel}
                  </span>
                ) : (
                  <span className="text-xs text-ink-disabled">Not available</span>
                )}
              </Cell>
              <Cell right>{num(r.clicks)}</Cell>
              <Cell right>{num(r.messages)}</Cell>
              <Cell right>{num(r.calls)}</Cell>
              <Cell right>{num(r.leads)}</Cell>
              {spendVisible && <Cell right>{money(r.costPerContact)}</Cell>}
              {spendVisible && <Cell right>{money(r.spend)}</Cell>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Tile = { label: string; value: string; note?: string };

function TotalsStrip({
  totals,
  recorded,
  spendVisible,
}: {
  totals: MetaPropertyGroup["totals"];
  recorded: PropertyRecorded | null;
  spendVisible: boolean;
}) {
  const items: Tile[] = [
    { label: "Campaigns", value: String(totals.campaigns) },
    { label: "Clicks", value: num(totals.clicks) },
    { label: "Messages", value: num(totals.messages) },
    { label: "Calls", value: num(totals.calls) },
    { label: "Leads", value: num(totals.leads) },
    { label: "Contacts", value: num(totals.contacts) },
  ];
  if (spendVisible) {
    items.push({ label: "Cost / contact", value: money(totals.costPerContact) });
    items.push({ label: "Total spent", value: money(totals.spend) });
  }

  // WhatsApp confirmed comes from the property's OWN operations sheet, which
  // records the outcome but not which campaign produced it. It sits in the same
  // strip for legibility, so the note is what stops it reading as a campaign
  // result — the whole strip above it is one. Two facts, kept to one line:
  // where the number came from, and how much of the period it covers.
  if (recorded && recorded.whatsappConfirmed != null) {
    const partial = recorded.daysRecorded < recorded.daysInPeriod;
    items.push({
      label: "WhatsApp confirmed",
      value: num(recorded.whatsappConfirmed),
      note: partial
        ? `property-recorded · ${recorded.daysRecorded} of ${recorded.daysInPeriod} days`
        : "property-recorded",
    });
  }

  // auto-fit rather than a fixed column count: the tile count changes with the
  // spend gate and with whether a property keeps a sheet, and a fixed grid
  // leaves a dead cell whenever it does.
  return (
    <div className="grid grid-cols-2 gap-px border-t border-line bg-line [grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr))]">
      {items.map((t) => (
        <div key={t.label} className="bg-card px-3 py-2.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-ink-tertiary">{t.label}</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-ink">{t.value}</p>
          {t.note && <p className="mt-0.5 text-[10px] text-ink-disabled">{t.note}</p>}
        </div>
      ))}
    </div>
  );
}

/** The detail table: reach, impressions, CTR, messages, contact rate, ranking, bookings. */
function DetailTable({ group, rankingsUnavailable }: { group: MetaPropertyGroup; rankingsUnavailable: boolean }) {
  if (group.campaigns.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-collapse">
        <thead className="border-b border-line">
          <tr>
            <Head>Campaign</Head>
            <Head right>Reach</Head>
            <Head right>Impressions</Head>
            <Head right>CTR</Head>
            <Head right>Messages</Head>
            <Head right>Contact rate</Head>
            <Head right>Ranking</Head>
            <Head right>Bookings</Head>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {group.campaigns.map((r) => (
            <tr key={r.campaignId}>
              <Cell>{r.campaignName}</Cell>
              <Cell right>{num(r.reach)}</Cell>
              <Cell right>{num(r.impressions)}</Cell>
              <Cell right>{pct(r.ctr)}</Cell>
              <Cell right>{num(r.messages)}</Cell>
              <Cell right>{pct(r.contactRate)}</Cell>
              <Cell right>
                {r.ranking ? (
                  <span className="text-ink-secondary">{r.ranking.replaceAll("_", " ").toLowerCase()}</span>
                ) : (
                  <span className="text-ink-disabled">{dash}</span>
                )}
              </Cell>
              <Cell right>{num(r.bookings)}</Cell>
            </tr>
          ))}
          <tr className="bg-elevated font-medium">
            <Cell>Total</Cell>
            <Cell right>{num(group.totals.reach)}</Cell>
            <Cell right>{num(group.totals.impressions)}</Cell>
            <Cell right>{pct(group.totals.ctr)}</Cell>
            <Cell right>{num(group.totals.messages)}</Cell>
            <Cell right>{dash}</Cell>
            <Cell right>{dash}</Cell>
            <Cell right>{num(group.totals.bookings)}</Cell>
          </tr>
        </tbody>
      </table>
      {rankingsUnavailable && (
        <p className="px-3 py-2 text-xs text-ink-tertiary">
          Meta withholds delivery rankings until a campaign has enough impressions to be
          ranked. A dash is the absence of a grade, not a bad one.
        </p>
      )}
    </div>
  );
}

/**
 * Messages per day, one line per property.
 *
 * Plotted on a SHARED vertical scale, so the two lines are comparable by eye —
 * separate scales would make a property with a tenth of the volume look level
 * with one carrying it.
 */
function MessagesChart({
  daily,
  groups,
}: {
  daily: MetaPropertyBreakdown["daily"];
  groups: MetaPropertyGroup[];
}) {
  const plotted = groups.filter((g) => g.totals.messages > 0);
  if (daily.length < 2 || plotted.length === 0) return null;

  const W = 720;
  const H = 180;
  const PAD = 6;
  const max = Math.max(
    1,
    ...daily.flatMap((d) => plotted.map((g) => d.byProperty[g.segmentKey] ?? 0)),
  );
  const x = (i: number) => PAD + (i / Math.max(1, daily.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);

  const COLORS = ["stroke-brand", "stroke-success", "stroke-warning", "stroke-info"];

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-secondary">
        {plotted.map((g, i) => (
          <span key={g.segmentKey} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={`inline-block h-0.5 w-4 ${COLORS[i % COLORS.length]!.replace("stroke-", "bg-")}`}
            />
            {g.propertyName}
          </span>
        ))}
        <span className="text-ink-tertiary">peak {formatNumber(max)}/day</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-44 w-full"
        role="img"
        aria-label="Messages generated per day, by property"
      >
        {plotted.map((g, i) => (
          <path
            key={g.segmentKey}
            d={daily
              .map((d, idx) => `${idx === 0 ? "M" : "L"} ${x(idx)} ${y(d.byProperty[g.segmentKey] ?? 0)}`)
              .join(" ")}
            className={`fill-none ${COLORS[i % COLORS.length]}`}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-ink-tertiary">
        <span>{daily[0]!.date}</span>
        <span>{daily[daily.length - 1]!.date}</span>
      </div>
    </div>
  );
}

export function MetaPropertyBreakdown({ data }: { data: MetaPropertyBreakdown }) {
  if (data.groups.length === 0) return null;

  return (
    <div className="space-y-6">
      {data.groups.map((g) => (
        <section key={g.segmentKey} className="rounded-xl border border-line bg-card shadow-card">
          <div className="border-b border-line px-4 py-3">
            <h3 className="text-sm font-semibold text-ink">{g.propertyName}</h3>
            <p className="mt-0.5 text-xs text-ink-tertiary">
              {g.campaigns.length === 0
                ? "No campaigns in this period."
                : `${g.campaigns.length} campaign${g.campaigns.length === 1 ? "" : "s"} in this period.`}
            </p>
          </div>
          <CampaignRows rows={g.campaigns} spendVisible={data.spendVisible} />
          <TotalsStrip totals={g.totals} recorded={g.recorded} spendVisible={data.spendVisible} />
        </section>
      ))}

      <section className="rounded-xl border border-line bg-card shadow-card">
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">Campaign detail by property</h3>
          <p className="mt-0.5 text-xs text-ink-tertiary">
            Delivery and outcome for every campaign. Contact rate is contacts ÷ clicks.
          </p>
        </div>
        <div className="divide-y divide-line">
          {data.groups
            .filter((g) => g.campaigns.length > 0)
            .map((g) => (
              <div key={g.segmentKey} className="py-2">
                <p className="px-3 py-1 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                  {g.propertyName}
                </p>
                <DetailTable group={g} rankingsUnavailable={data.rankingsUnavailable} />
              </div>
            ))}
        </div>
        <p className="border-t border-line px-4 py-2.5 text-xs text-ink-tertiary">
          Messages, calls and leads are different events and are shown separately.
          &ldquo;Contacts&rdquo; adds them, so somebody who both messaged and submitted a
          form is counted in both — it is an upper bound, not a headcount.
        </p>
      </section>

      {data.daily.length > 1 && (
        <section className="rounded-xl border border-line bg-card p-4 shadow-card">
          <h3 className="text-sm font-semibold text-ink">Messages generated per day</h3>
          <p className="mb-3 mt-0.5 text-xs text-ink-tertiary">
            Both properties on one scale, so the lines are comparable.
          </p>
          <MessagesChart daily={data.daily} groups={data.groups} />
        </section>
      )}
    </div>
  );
}
