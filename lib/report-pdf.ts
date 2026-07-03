import "server-only";

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant-scope";
import { loadHotelReport } from "@/lib/report-data";
import { loadChannelView, type ChannelView } from "@/lib/channel-view";
import { loadGa4Dashboard } from "@/lib/ga4-dashboard";
import { aggregateRevenueBySource, type ConversionRow } from "@/lib/revenue-by-source";
import { computeFunnel, stageRank } from "@/lib/funnel";
import { formatCurrency, formatNumber, formatPercent, formatMultiple } from "@/lib/format";
import { buildReportNarrative } from "@/lib/report-narrative";

// Server-side PDF generation for a hotel's performance report. NO DOM screenshot:
// the document is drawn programmatically with jsPDF from the SAME data layer the
// hotel-owner dashboard uses (loadHotelReport / loadChannelView / loadGa4Dashboard
// / aggregateRevenueBySource / computeFunnel), so the agency's report and the
// hotel's own view contain identical numbers. Read-only; multi-tenant scoping is
// enforced by the caller (route) before this runs, and every query below is
// agency-scoped too.

export type ReportMeta = {
  agencyId: string;
  hotelId: string;
  hotelName: string;
  websiteUrl: string;
  funnelStageRules: unknown;
  agencyName: string;
  agencyContact: {
    contactEmail: string | null;
    mobile: string | null;
    websiteUrl: string | null;
  };
  rangeLabel: string;
  from: string;
  to: string;
  since: Date;
  until: Date;
  generatedAt: string;
};

const fmtC = (n: number) => formatCurrency(n, { compact: true });
const pctDelta = (cur: number | null, prev: number | null): number | null =>
  prev == null || prev === 0 || cur == null ? null : ((cur - prev) / prev) * 100;

