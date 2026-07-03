import "server-only";

import { renderTemplate, type Pattern } from "@/lib/summary-templates";
import { formatCurrency } from "@/lib/format";

// Range-aware performance narrative for the PDF report. Reuses the SAME pattern
// classification (no_data / strong / flat_or_slight_decline / significant_decline)
// and the SAME {placeholder} / {ifFlag:'…'} template engine as the dashboard's
// Owner Summary Card (lib/owner-summary.ts + lib/summary-templates.ts). The only
// difference is the lead-in wording, which references the report's arbitrary date
// range ("Over {rangeLabel}") instead of a fixed 1d/7d/30d preset. Every value is
// derived from real data by the caller — nothing is fabricated here.

const fmt = (n: number) => formatCurrency(n, { compact: true });

function pct(cur: number, prev: number): number | null {
  if (prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}

export type NarrativeInput = {
  hotelName: string;
  rangeLabel: string;
  revenue: number;
  bookings: number;
  prevRevenue: number;
  prevBookings: number;
  hasPrevious: boolean;
  adSpend: number;
  roas: number | null;
  savings: number;
  visitsChangePct: number | null;
  topSource: { name: string; revenue: number; bookings: number } | null;
  topInfluencer: { name: string; revenue: number } | null;
  biggestFunnelDrop: { fromLabel: string; toLabel: string; pct: number } | null;
};

export type Narrative = { pattern: Pattern; keyPoints: string[]; prose: string };

// Range-aware bodies mirroring the owner-summary 30d templates (same flags/values).
const REPORT_TEMPLATES: Record<Exclude<Pattern, "no_data">, string> = {
  strong:
    "Over {rangeLabel}, {hotelName} brought {revenue} across {bookings} bookings{ifComparison: ', up {revenueChangePct}% versus the previous period'}. {topSource} led at {topSourceRevenue} from {topSourceBookings} bookings.{ifAdSpend: ' Paid ads returned {roas} ROAS on {adSpend} spend.'}{ifSavings: ' Direct bookings saved approximately {savings} in OTA commissions.'}{ifInfluencerActive: ' {influencerName} contributed {influencerRevenue}.'} It was a strong period — keep doing what is working.",
  flat_or_slight_decline:
    "Over {rangeLabel}, {hotelName} brought {revenue} across {bookings} bookings, slightly below the previous period's {previousRevenue}.{ifAvgValueShown: ''}{ifAdSpend: ' Paid ads returned {roas} ROAS on {adSpend} spend.'}{ifSavings: ' Direct bookings still saved about {savings} in OTA commissions.'} The priority for the next period is driving more qualified traffic to the site.",
  significant_decline:
    "Over {rangeLabel}, {hotelName} recorded {bookings} bookings worth {revenue}, well below the previous period's {previousRevenue}.{ifTrafficSteady: ' Website traffic held up, which suggests demand exists but on-site conversions slipped.'}{ifTopSourceStillStrong: ' {topSource} continued to perform with {topSourceRevenue}.'} It is worth reviewing what changed — ad performance, seasonality, or the booking flow.",
};

const NO_DATA =
  "No bookings were tracked over {rangeLabel}. This usually means the HotelTrack snippet isn't installed on every page yet, or visitors aren't completing bookings on the site. Once tracked bookings start flowing, this summary fills in automatically with what happened and why.";

export function buildReportNarrative(m: NarrativeInput): Narrative {
  const revenueChangePct = pct(m.revenue, m.prevRevenue);
  const avgBookingValue = m.bookings > 0 ? m.revenue / m.bookings : 0;
  const prevAvg = m.prevBookings > 0 ? m.prevRevenue / m.prevBookings : 0;
  const avgValueChangePct = prevAvg > 0 ? pct(avgBookingValue, prevAvg) : null;

  // Pattern — identical logic to lib/owner-summary.ts.
  let pattern: Pattern;
  if (m.bookings === 0) pattern = "no_data";
  else if (!m.hasPrevious || revenueChangePct == null) pattern = "strong";
  else if (revenueChangePct > 0) pattern = "strong";
  else if (revenueChangePct > -20) pattern = "flat_or_slight_decline";
  else pattern = "significant_decline";

  const avgUp = (avgValueChangePct ?? 0) > 0;
  const values: Record<string, string | number> = {
    hotelName: m.hotelName,
    rangeLabel: m.rangeLabel,
    revenue: fmt(m.revenue),
    bookings: m.bookings,
    previousRevenue: fmt(m.prevRevenue),
    revenueChangePct: revenueChangePct == null ? "" : Math.round(Math.abs(revenueChangePct)),
    topSource: m.topSource?.name ?? "Direct",
    topSourceRevenue: fmt(m.topSource?.revenue ?? 0),
    topSourceBookings: m.topSource?.bookings ?? 0,
    roas: m.roas == null ? "" : `${m.roas.toFixed(1)}x`,
    adSpend: fmt(m.adSpend),
    savings: fmt(m.savings),
    avgValueChangeDirection: avgUp ? "up" : "down",
    avgValueChangePctAbs: avgValueChangePct == null ? "" : Math.round(Math.abs(avgValueChangePct)),
    moreOrLess: avgUp ? "more" : "less",
    influencerName: m.topInfluencer?.name ?? "",
    influencerRevenue: fmt(m.topInfluencer?.revenue ?? 0),
  };
  const flags: Record<string, boolean> = {
    comparison: m.hasPrevious && revenueChangePct != null,
    adSpend: m.adSpend > 0 && m.roas != null,
    savings: m.savings > 0,
    influencerActive: m.topInfluencer != null,
    trafficSteady: m.visitsChangePct != null && m.visitsChangePct > -15,
    topSourceStillStrong: !!m.topSource && m.topSource.revenue > 0,
    avgValueShown: avgValueChangePct != null && Math.abs(avgValueChangePct) >= 1,
  };

  const prose =
    pattern === "no_data"
      ? renderTemplate(NO_DATA, { values, flags })
      : renderTemplate(REPORT_TEMPLATES[pattern], { values, flags });

  // ── Key Points callout (3–6 bullets), all from real data ──
  const keyPoints: string[] = [];
  keyPoints.push(
    m.bookings > 0
      ? `${fmt(m.revenue)} in attributed revenue from ${m.bookings} booking${m.bookings === 1 ? "" : "s"}${revenueChangePct != null ? ` (${revenueChangePct >= 0 ? "+" : ""}${Math.round(revenueChangePct)}% vs previous period)` : ""}.`
      : `No tracked bookings this period.`,
  );
  if (m.topSource && m.topSource.revenue > 0) {
    keyPoints.push(`Top source: ${m.topSource.name} — ${fmt(m.topSource.revenue)} from ${m.topSource.bookings} booking${m.topSource.bookings === 1 ? "" : "s"}.`);
  }
  if (m.adSpend > 0) {
    keyPoints.push(`Paid ads: ${fmt(m.adSpend)} spend${m.roas != null ? ` at ${m.roas.toFixed(1)}x ROAS` : ""}.`);
  }
  if (m.savings > 0) {
    keyPoints.push(`Approximately ${fmt(m.savings)} saved in OTA commissions via direct bookings.`);
  }
  if (m.topInfluencer && m.topInfluencer.revenue > 0) {
    keyPoints.push(`${m.topInfluencer.name} drove ${fmt(m.topInfluencer.revenue)} through influencer collaborations.`);
  }
  if (m.biggestFunnelDrop && m.biggestFunnelDrop.pct >= 0.2) {
    keyPoints.push(`Biggest funnel drop-off: ${Math.round(m.biggestFunnelDrop.pct * 100)}% between ${m.biggestFunnelDrop.fromLabel} and ${m.biggestFunnelDrop.toLabel}.`);
  }
  // Ensure at least 3 bullets even on a quiet period.
  if (keyPoints.length < 3 && m.visitsChangePct != null) {
    keyPoints.push(`Website visits ${m.visitsChangePct >= 0 ? "up" : "down"} ${Math.round(Math.abs(m.visitsChangePct))}% vs the previous period.`);
  }

  return { pattern, keyPoints: keyPoints.slice(0, 6), prose };
}
