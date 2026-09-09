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
import { formatCurrency, formatMultiple, formatNumber, formatPercent } from "@/lib/format";
import { buildReportNarrative, type Verdict } from "@/lib/report-narrative";
import { GEIST_REGULAR_B64 } from "@/lib/report-font";

// Server-side, client-ready PDF for a hotel's performance report. Drawn
// programmatically with jsPDF (NO DOM screenshot) from the SAME data layer the
// hotel-owner dashboard uses, so the agency report and the hotel's own view show
// identical numbers. A Unicode TTF (Geist) is embedded so the ₹ (U+20B9) glyph
// renders correctly — jsPDF's built-in fonts render ₹ as a wrong fallback char.
// Multi-tenant scoping is enforced by the caller (route) and by every query here.

export type ReportMeta = {
  agencyId: string;
  hotelId: string;
  hotelName: string;
  websiteUrl: string;
  funnelStageRules: unknown;
  agencyName: string;
  agencyContact: { contactEmail: string | null; mobile: string | null; websiteUrl: string | null };
  rangeLabel: string;
  from: string;
  to: string;
  since: Date;
  until: Date;
  generatedAt: string;
};

const money = (n: number) => formatCurrency(n, { compact: true });
const pctDelta = (cur: number | null, prev: number | null): number | null =>
  prev == null || prev === 0 || cur == null ? null : ((cur - prev) / prev) * 100;

// Friendly, capitalised source name (keys are lowercase, "/"-joined at finer
// granularities; the report uses "source" granularity so it's a single token).
function sourceDisplay(key: string): string {
  return key
    .split("/")
    .map((p) => (!p || p === "(none)" ? "Direct" : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" / ");
}

// Plain-language funnel stage labels (no "funnel" jargon in the doc).
const STAGE_PLAIN: Record<string, string> = {
  Awareness: "Browsing the site",
  Consideration: "Looking at rooms",
  Intent: "Starting to book",
  Booking: "Completed a booking",
};

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
      select: {
        utmSource: true, utmMedium: true, utmCampaign: true, utmContent: true,
        conversionValue: true, couponCodeUsed: true, createdAt: true,
        // Required by classifySourceType. Without these the channel table below
        // bucketed every auto-tagged Google booking as `direct`, while the KPI
        // block on the preceding page (via loadHotelReport, which does select
        // them) counted the SAME booking as paid Google revenue — the two halves
        // of the client-facing PDF disagreed with each other.
        gclid: true, gbraid: true, wbraid: true, fbclid: true,
      },
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

  const convRows: ConversionRow[] = convEvents.map((e) => ({
    utmSource: e.utmSource, utmMedium: e.utmMedium, utmCampaign: e.utmCampaign, utmContent: e.utmContent,
    value: e.conversionValue == null ? 0 : Number(e.conversionValue), occurredAt: e.createdAt, couponCode: e.couponCodeUsed,
    gclid: e.gclid, gbraid: e.gbraid, wbraid: e.wbraid, fbclid: e.fbclid,
  }));
  const rbs = aggregateRevenueBySource(convRows, "source", { start: since, end: until });

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
      biggestFunnelDrop = { fromLabel: STAGE_PLAIN[s.label] ?? s.label, toLabel: STAGE_PLAIN[next.label] ?? next.label, pct: s.dropOffPct };
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
    // Phase 0: the narrative's ROAS is PAID revenue ÷ PAID spend, so the spend
    // it quotes must be the same combined paid spend — not `ads.spend`, which is
    // Meta-only. (`kpis.spend` is null only when currencies can't be combined.)
    // Null (currencies not safely combinable) is passed THROUGH, not coerced to
    // 0 — buildReportNarrative suppresses every ads sentence rather than telling
    // the owner they spent ₹0.
    adSpend: cur.kpis.spend, roas: cur.kpis.roas, savings: cur.otaSavings.amount,
    visitsChangePct: pctDelta(curVisits, prevVisits), topSource, topInfluencer, biggestFunnelDrop,
  });

  return render(meta, { cur, prev, rbs, channelViews, ga4, funnel, funnelHasData, narrative });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

