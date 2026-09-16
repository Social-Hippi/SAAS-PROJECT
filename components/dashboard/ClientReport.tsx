import { presentMetric, type MetricFormat } from "@/lib/metrics/present";
import { isOk, type MetricValue } from "@/lib/metrics/metric-value";
import { CAPTION, type ClientReport as ClientReportData } from "@/lib/metrics/client-report";

// ─────────────────────────────────────────────────────────────────────────────
// The hotel's report. Nine figures, four groups, nothing else.
//
// WHY EVERY TILE CARRIES PROSE. The numbers here come from five different
// systems that count different things over different windows, and a bare grid
// of figures invites exactly the arithmetic that makes them lies — dividing
// spend by calls the ads never produced, reading a blank as a zero, adding room
// nights to bookings. So each tile states what its figure IS, and a tile with no
// figure states why. The caption is not decoration; it is the part that stops
// the number being misread.
//
// WHY A MISSING FIGURE IS LOUD. `presentMetric` renders an unknown smaller and
// quieter than a real value, which is right — an unknown is context, not a
// result — but it still occupies the tile, in words. A hotel that sees "Not
// traceable" asks its agency a question. A hotel that sees a card quietly
// missing, or a 0, does not.
// ─────────────────────────────────────────────────────────────────────────────

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
  /** What the figure is, and what it is not. Always rendered. */
  caption?: string;
  /**
   * Set when this figure's source stopped before the period ended.
   *
   * Styled as a warning rather than another grey caption, and placed directly
   * under the number instead of at the foot of the tile: it qualifies the figure
   * itself, and a reader who has taken the number and moved on has already
   * missed it.
   */
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
      {/* The REASON comes first and the caption second: a reader looking at a
          tile with no number wants to know why before being told what the
          number would have meant. */}
      {!isOk(value) && "reason" in value && (
        <p className="mt-2 text-sm leading-snug text-ink-tertiary">{value.reason}</p>
      )}
      {caption && (
        <p className="mt-2 text-sm leading-snug text-ink-tertiary">{caption}</p>
      )}
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
        className={`mt-3 grid gap-4 sm:grid-cols-2 ${
          columns === 3 ? "lg:grid-cols-3" : ""
        }`}
      >
        {children}
      </div>
    </section>
  );
}

export function ClientReport({
  data,
  showAdSpend,
}: {
  data: ClientReportData;
  /**
   * The hotel's showAdSpendToHotel flag. When false the ADVERTISING SPEND group
   * and the return-on-ad-spend tile are not rendered at all.
   *
   * The loader has ALREADY withheld those three values, so nothing leaks either
   * way — this second gate exists so the report reads as a report rather than as
   * three cards announcing that something is being kept from the reader.
   * Return on ad spend goes with them because it is revenue ÷ spend: published
   * beside a known revenue, it hands the spend back by division.
   */
  showAdSpend: boolean;
}) {
  return (
    <div className="space-y-8">
      <Group title="Results" columns={2}>
        {/* Revenue and bookings come from the snippet, which reports as events
            arrive — there is no nightly sync to fall behind, so no coverage
            note belongs on them. */}
        <Tile
          label="Total revenue"
          value={data.totalRevenue}
          format="currency"
          caption={CAPTION.totalRevenue}
        />
        {showAdSpend && (
          <Tile
            label="Return on ad spend"
            value={data.returnOnAdSpend}
            format="multiple"
            caption={CAPTION.returnOnAdSpend}
            staleNote={data.staleNote.returnOnAdSpend}
          />
        )}
      </Group>

      {showAdSpend && (
        <Group title="Advertising spend" columns={2}>
          <Tile
            label="Google Ads"
            value={data.googleSpend}
            format="currency"
            staleNote={data.staleNote.googleSpend}
          />
          <Tile
            label="Meta Ads"
            value={data.metaSpend}
            format="currency"
            staleNote={data.staleNote.metaSpend}
          />
        </Group>
      )}

      <Group title="Enquiries generated" columns={3}>
        <Tile
          label="Calls"
          value={data.calls}
          caption={CAPTION.calls}
          staleNote={data.staleNote.calls}
        />
        <Tile
          label="WhatsApp messages"
          value={data.whatsappMessages}
          caption={CAPTION.whatsappMessages}
          staleNote={data.staleNote.whatsappMessages}
        />
        {/* No caption and no coverage note: the tile can never hold a figure, so
            its `reason` already says everything there is to say. */}
        <Tile label="Instagram messages" value={data.instagramMessages} />
      </Group>

      <Group title="Bookings" columns={2}>
        <Tile
          label="Total bookings"
          value={data.totalBookings}
          caption={CAPTION.totalBookings}
        />
        <Tile
          label="Total room nights"
          value={data.totalRoomNights}
          caption={CAPTION.totalRoomNights}
          staleNote={data.staleNote.totalRoomNights}
        />
      </Group>
    </div>
  );
}