function sourceDisplay(key: string): string {
  return key
    .split("/")
    .map((p) => (p === "(none)" || p === "" ? "Direct" : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" / ");
}

const CHANNELS = ["meta_ads", "google_ads", "instagram_organic", "direct", "influencer"] as const;

export async function generateHotelReportPdf(meta: ReportMeta): Promise<Uint8Array> {
  const { agencyId, hotelId, since, until } = meta;
  const periodMs = Math.max(1, until.getTime() - since.getTime());
  const prevSince = new Date(since.getTime() - periodMs);
  const prevUntil = since;

  const [cur, prev, convEvents, curVisits, prevVisits, channelViews, ga4, funnelGroups] = await Promise.all([
    loadHotelReport({ agencyId, hotelId, since, until }),
    loadHotelReport({ agencyId, hotelId, since: prevSince, until: prevUntil }),
    agencyScopedFor(agencyId, prisma.trackingEvent).findMany({
      where: { hotelClientId: hotelId, eventType: "conversion", createdAt: { gte: since, lte: until } },
      select: { utmSource: true, utmMedium: true, utmCampaign: true, utmContent: true, conversionValue: true, couponCodeUsed: true, createdAt: true },
    }),
    agencyScopedFor(agencyId, prisma.session).count({ where: { hotelClientId: hotelId, startedAt: { gte: since, lte: until } } }),
    agencyScopedFor(agencyId, prisma.session).count({ where: { hotelClientId: hotelId, startedAt: { gte: prevSince, lt: prevUntil } } }),
    Promise.all(CHANNELS.map((c) => loadChannelView(hotelId, c, since, until))),
    loadGa4Dashboard({ agencyId, hotelId, since, until, trackedSessions: null }),
    agencyScopedFor(agencyId, prisma.session).groupBy({
      by: ["highestStageReached"],
      where: { hotelClientId: hotelId, startedAt: { gte: since, lte: until } },
      _count: { _all: true },
    }),
  ]);

  // Revenue by Source (R1) — same aggregation as the dashboard card.
  const convRows: ConversionRow[] = convEvents.map((e) => ({
    utmSource: e.utmSource, utmMedium: e.utmMedium, utmCampaign: e.utmCampaign, utmContent: e.utmContent,
    value: e.conversionValue == null ? 0 : Number(e.conversionValue), occurredAt: e.createdAt, couponCode: e.couponCodeUsed,
  }));
  const rbs = aggregateRevenueBySource(convRows, "source", { start: since, end: until });

  // Funnel — same reachedByRank groupBy + computeFunnel as the dashboard.
  const reachedByRank: Record<number, number> = {};
  for (const g of funnelGroups) {
    const r = stageRank(g.highestStageReached);
    if (r > 0) reachedByRank[r] = (reachedByRank[r] ?? 0) + g._count._all;
  }
  const funnel = computeFunnel({ reachedByRank, revenue: 0 });
  const funnelHasData = (funnel.stages[0]?.visitors ?? 0) > 0;
  let biggestFunnelDrop: { fromLabel: string; toLabel: string; pct: number } | null = null;
  funnel.stages.forEach((s, i) => {
    const next = funnel.stages[i + 1];
    if (s.dropOffPct != null && next && (!biggestFunnelDrop || s.dropOffPct > biggestFunnelDrop.pct)) {
      biggestFunnelDrop = { fromLabel: s.label, toLabel: next.label, pct: s.dropOffPct };
    }
  });

  const topGroup = rbs.groups[0];
  const topSource = topGroup && topGroup.revenue > 0
    ? { name: sourceDisplay(topGroup.key), revenue: topGroup.revenue, bookings: topGroup.bookings }
    : null;
  const topInf = [...cur.influencerRows].sort((a, b) => b.revenue - a.revenue)[0];
  const topInfluencer = topInf && topInf.revenue > 0 ? { name: topInf.influencerName, revenue: topInf.revenue } : null;

  const narrative = buildReportNarrative({
    hotelName: meta.hotelName, rangeLabel: meta.rangeLabel,
    revenue: cur.kpis.revenue, bookings: cur.kpis.bookings,
    prevRevenue: prev.kpis.revenue, prevBookings: prev.kpis.bookings, hasPrevious: prev.kpis.bookings > 0,
    adSpend: cur.ads.spend, roas: cur.kpis.roas, savings: cur.otaSavings.amount,
    visitsChangePct: pctDelta(curVisits, prevVisits),
    topSource, topInfluencer, biggestFunnelDrop,
  });

  return render(meta, { cur, prev, curVisits, prevVisits, rbs, channelViews, ga4, funnel, funnelHasData, narrative });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

type RenderData = {
  cur: Awaited<ReturnType<typeof loadHotelReport>>;
  prev: Awaited<ReturnType<typeof loadHotelReport>>;
  curVisits: number;
  prevVisits: number;
  rbs: ReturnType<typeof aggregateRevenueBySource>;
  channelViews: (ChannelView | null)[];
  ga4: Awaited<ReturnType<typeof loadGa4Dashboard>>;
  funnel: ReturnType<typeof computeFunnel>;
  funnelHasData: boolean;
  narrative: ReturnType<typeof buildReportNarrative>;
};

const BRAND: [number, number, number] = [124, 58, 237];
const INK: [number, number, number] = [24, 24, 27];
const MUTE: [number, number, number] = [82, 82, 91];
const LINE: [number, number, number] = [228, 228, 231];
const SOFT: [number, number, number] = [245, 243, 255];
const GOOD: [number, number, number] = [22, 163, 74];
const BAD: [number, number, number] = [220, 38, 38];

function render(meta: ReportMeta, d: RenderData): Uint8Array {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const PW = doc.internal.pageSize.getWidth();
  const PH = doc.internal.pageSize.getHeight();
  const M = 40;
  const CW = PW - 2 * M;
  let y = M;

  const ink = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2]);
  const ensure = (h: number) => { if (y + h > PH - 56) { doc.addPage(); y = M; } };
  const heading = (t: string) => {
    ensure(44);
    doc.setFont("helvetica", "bold"); doc.setFontSize(14); ink(BRAND);
    doc.text(t, M, y); y += 6;
    doc.setDrawColor(BRAND[0], BRAND[1], BRAND[2]); doc.setLineWidth(1.5); doc.line(M, y, M + CW, y);
    y += 18; ink(INK);
  };
  const para = (t: string, size = 10.5) => {
    doc.setFont("helvetica", "normal"); doc.setFontSize(size); ink(INK);
    for (const ln of doc.splitTextToSize(t, CW)) { ensure(size + 4); doc.text(ln, M, y); y += size + 4; }
  };
  const muted = (t: string, size = 9.5) => {
    doc.setFont("helvetica", "normal"); doc.setFontSize(size); ink(MUTE);
    for (const ln of doc.splitTextToSize(t, CW)) { ensure(size + 3); doc.text(ln, M, y); y += size + 3; }
    ink(INK);
  };
  const subhead = (t: string) => {
    ensure(20); doc.setFont("helvetica", "bold"); doc.setFontSize(11); ink(INK); doc.text(t, M, y); y += 15;
  };
  const kvLine = (pairs: [string, string][]) => {
    const text = pairs.map(([k, v]) => `${k}: ${v}`).join("      ");
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); ink(MUTE);
    for (const ln of doc.splitTextToSize(text, CW)) { ensure(14); doc.text(ln, M, y); y += 14; }
    ink(INK);
  };
  const finalY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  const table = (head: string[], body: (string | number)[][], rightCols: number[] = []) => {
    ensure(60);
    autoTable(doc, {
      startY: y,
      margin: { left: M, right: M },
      head: [head],
      body,
      styles: { fontSize: 9, cellPadding: 5, textColor: INK, lineColor: LINE, lineWidth: 0.5 },
      headStyles: { fillColor: SOFT, textColor: BRAND, fontStyle: "bold", fontSize: 8 },
      columnStyles: Object.fromEntries(rightCols.map((c) => [c, { halign: "right" as const }])),
      theme: "grid",
    });
    y = finalY() + 16;
  };

  // ── Cover ──
  doc.setFillColor(BRAND[0], BRAND[1], BRAND[2]); doc.rect(0, 0, PW, 150, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold"); doc.setFontSize(20); doc.text("HotelTrack", M, 62);
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.text("Content → visits → bookings → revenue", M, 82);
  y = 210;
  doc.setFont("helvetica", "bold"); doc.setFontSize(11); ink(MUTE); doc.text("PERFORMANCE REPORT", M, y); y += 30;
  ink(INK); doc.setFontSize(28); doc.text(doc.splitTextToSize(meta.hotelName, CW), M, y); y += 30;
  ink(MUTE); doc.setFont("helvetica", "normal"); doc.setFontSize(12); doc.text(meta.websiteUrl || "", M, y); y += 34;
  ink(INK); doc.setFontSize(13); doc.setFont("helvetica", "bold"); doc.text(meta.rangeLabel, M, y); y += 18;
  ink(MUTE); doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.text(`${meta.from} — ${meta.to}`, M, y);
  ink(MUTE); doc.setFontSize(10);
  doc.text(`Prepared by ${meta.agencyName}`, M, PH - 60);
  doc.text(`Generated ${meta.generatedAt}`, M + CW, PH - 60, { align: "right" });

  doc.addPage(); y = M;

  // ── 2. Performance summary (top) ──
  heading("Performance summary");
  {
    const pad = 12;
    doc.setFontSize(10);
    const wrapped = d.narrative.keyPoints.map((k) => doc.splitTextToSize(`•  ${k}`, CW - 2 * pad));
    const totalLines = wrapped.reduce((s, w) => s + w.length, 0);
    const boxH = pad * 2 + 18 + totalLines * 14;
    ensure(boxH + 6);
    doc.setFillColor(SOFT[0], SOFT[1], SOFT[2]); doc.setDrawColor(BRAND[0], BRAND[1], BRAND[2]); doc.setLineWidth(1);
    doc.roundedRect(M, y, CW, boxH, 6, 6, "FD");
    let by = y + pad + 12;
    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); ink(BRAND); doc.text("KEY POINTS", M + pad, by); by += 16;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); ink(INK);
    for (const w of wrapped) for (const ln of w) { doc.text(ln, M + pad, by); by += 14; }
    y += boxH + 16;
    para(d.narrative.prose);
    y += 10;
  }

  // ── 3. Key metrics ──
  heading("Key metrics");
  {
    const revenue = d.cur.kpis.revenue, prevRevenue = d.prev.kpis.revenue;
    const bookings = d.cur.kpis.bookings, prevBookings = d.prev.kpis.bookings;
    const spend = d.cur.ads.spend, prevSpend = d.prev.ads.spend;
    const roas = d.cur.kpis.roas, prevRoas = d.prev.kpis.roas;
    const convRate = d.cur.kpis.visits > 0 ? bookings / d.cur.kpis.visits : null;
    const prevConvRate = d.prev.kpis.visits > 0 ? prevBookings / d.prev.kpis.visits : null;
    const tiles: { label: string; value: string; delta: number | null; inverse?: boolean }[] = [
      { label: "Revenue", value: fmtC(revenue), delta: pctDelta(revenue, prevRevenue) },
      { label: "Bookings", value: formatNumber(bookings), delta: pctDelta(bookings, prevBookings) },
      { label: "Ad spend", value: fmtC(spend), delta: pctDelta(spend, prevSpend), inverse: true },
      { label: "ROAS", value: formatMultiple(roas), delta: pctDelta(roas, prevRoas) },
      { label: "Conversion rate", value: convRate == null ? "—" : formatPercent(convRate), delta: pctDelta(convRate, prevConvRate) },
      { label: "Commission saved", value: fmtC(d.cur.otaSavings.amount), delta: null },
    ];
    const cols = 3, gap = 10, tileW = (CW - gap * (cols - 1)) / cols, tileH = 54;
    const rows = Math.ceil(tiles.length / cols);
    ensure(rows * (tileH + gap));
    const y0 = y;
    tiles.forEach((t, i) => {
      const tx = M + (i % cols) * (tileW + gap);
      const ty = y0 + Math.floor(i / cols) * (tileH + gap);
      doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.setLineWidth(1); doc.roundedRect(tx, ty, tileW, tileH, 4, 4, "S");
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); ink(MUTE); doc.text(t.label.toUpperCase(), tx + 10, ty + 16);
      doc.setFont("helvetica", "bold"); doc.setFontSize(14); ink(INK); doc.text(t.value, tx + 10, ty + 37);
      if (t.delta != null) {
        const up = t.delta >= 0; const good = t.inverse ? !up : up;
        ink(good ? GOOD : BAD); doc.setFontSize(8); doc.setFont("helvetica", "bold");
        doc.text(`${up ? "▲" : "▼"} ${Math.abs(Math.round(t.delta))}%`, tx + tileW - 10, ty + 37, { align: "right" });
      }
    });
    y = y0 + rows * (tileH + gap) + 6; ink(INK);
    muted("Change badges compare against the immediately-preceding period of the same length.");
  }

  // ── 4. Revenue by source ──
  heading("Revenue by source");
  if (d.rbs.groups.length === 0) {
    muted("No booking revenue was attributed to a source in this period.");
  } else {
    table(
      ["Source", "Bookings", "Revenue", "Avg value", "% of total"],
      d.rbs.groups.slice(0, 10).map((g) => [sourceDisplay(g.key), formatNumber(g.bookings), fmtC(g.revenue), fmtC(g.averageBookingValue), `${g.percentOfTotal.toFixed(0)}%`]),
      [1, 2, 3, 4],
    );
  }

  // ── 5. Channel performance ──
  heading("Channel performance");
  renderChannels(d.channelViews, d.ga4, { subhead, kvLine, muted, table });

  // ── 6. Visitor journey & funnel ──
  heading("Visitor journey & funnel");
  if (!d.funnelHasData) {
    muted("No funnel activity was recorded for this period. Configure funnel stages on the Integrations page to unlock drop-off analysis.");
  } else {
    table(
      ["Stage", "Visitors", "Conv. from previous", "Drop-off to next"],
      d.funnel.stages.map((s) => [s.label, formatNumber(s.visitors), s.conversionFromPrev == null ? "—" : formatPercent(s.conversionFromPrev), s.dropOffPct == null ? "—" : formatPercent(s.dropOffPct)]),
      [1, 2, 3],
    );
    if (d.funnel.overallConversion != null) {
      muted(`Overall awareness-to-booking conversion: ${formatPercent(d.funnel.overallConversion)}.`);
    }
  }

  // ── 7. OTA commission savings ──
  heading("OTA commission savings");
  {
    const s = d.cur.otaSavings;
    if (s.bookingRevenue === 0) {
      muted("No direct booking revenue was tracked this period, so there are no OTA commission savings to report.");
    } else {
      para(`Every booking made directly on ${meta.hotelName}'s own website avoids the commission an OTA would charge. At a ${s.rate}% commission rate, the ${fmtC(s.bookingRevenue)} in direct booking revenue this period saved approximately ${fmtC(s.amount)} that would otherwise have gone to online travel agencies.`);
    }
  }

  // ── 8. Footer on every body page ──
  const total = doc.getNumberOfPages();
  const contact = [meta.agencyContact.contactEmail, meta.agencyContact.mobile, meta.agencyContact.websiteUrl].filter(Boolean).join("   ·   ");
  for (let i = 2; i <= total; i++) {
    doc.setPage(i);
    doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.setLineWidth(0.5); doc.line(M, PH - 40, M + CW, PH - 40);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); ink(MUTE);
    doc.text(`${meta.agencyName}  ·  Powered by HotelTrack`, M, PH - 26);
    if (contact) doc.text(contact, M, PH - 15);
    doc.text(`Page ${i - 1} of ${total - 1}`, M + CW, PH - 26, { align: "right" });
  }

  return new Uint8Array(doc.output("arraybuffer"));
}