type RenderData = {
  cur: Awaited<ReturnType<typeof loadHotelReport>>;
  prev: Awaited<ReturnType<typeof loadHotelReport>>;
  rbs: ReturnType<typeof aggregateRevenueBySource>;
  channelViews: (ChannelView | null)[];
  ga4: Awaited<ReturnType<typeof loadGa4Dashboard>>;
  funnel: ReturnType<typeof computeFunnel>;
  funnelHasData: boolean;
  narrative: ReturnType<typeof buildReportNarrative>;
};

type RGB = [number, number, number];
const BRAND: RGB = [79, 70, 229];
const INK: RGB = [24, 24, 27];
const MUTE: RGB = [90, 90, 99];
const LINE: RGB = [225, 225, 230];
const SOFT: RGB = [244, 244, 253];
const GOOD: RGB = [21, 128, 61];
const WARN: RGB = [180, 83, 9];
const BAD: RGB = [190, 30, 40];

const VERDICT: Record<Verdict, { label: string; color: RGB; tint: RGB }> = {
  good: { label: "Strong period", color: GOOD, tint: [236, 253, 243] },
  watch: { label: "Mixed — worth watching", color: WARN, tint: [255, 247, 237] },
  poor: { label: "Needs attention", color: BAD, tint: [254, 242, 242] },
  none: { label: "No bookings tracked yet", color: MUTE, tint: [245, 245, 247] },
};

