import "server-only";

import { renderTemplate } from "@/lib/summary-templates";
import { formatCurrency } from "@/lib/format";

// Plain-language performance narrative for the PDF report, written for a
// non-technical hotel owner (no "ROAS", "attribution", "funnel", "GA4"). It
// reuses the SAME pattern classification (no-data / strong / flat / decline) and
// the {placeholder}/{ifFlag:'…'} template engine as the dashboard's Owner Summary
// Card — extended with ONE data-integrity guardrail: high ad spend with little or
// no tracked bookings is a POOR period, never "strong". Every number is supplied
// by the caller from real data; nothing is invented here.

const fmt = (n: number) => formatCurrency(n, { compact: true });

function pct(cur: number, prev: number): number | null {
  if (prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}

// Ad spend above this (₹) with a return under 0.5× is treated as "spend not
// producing tracked bookings" — the guardrail that stops a false "strong" verdict.
const AD_SPEND_FLOOR = 500;

export type Verdict = "good" | "watch" | "poor" | "none";

export type NarrativeInput = {
  hotelName: string;
  rangeLabel: string;
  revenue: number;
  bookings: number;
  prevRevenue: number;
  prevBookings: number;
  hasPrevious: boolean;
  adSpend: number;
  roas: number | null; // revenue ÷ spend (a ratio); shown to owners as "₹x back per ₹1 spent"
  savings: number;
  visitsChangePct: number | null;
  topSource: { name: string; revenue: number; bookings: number } | null;
  topInfluencer: { name: string; revenue: number } | null;
  biggestFunnelDrop: { fromLabel: string; toLabel: string; pct: number } | null;
};

export type Narrative = { verdict: Verdict; keyPoints: string[]; prose: string };

// Plain-language bodies (same flags/values mechanism as owner-summary).
const T_STRONG =
  "Over {rangeLabel}, {hotelName} brought in {revenue} from {bookings} bookings{ifComparison: ', up {revenueChangePct}% from the period before'}. Most of those bookings came from {topSource}.{ifAdSpend: ' Ads brought back about {returnPerRupee} for every ₹1 spent.'}{ifSavings: ' Taking bookings directly on your own website saved roughly {savings} in commissions you would otherwise pay to travel-booking sites.'}{ifInfluencerActive: ' {influencerName} also contributed {influencerRevenue}.'} Overall a strong period — worth keeping up what is working.";

const T_FLAT =
  "Over {rangeLabel}, {hotelName} brought in {revenue} from {bookings} bookings, a little below the {previousRevenue} from the period before.{ifAdSpend: ' Ads brought back about {returnPerRupee} for every ₹1 spent.'}{ifSavings: ' Direct bookings still saved roughly {savings} in booking-site commissions.'} The main focus for the next period is bringing more of the right visitors to the website.";

const T_DECLINE =
  "Over {rangeLabel}, {hotelName} brought in {revenue} from {bookings} bookings, well below the {previousRevenue} from the period before.{ifTopSourceStillStrong: ' {topSource} was still the biggest source of bookings.'} It is worth looking at what changed — ad results, the time of year, or how easy it is to book on the website.";

const T_NO_DATA =
  "No bookings were tracked over {rangeLabel}. This usually means the tracking code isn't on every page of the website yet, or visitors aren't completing their booking on the site. Once bookings start being tracked, this summary fills in automatically with what happened and what to do next.";

// The guardrail body: money spent on ads, little or nothing tracked back.
const T_AD_NO_RETURN =
  "Over {rangeLabel}, {hotelName} spent {adSpend} on ads, but only {revenue} in bookings has been tracked back to that spend so far — about {returnPerRupee} back for every ₹1 spent. That is well short of what the ad spend should be returning. The usual causes are the tracking code missing from the booking-confirmation page, ads sending visitors who don't book, or bookings happening somewhere the website isn't measuring. This is the most important thing to fix: before spending more, confirm the tracking code is on every page — especially the confirmation page — and review where the ad traffic is going.";

export function buildReportNarrative(m: NarrativeInput): Narrative {
  const revenueChangePct = pct(m.revenue, m.prevRevenue);
  // roas is a ratio (revenue ÷ spend); show it to owners as rupees-back-per-rupee
  // with 2 decimals, e.g. "₹2.40" or "₹0.00".
  const returnStr = `₹${(m.roas ?? 0).toFixed(2)}`;
  const adSpendNoReturn = m.adSpend >= AD_SPEND_FLOOR && (m.roas == null || m.roas < 0.5);

  // ── Verdict / pattern ── (guardrail first, then the owner-summary logic) ──
  let verdict: Verdict;
  if (adSpendNoReturn) verdict = "poor";
  else if (m.bookings === 0) verdict = "none";
  else if (!m.hasPrevious || revenueChangePct == null) verdict = "good";
  else if (revenueChangePct > 0) verdict = "good";
  else if (revenueChangePct > -20) verdict = "watch";
  else verdict = "poor";

  const values: Record<string, string | number> = {
    hotelName: m.hotelName,
    rangeLabel: m.rangeLabel,
    revenue: fmt(m.revenue),
    bookings: m.bookings,
    previousRevenue: fmt(m.prevRevenue),
    revenueChangePct: revenueChangePct == null ? "" : Math.round(Math.abs(revenueChangePct)),
    topSource: m.topSource?.name ?? "direct visits",
    adSpend: fmt(m.adSpend),
    returnPerRupee: returnStr,
    savings: fmt(m.savings),
    influencerName: m.topInfluencer?.name ?? "",
    influencerRevenue: fmt(m.topInfluencer?.revenue ?? 0),
  };
  const flags: Record<string, boolean> = {
    comparison: m.hasPrevious && revenueChangePct != null,
    adSpend: m.adSpend > 0 && m.roas != null,
    savings: m.savings > 0,
    influencerActive: m.topInfluencer != null,
    topSourceStillStrong: !!m.topSource && m.topSource.revenue > 0,
  };

  let body: string;
  if (adSpendNoReturn) body = T_AD_NO_RETURN;
  else if (m.bookings === 0) body = T_NO_DATA;
  else if (verdict === "good") body = T_STRONG;
  else if (verdict === "watch") body = T_FLAT;
  else body = T_DECLINE;
  const prose = renderTemplate(body, { values, flags });

  // ── Key Points (3–6 plain bullets, all from real data) ──
  const keyPoints: string[] = [];
  keyPoints.push(
    m.bookings > 0
      ? `${fmt(m.revenue)} in bookings from ${m.bookings} booking${m.bookings === 1 ? "" : "s"}${revenueChangePct != null ? ` (${revenueChangePct >= 0 ? "+" : ""}${Math.round(revenueChangePct)}% vs the period before)` : ""}.`
      : `No bookings were tracked this period.`,
  );
  if (m.adSpend > 0) {
    keyPoints.push(
      adSpendNoReturn
        ? `Ads: ${fmt(m.adSpend)} spent, but almost no bookings have been tracked back to it — needs attention.`
        : `Ads: ${fmt(m.adSpend)} spent, bringing back about ${returnStr} for every ₹1 spent.`,
    );
  }
  if (m.topSource && m.topSource.revenue > 0) {
    keyPoints.push(`Most bookings came from ${m.topSource.name} — ${fmt(m.topSource.revenue)} from ${m.topSource.bookings} booking${m.topSource.bookings === 1 ? "" : "s"}.`);
  }
  if (m.savings > 0) {
    keyPoints.push(`Saved roughly ${fmt(m.savings)} in commissions by taking bookings directly on your website.`);
  }
  if (m.topInfluencer && m.topInfluencer.revenue > 0) {
    keyPoints.push(`${m.topInfluencer.name} brought in ${fmt(m.topInfluencer.revenue)} through influencer partnerships.`);
  }
  if (keyPoints.length < 3 && m.biggestFunnelDrop && m.biggestFunnelDrop.pct >= 0.2) {
    keyPoints.push(`Most visitors left the site between the ${m.biggestFunnelDrop.fromLabel.toLowerCase()} and ${m.biggestFunnelDrop.toLabel.toLowerCase()} steps.`);
  }
  if (keyPoints.length < 3 && m.visitsChangePct != null) {
    keyPoints.push(`Website visitors were ${m.visitsChangePct >= 0 ? "up" : "down"} ${Math.round(Math.abs(m.visitsChangePct))}% compared with the period before.`);
  }

  return { verdict, keyPoints: keyPoints.slice(0, 6), prose };
}