// Compact per-channel blocks, each with an honest empty/not-connected state.
function renderChannels(
  views: (ChannelView | null)[],
  ga4: RenderData["ga4"],
  h: {
    subhead: (t: string) => void;
    kvLine: (pairs: [string, string][]) => void;
    muted: (t: string, size?: number) => void;
    table: (head: string[], body: (string | number)[][], rightCols?: number[]) => void;
  },
) {
  const byName = (name: string) => views.find((v) => v?.channelName === name) ?? null;

  // Meta Ads / Google Ads (paid)
  for (const name of ["Meta Ads", "Google Ads"]) {
    const v = byName(name);
    h.subhead(name);
    if (!v || v.channelType !== "paid_ads") { h.muted("No data for this period."); continue; }
    if (v.integrationStatus === "not_connected" || !v.kpis) { h.muted("Not connected for this hotel."); continue; }
    const k = v.kpis;
    h.kvLine([
      ["Spend", fmtC(k.totalSpend)], ["Impressions", formatNumber(k.impressions)], ["Clicks", formatNumber(k.linkClicks)],
      ["CTR", `${k.ctr.toFixed(2)}%`], ["Conversions", formatNumber(k.conversions)], ["ROAS", formatMultiple(k.roas)],
    ]);
    if (v.topCampaigns && v.topCampaigns.length > 0) {
      h.table(["Campaign", "Spend", "Revenue", "Bookings", "ROAS"],
        v.topCampaigns.slice(0, 5).map((c) => [c.campaignName, fmtC(c.spend), fmtC(c.revenue), formatNumber(c.bookings), formatMultiple(c.roas)]),
        [1, 2, 3, 4]);
    }
  }

  // Instagram Organic
  {
    const v = byName("Instagram Organic");
    h.subhead("Instagram (organic)");
    if (!v || v.channelType !== "organic_social" || v.channelName !== "Instagram Organic") { h.muted("No data for this period."); }
    else if (!v.hasData) { h.muted("No organic Instagram data for this period."); }
    else {
      const k = v.kpis;
      h.kvLine([
        ["Reach", formatNumber(k.postReach)], ["Profile visits", formatNumber(k.profileVisits)],
        ["Engagement", formatPercent(k.engagementRate / 100)], ["IG sessions", formatNumber(k.sessionsFromInstagram)],
        ["Bookings", formatNumber(k.bookings)], ["Revenue", fmtC(k.revenue)],
      ]);
    }
  }

  // Website (GA4)
  {
    h.subhead("Website traffic (GA4)");
    if (!ga4.connected || ga4.days === 0) { h.muted("Google Analytics 4 is not connected, or has no data for this period."); }
    else {
      h.kvLine([
        ["Sessions", formatNumber(ga4.sessions)], ["Users", formatNumber(ga4.users)],
        ["Bounce", formatPercent(ga4.bounceRate)], ["Engaged", formatNumber(ga4.engagement.engagedSessions)],
        ["Conversions", formatNumber(ga4.keyEvents)],
      ]);
      if (ga4.sources.length > 0) {
        h.table(["Source / Medium", "Sessions", "Users", "Conversions"],
          ga4.sources.slice(0, 5).map((s) => [`${s.source} / ${s.medium}`, formatNumber(s.sessions), formatNumber(s.users), formatNumber(s.keyEvents)]),
          [1, 2, 3]);
      }
    }
  }

  // Direct
  {
    const v = byName("Direct");
    h.subhead("Direct");
    if (!v || v.channelType !== "direct" || !v.hasData) { h.muted("No direct traffic for this period."); }
    else {
      h.kvLine([["Sessions", formatNumber(v.kpis.sessions)], ["Bookings", formatNumber(v.kpis.bookings)], ["Revenue", fmtC(v.kpis.revenue)]]);
    }
  }

  // Influencer
  {
    const v = byName("Influencer");
    h.subhead("Influencer");
    if (!v || v.channelType !== "influencer" || !v.hasData) { h.muted("No influencer activity for this period."); }
    else {
      h.kvLine([
        ["Active influencers", formatNumber(v.kpis.activeInfluencers)], ["Redemptions", formatNumber(v.kpis.totalRedemptions)],
        ["Revenue", fmtC(v.kpis.totalRevenue)],
      ]);
      if (v.topInfluencers.length > 0) {
        h.table(["Influencer", "Redemptions", "Revenue"],
          v.topInfluencers.slice(0, 5).map((t) => [t.influencerName, formatNumber(t.redemptionsCount), fmtC(t.revenue)]),
          [1, 2]);
      }
    }
  }
}