function render(meta: ReportMeta, d: RenderData): Uint8Array {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.addFileToVFS("Geist-Regular.ttf", GEIST_REGULAR_B64);
  doc.addFont("Geist-Regular.ttf", "Geist", "normal");
  doc.addFont("Geist-Regular.ttf", "Geist", "bold"); // same file; emphasis via faux-bold below
  doc.setFont("Geist", "normal");

  const PW = doc.internal.pageSize.getWidth();
  const PH = doc.internal.pageSize.getHeight();
  const M = 48;
  const CW = PW - 2 * M;
  const BOTTOM = PH - 56;
  let y = M;

  // Core text primitive — one place that owns colour, size, faux-bold, alignment.
  const put = (
    str: string, x: number, yy: number,
    o: { size?: number; color?: RGB; strong?: boolean; align?: "left" | "right" | "center" } = {},
  ) => {
    const size = o.size ?? 10;
    const c = o.color ?? INK;
    doc.setFontSize(size); doc.setTextColor(c[0], c[1], c[2]);
    if (o.strong) {
      doc.setDrawColor(c[0], c[1], c[2]); doc.setLineWidth(size * 0.021);
      doc.text(str, x, yy, { align: o.align, renderingMode: "fillThenStroke" });
    } else {
      doc.text(str, x, yy, { align: o.align });
    }
  };
  const ensure = (h: number) => { if (y + h > BOTTOM) { doc.addPage(); y = M; } };
  const para = (str: string, o: { size?: number; color?: RGB; gap?: number } = {}) => {
    const size = o.size ?? 10.5;
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(str, CW) as string[];
    for (const ln of lines) { ensure(size + 4); put(ln, M, y, { size, color: o.color ?? INK }); y += size + 4; }
    y += o.gap ?? 0;
  };
  const heading = (t: string) => {
    ensure(40);
    put(t, M, y, { size: 13.5, color: BRAND, strong: true }); y += 7;
    doc.setDrawColor(BRAND[0], BRAND[1], BRAND[2]); doc.setLineWidth(1.4); doc.line(M, y, M + CW, y);
    y += 18;
  };
  const subhead = (t: string) => { ensure(22); put(t, M, y, { size: 11, color: INK, strong: true }); y += 15; };
  const kvLine = (pairs: [string, string][]) => {
    // Draw as "Label value" chips wrapped across the width, right-clean.
    doc.setFontSize(9.5);
    let cx = M; const rowH = 15; const chipGap = 18;
    ensure(rowH);
    for (const [k, v] of pairs) {
      const text = `${k}: ${v}`;
      const w = doc.getTextWidth(text);
      if (cx + w > M + CW) { y += rowH; cx = M; ensure(rowH); }
      put(`${k}: `, cx, y, { size: 9.5, color: MUTE });
      const kw = doc.getTextWidth(`${k}: `);
      put(v, cx + kw, y, { size: 9.5, color: INK });
      cx += w + chipGap;
    }
    y += rowH;
  };
  const finalY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  const table = (head: string[], body: (string | number)[][], rightCols: number[] = []) => {
    ensure(56);
    autoTable(doc, {
      startY: y, margin: { left: M, right: M },
      head: [head], body,
      styles: { font: "Geist", fontStyle: "normal", fontSize: 9, cellPadding: 6, textColor: INK, lineColor: LINE, lineWidth: 0.5, overflow: "linebreak" },
      headStyles: { font: "Geist", fontStyle: "normal", fillColor: SOFT, textColor: BRAND, fontSize: 8.5, cellPadding: 6 },
      alternateRowStyles: { fillColor: [250, 250, 252] },
      columnStyles: Object.fromEntries(rightCols.map((c) => [c, { halign: "right" as const }])),
      theme: "grid",
    });
    y = finalY() + 18;
  };

  // ── Page 1: header ──
  doc.setFillColor(BRAND[0], BRAND[1], BRAND[2]); doc.rect(0, 0, PW, 8, "F"); // top accent bar
  put("HotelTrack", M, 44, { size: 15, color: BRAND, strong: true });
  put("Performance report", PW - M, 44, { size: 10, color: MUTE, align: "right" });
  y = 74;
  put(meta.hotelName, M, y, { size: 24, color: INK, strong: true }); y += 20;
  if (meta.websiteUrl) { put(meta.websiteUrl, M, y, { size: 10.5, color: MUTE }); y += 16; }
  put(`${meta.rangeLabel}  ·  ${meta.from} to ${meta.to}`, M, y, { size: 11, color: INK }); y += 15;
  put(`Prepared by ${meta.agencyName}   ·   Generated ${meta.generatedAt}`, M, y, { size: 9.5, color: MUTE });
  y += 22;

  // Verdict banner
  {
    const v = VERDICT[d.narrative.verdict];
    const h = 30;
    ensure(h + 6);
    doc.setFillColor(v.tint[0], v.tint[1], v.tint[2]); doc.setDrawColor(v.color[0], v.color[1], v.color[2]); doc.setLineWidth(1);
    doc.roundedRect(M, y, CW, h, 5, 5, "FD");
    put("VERDICT", M + 12, y + 12, { size: 7.5, color: v.color, strong: true });
    put(v.label, M + 12, y + 24, { size: 12, color: v.color, strong: true });
    y += h + 18;
  }

  // ── Performance summary ──
  heading("Performance summary");
  {
    const pad = 12;
    doc.setFontSize(10);
    const wrapped = d.narrative.keyPoints.map((k) => doc.splitTextToSize(`•  ${k}`, CW - 2 * pad) as string[]);
    const totalLines = wrapped.reduce((s, w) => s + w.length, 0);
    const boxH = pad * 2 + 16 + totalLines * 13.5;
    ensure(boxH + 6);
    doc.setFillColor(SOFT[0], SOFT[1], SOFT[2]); doc.setDrawColor(BRAND[0], BRAND[1], BRAND[2]); doc.setLineWidth(1);
    doc.roundedRect(M, y, CW, boxH, 6, 6, "FD");
    let by = y + pad + 11;
    put("KEY POINTS", M + pad, by, { size: 8, color: BRAND, strong: true }); by += 15;
    for (const w of wrapped) for (const ln of w) { put(ln, M + pad, by, { size: 10, color: INK }); by += 13.5; }
    y += boxH + 16;
    para(d.narrative.prose, { size: 10.5, gap: 10 });
  }

  // ── Key performance indicators ──
  heading("Key performance indicators");
  {
    const revenue = d.cur.kpis.revenue, prevRevenue = d.prev.kpis.revenue;
    const bookings = d.cur.kpis.bookings, prevBookings = d.prev.kpis.bookings;
    // Phase 0: "Ad spend" is the COMBINED paid spend the ROAS tile divides by
    // (Meta + Google). `ads.spend` is Meta-only and would contradict it.
    const spend = d.cur.kpis.spend, prevSpend = d.prev.kpis.spend;
    const roas = d.cur.kpis.roas, prevRoas = d.prev.kpis.roas;
    const convRate = d.cur.kpis.visits > 0 ? bookings / d.cur.kpis.visits : null;
    const prevConvRate = d.prev.kpis.visits > 0 ? prevBookings / d.prev.kpis.visits : null;
    const tiles: { label: string; value: string; sub?: string; delta: number | null; inverse?: boolean }[] = [
      { label: "Revenue", value: money(revenue), delta: pctDelta(revenue, prevRevenue) },
      { label: "Bookings", value: formatNumber(bookings), delta: pctDelta(bookings, prevBookings) },
      // "—" when the ad accounts report in currencies that cannot be safely
      // combined. Never ₹0 — an unavailable total is not "no spend".
      { label: "Ad spend", value: spend == null ? "—" : money(spend), delta: pctDelta(spend, prevSpend), inverse: true },
      { label: "Return on ad spend", value: formatMultiple(roas), sub: "paid-channel revenue per ₹1 spent", delta: pctDelta(roas, prevRoas) },
      { label: "Website conversion rate", value: convRate == null ? "—" : formatPercent(convRate), sub: "visitors who booked", delta: pctDelta(convRate, prevConvRate) },
      { label: "Commission saved vs OTAs", value: money(d.cur.otaSavings.amount), delta: null },
    ];
    const cols = 3, gap = 12, tileW = (CW - gap * (cols - 1)) / cols, tileH = 62;
    const rows = Math.ceil(tiles.length / cols);
    ensure(rows * (tileH + gap));
    const y0 = y;
    tiles.forEach((t, i) => {
      const tx = M + (i % cols) * (tileW + gap);
      const ty = y0 + Math.floor(i / cols) * (tileH + gap);
      doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.setLineWidth(1); doc.roundedRect(tx, ty, tileW, tileH, 5, 5, "S");
      put(t.label.toUpperCase(), tx + 11, ty + 16, { size: 7.5, color: MUTE });
      put(t.value, tx + 11, ty + 37, { size: 17, color: INK, strong: true });
      if (t.sub) put(t.sub, tx + 11, ty + 51, { size: 7.5, color: MUTE });
      if (t.delta != null) {
        const up = t.delta >= 0; const good = t.inverse ? !up : up;
        put(`${up ? "▲" : "▼"} ${Math.abs(Math.round(t.delta))}%`, tx + tileW - 11, ty + 16, { size: 8, color: good ? GOOD : BAD, strong: true, align: "right" });
      }
    });
    y = y0 + rows * (tileH + gap) + 4;
    put("Change shown against the previous period of the same length.", M, y, { size: 8, color: MUTE }); y += 16;
  }

  // ── Page 2+: detail ──
  doc.addPage(); y = M;

  heading("Where your bookings came from");
  if (d.rbs.groups.length === 0) {
    para("No bookings were tracked to a source in this period.", { size: 10, color: MUTE });
  } else {
    table(
      ["Source", "Bookings", "Revenue", "Avg. booking", "Share"],
      d.rbs.groups.slice(0, 10).map((g) => [sourceDisplay(g.key), formatNumber(g.bookings), money(g.revenue), money(g.averageBookingValue), `${g.percentOfTotal.toFixed(0)}%`]),
      [1, 2, 3, 4],
    );
  }

  heading("How each marketing channel performed");
  renderChannels(d.channelViews, d.ga4, { subhead, kvLine, para, table });

  heading("Where visitors go on your website");
  if (!d.funnelHasData) {
    para("No visitor-journey activity was recorded this period. Once the tracking code is capturing page visits, this shows how far visitors get toward booking.", { size: 10, color: MUTE });
  } else {
    table(
      ["Step", "Visitors", "Reached from previous step", "Left before next step"],
      d.funnel.stages.map((s) => [STAGE_PLAIN[s.label] ?? s.label, formatNumber(s.visitors), s.conversionFromPrev == null ? "—" : formatPercent(s.conversionFromPrev), s.dropOffPct == null ? "—" : formatPercent(s.dropOffPct)]),
      [1, 2, 3],
    );
  }

  heading("Commission saved by booking direct");
  {
    const s = d.cur.otaSavings;
    if (s.bookingRevenue === 0) {
      para("No direct bookings were tracked this period, so there are no commission savings to report yet.", { size: 10, color: MUTE });
    } else {
      para(`Every booking made directly on your own website avoids the commission a travel-booking site (OTA) would charge. At a commission rate of ${s.rate}%, the ${money(s.bookingRevenue)} in direct bookings this period saved roughly ${money(s.amount)} that would otherwise have gone to those sites.`, { size: 10.5 });
    }
  }

  // ── How we count ──────────────────────────────────────────────────────────
  // The methodology travels WITH the export, expanded. A PDF is forwarded,
  // printed and read months later by people who never saw the web page, and the
  // honest gaps in this report — no booking link, operations figures recorded by
  // the property — read as defects unless the document says what they are.
  doc.addPage();
  y = 60;
  put("How we count", M, y, { size: 16, color: INK, strong: true }); y += 20;
  para(
    "Every figure in this report comes from one of three systems, and they are never added " +
      "together. Adding them would count the same customer more than once, by an amount nobody " +
      "can determine.",
    { size: 10.5 },
  );
  y += 4;

  put("What HotelTrack measured", M, y, { size: 11, color: INK, strong: true }); y += 15;
  para(
    "Website visits, sessions and on-site conversions, recorded by the tracking snippet on the " +
      "property's own site. Days are cut in the property's own timezone.",
    { size: 10, color: MUTE },
  );

  put("What the ad platforms report", M, y, { size: 11, color: INK, strong: true }); y += 15;
  para(
    "Impressions, clicks and spend as Google and Meta count them, in their own daily buckets and " +
      "attribution windows. Their conversion counts have no action type recorded, so what they " +
      "count is not known. Platform days and site days may differ by up to one day at each " +
      "boundary; that gap is not reconciled, because it cannot be reconstructed from the data " +
      "either platform supplies.",
    { size: 10, color: MUTE },
  );

  put("What the property recorded", M, y, { size: 11, color: INK, strong: true }); y += 15;
  para(
    "Calls, WhatsApp enquiries and confirmed room nights come from the property's own operations " +
      "tracker, not from HotelTrack. That tracker has no source or campaign column, so none of " +
      "those contacts can be attributed to a marketing channel. \u201CRoom nights confirmed\u201D counts " +
      "nights, not bookings \u2014 one booking can be several nights \u2014 so any ratio built on it is a " +
      "yield figure and may legitimately exceed 100%. It is never a conversion rate.",
    { size: 10, color: MUTE },
  );

  put("What is not yet connected", M, y, { size: 11, color: INK, strong: true }); y += 15;
  para(
    "Booking confirmations are not linked to website sessions: the booking engine sits on a " +
      "different domain from the marketing site and identity does not survive the hand-off. Until " +
      "it does, no booking revenue can be credited to a marketing channel, and any figure claiming " +
      "otherwise would be invented. Anything without positive evidence of a channel is reported as " +
      "Unattributed rather than assigned to one.",
    { size: 10, color: MUTE },
  );

  put("Scope of this export", M, y, { size: 11, color: INK, strong: true }); y += 15;
  para(
    "This export covers ALL properties in the group over the period named on the first page. The " +
      "on-screen report can be filtered to a single property; this document is not, so a figure " +
      "here may be larger than the same figure viewed for one property on screen.",
    { size: 10, color: MUTE },
  );

  // ── Footer on every page ──
  const total = doc.getNumberOfPages();
  const contact = [meta.agencyContact.contactEmail, meta.agencyContact.mobile, meta.agencyContact.websiteUrl].filter(Boolean).join("   ·   ");
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setDrawColor(LINE[0], LINE[1], LINE[2]); doc.setLineWidth(0.5); doc.line(M, PH - 40, M + CW, PH - 40);
    put(`${meta.agencyName}  ·  Powered by HotelTrack`, M, PH - 26, { size: 8, color: MUTE });
    if (contact) put(contact, M, PH - 15, { size: 8, color: MUTE });
    put(`Page ${i} of ${total}`, M + CW, PH - 26, { size: 8, color: MUTE, align: "right" });
  }

  return new Uint8Array(doc.output("arraybuffer"));
}

