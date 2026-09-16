import { formatNumber } from "@/lib/format";
import type { WhatsAppAttributionReport } from "@/lib/metrics/whatsapp-attribution-report";

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp enquiries and the ads behind them.
//
// This is the one place on the report that connects an ad to a booking a guest
// made by phone — a booking the website never saw and could never have claimed.
//
// THREE NUMBERS, NOT ONE. Enquiries, bookings, and how many of those bookings
// can be traced to an ad. Showing only the traced figure would read as "your ads
// produced one booking"; showing only the total would imply the marketing earned
// all of them. The gap between them is the honest subject of this panel.
//
// THE START DATE IS PART OF THE DATA. Attribution begins when the property adds
// the referral attributes in Kraya, and every enquiry before that carries no ad —
// which is indistinguishable from "the ads produced nothing" unless the panel
// says which. A report read weeks later has no other way to know.
// ─────────────────────────────────────────────────────────────────────────────

export function WhatsAppAttribution({
  data,
  periodLabel,
  timezone,
}: {
  data: WhatsAppAttributionReport;
  periodLabel: string;
  timezone: string;
}) {
  // No connection is not "nothing happened" — the panel would otherwise report a
  // confident zero for a hotel whose WhatsApp simply is not linked.
  if (data.notConnected) return null;

  const dayIn = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: timezone,
    }).format(d);

  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-widest text-ink-disabled">
        WhatsApp
      </h2>

      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        <Figure
          label="Enquiries"
          value={data.enquiries}
          caption={`People who messaged the property on WhatsApp in ${periodLabel}.`}
        />
        <Figure
          label="Bookings"
          value={data.bookings}
          caption="Enquiries the reservations team confirmed as bookings. Taken by phone or message — never through the website."
        />
        <Figure
          label="Traced to an ad"
          value={data.bookingsFromAds}
          caption="Bookings whose conversation began when someone tapped one of your ads. The rest arrived another way, or before tracking began."
        />
      </div>

      {data.attributionSince && (
        <p className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-snug text-ink-secondary">
          Ad tracking on WhatsApp began {dayIn(data.attributionSince)}. Enquiries
          before that date carry no ad, so they cannot be traced — that is a gap in
          the record, not a sign the ads produced nothing.
        </p>
      )}

      {data.ads.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-card border border-line bg-card shadow-card">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b border-line bg-elevated">
                <Th>Ad</Th>
                <Th align="right">Enquiries</Th>
                <Th align="right">Bookings</Th>
              </tr>
            </thead>
            <tbody>
              {data.ads.map((ad) => (
                <tr key={ad.adId} className="border-b border-line last:border-b-0">
                  {/* Meta's own id. The property recognises it from Ads Manager,
                      and no friendlier name exists that is guaranteed correct —
                      an ad renamed mid-campaign would make one up. */}
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-secondary">
                    {ad.adId}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-ink">
                    {formatNumber(ad.enquiries)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-medium text-ink">
                    {formatNumber(ad.bookings)}
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

function Figure({
  label,
  value,
  caption,
}: {
  label: string;
  value: number;
  caption: string;
}) {
  return (
    <div className="rounded-card border border-line bg-card p-5 shadow-card">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
        {label}
      </p>
      {/* A real, measured zero. These come from the property's own record of its
          conversations, so none of them is a measurement gap dressed as a count. */}
      <p className="mt-2 text-4xl font-semibold tracking-tight tabular-nums text-ink">
        {formatNumber(value)}
      </p>
      <p className="mt-2 text-sm leading-snug text-ink-tertiary">{caption}</p>
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`px-4 py-2 text-${align} text-[11px] font-medium uppercase tracking-wide text-ink-tertiary`}
    >
      {children}
    </th>
  );
}