function renderChannels(
  views: (ChannelView | null)[],
  ga4: RenderData["ga4"],
  h: {
    subhead: (t: string) => void;
    kvLine: (pairs: [string, string][]) => void;
    para: (t: string, o?: { size?: number; color?: RGB; gap?: number }) => void;
    table: (head: string[], body: (string | number)[][], rightCols?: number[]) => void;
  },
) {
  const byName = (name: string) => views.find((v) => v?.channelName === name) ?? null;
  const none = (t: string) => h.para(t, { size: 9.5, color: MUTE, gap: 6 });

  for (const [name, label] of [["Meta Ads", "Meta Ads (Facebook & Instagram)"], ["Google Ads", "Google Ads"]] as const) {
    const v = byName(name);
    h.subhead(label);
    if (!v || v.channelType !== "paid_ads") { none("No data for this period."); continue; }
    if (v.integrationStatus === "not_connected" || !v.kpis) { none("Not connected for this hotel."); continue; }
    const k = v.kpis;
    h.kvLine([
      ["Spend", money(k.totalSpend)], ["Times shown", formatNumber(k.impressions)], ["Clicks to site", formatNumber(k.linkClicks)],
      ["Bookings", formatNumber(k.conversions)], ["Back per ₹1", formatMultiple(k.roas)],
    ]);
    if (v.topCampaigns && v.topCampaigns.length > 0) {
      h.table(["Campaign", "Spend", "Revenue", "Bookings", "Back per ₹1"],
        v.topCampaigns.slice(0, 5).map((c) => [c.campaignName, money(c.spend), money(c.revenue), formatNumber(c.bookings), formatMultiple(c.roas)]),
        [1, 2, 3, 4]);
    }
  }

  {
    const v = byName("Instagram Organic");
    h.subhead("Instagram (organic posts)");
    if (!v || v.channelType !== "organic_social" || v.channelName !== "Instagram Organic") none("No data for this period.");
    else if (!v.hasData) none("No organic Instagram data for this period.");
    else {
      const k = v.kpis;
      h.kvLine([
        ["People reached", formatNumber(k.postReach)], ["Profile visits", formatNumber(k.profileVisits)],
        ["Visits to site", formatNumber(k.sessionsFromInstagram)], ["Bookings", formatNumber(k.bookings)], ["Revenue", money(k.revenue)],
      ]);
    }
  }

  {
    h.subhead("Website analytics");
    if (!ga4.connected || ga4.days === 0) none("Website analytics is not connected, or has no data for this period.");
    else {
      h.kvLine([
        ["Visits", formatNumber(ga4.sessions)], ["Visitors", formatNumber(ga4.users)],
        ["Left quickly", formatPercent(ga4.bounceRate)], ["Bookings/goals", formatNumber(ga4.keyEvents)],
      ]);
    }
  }

  {
    const v = byName("Direct");
    h.subhead("Direct visits");
    if (!v || v.channelType !== "direct" || !v.hasData) none("No direct visits for this period.");
    else h.kvLine([["Visits", formatNumber(v.kpis.sessions)], ["Bookings", formatNumber(v.kpis.bookings)], ["Revenue", money(v.kpis.revenue)]]);
  }

  {
    const v = byName("Influencer");
    h.subhead("Influencers");
    if (!v || v.channelType !== "influencer" || !v.hasData) none("No influencer activity for this period.");
    else {
      h.kvLine([["Active influencers", formatNumber(v.kpis.activeInfluencers)], ["Coupon uses", formatNumber(v.kpis.totalRedemptions)], ["Revenue", money(v.kpis.totalRevenue)]]);
      if (v.topInfluencers.length > 0) {
        h.table(["Influencer", "Coupon uses", "Revenue"],
          v.topInfluencers.slice(0, 5).map((t) => [t.influencerName, formatNumber(t.redemptionsCount), money(t.revenue)]),
          [1, 2]);
      }
    }
  }
}
