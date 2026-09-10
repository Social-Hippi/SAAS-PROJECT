import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { matchCampaignToSegment, type CampaignSegmentRule } from "@/lib/campaign-property";
import { CAMPAIGN_TYPE_LABEL, classifyMetaObjective } from "@/lib/metrics/campaign-type";
import { UNASSIGNED_SEGMENT } from "@/lib/segments";

// ─────────────────────────────────────────────────────────────────────────────
// META ADS, BROKEN DOWN BY PROPERTY.
//
// One box per property: the campaigns that ran for it, then that property's
// totals — then the same again for the next property. Followed by a per-property
// detail table and a messages-per-day series for the chart.
//
// ATTRIBUTION IS BY CAMPAIGN NAME, and is an inference. A campaign carries no
// property field; the names carry {CBH} / {THC} by convention. The patterns are
// data on PropertySegment, a campaign matching nothing lands in a visible
// Unassigned box, and a campaign two properties both claim lands there too
// rather than being awarded to one. See lib/campaign-property.ts.
//
// MESSAGES AND LEADS ARE DIFFERENT EVENTS and are reported as separate columns.
// "Contacts" adds them for the cost-per-contact figure, and the report says so:
// somebody who both messaged and submitted a form is in both, so contacts is an
// upper bound rather than a headcount. That is stated where it is shown instead
// of being quietly avoided — the alternative, picking one and calling it "leads",
// discards most of the signal on a WhatsApp campaign.
//
// SPEND IS GATED, not stripped afterwards. `spendVisible` false means spend,
// cost-per-contact and every other money figure are absent from the payload
// entirely, so nothing downstream can render one by mistake.
// ─────────────────────────────────────────────────────────────────────────────

export type MetaCampaignBreakdownRow = {
  campaignId: string;
  campaignName: string;
  /** "Sales" / "Leads" / "Engagement" / "Traffic", or null when Meta gave none. */
  objectiveLabel: string | null;
  clicks: number;
  impressions: number;
  reach: number | null;
  messages: number;
  /** Connected calls from click-to-call ads. */
  calls: number;
  leads: number;
  /** messages + calls + leads. An upper bound; see the note above. */
  contacts: number;
  /** null when spend is hidden, or when there are no contacts to divide by. */
  spend: number | null;
  costPerContact: number | null;
  ctr: number; // 0..1
  /** contacts ÷ clicks — of the people who clicked, how many made contact. */
  contactRate: number | null;
  /** Meta's conversion-rate ranking, or null while Meta withholds it. */
  ranking: string | null;
  bookings: number;
};

/**
 * What the PROPERTY's own team wrote down, from its operations workbook.
 *
 * NOT ATTRIBUTABLE TO A CAMPAIGN, and never divided across them. The sheet
 * records a WhatsApp lead, a confirmation and a room night; it does not record
 * which campaign — or which channel at all — produced any of them. Splitting
 * these across campaigns by spend share, or by message share, would be inventing
 * an attribution nobody measured.
 *
 * They sit beside the Meta figures so the two can be compared, which is the
 * honest use: Meta counts conversations its ads started, the property counts
 * every WhatsApp lead however it arrived. The gap between them is real
 * information — and it is not a discrepancy to be reconciled away.
 */
export type PropertyRecorded = {
  whatsappLeads: number | null;
  whatsappConfirmed: number | null;
  roomNights: number | null;
  /** Days the property actually filled in. A missing day is unrecorded, not 0. */
  daysRecorded: number;
  /** Days in the selected period, for comparison against daysRecorded. */
  daysInPeriod: number;
};

export type MetaPropertyGroup = {
  segmentKey: string;
  propertyName: string;
  campaigns: MetaCampaignBreakdownRow[];
  /** Null for the Unassigned bucket, which is not a property and keeps no sheet. */
  recorded: PropertyRecorded | null;
  totals: {
    campaigns: number;
    clicks: number;
    impressions: number;
    reach: number | null;
    messages: number;
    calls: number;
    leads: number;
    contacts: number;
    spend: number | null;
    costPerContact: number | null;
    ctr: number;
    bookings: number;
  };
};

export type MetaPropertyBreakdown = {
  spendVisible: boolean;
  groups: MetaPropertyGroup[];
  /** One entry per day, with a messages count per property. For the chart. */
  daily: { date: string; byProperty: Record<string, number> }[];
  /** True when Meta returned no ranking for any campaign in the window. */
  rankingsUnavailable: boolean;
};

const ratio = (num: number, den: number): number => (den > 0 ? num / den : 0);

export async function loadMetaPropertyBreakdown(
  hotelClientId: string,
  range: { since: Date; until: Date },
  showAdSpend: boolean,
  /**
   * The property chip's selection, or null for "All properties".
   *
   * Filters at the SOURCE rather than in the markup, so a report for one
   * property does not carry another property's campaigns and spend in its
   * payload at all — the same rule the ad-spend gate follows.
   */
  selectedSegmentKey: string | null = null,
): Promise<MetaPropertyBreakdown> {
  const [segments, snaps, verifiedRows, trackerRows] = await Promise.all([
    agencyScoped(prisma.propertySegment).findMany({
      where: { hotelClientId, isActive: true },
      orderBy: { displayOrder: "asc" },
      select: { id: true, name: true, campaignNamePatterns: true },
    }),
    agencyScoped(prisma.adCampaignSnapshot).findMany({
      where: { hotelClientId, archived: false, date: { gte: range.since, lte: range.until } },
      // Ordered so the LAST name seen is the campaign's current one — the names
      // were changed mid-window to carry {CBH}/{THC}, and older days keep the
      // old name until they are re-synced.
      orderBy: { date: "asc" },
      select: {
        metaCampaignId: true, campaignName: true, date: true, objective: true,
        spend: true, impressions: true, clicks: true, reach: true,
        messagingStarted: true, calls: true, leads: true, conversionRateRanking: true,
      },
    }),
    agencyScoped(prisma.campaignPerformance).findMany({
      where: { hotelClientId, archived: false, date: { gte: range.since, lte: range.until } },
      select: { campaignName: true, realBookings: true },
    }),
    // The property's OWN operations workbook. Per property per day, and carrying
    // no campaign — which is exactly how it is presented.
    agencyScoped(prisma.manualLeadDaily).groupBy({
      by: ["propertySegmentId"],
      where: { hotelClientId, date: { gte: range.since, lte: range.until } },
      _count: { _all: true },
      _sum: { whatsappLeads: true, whatsappConfirmed: true, roomNightsConfirmed: true },
    }),
  ]);

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const daysInPeriod =
    Math.floor((range.until.getTime() - range.since.getTime()) / MS_PER_DAY) + 1;

  const recordedBySegment = new Map<string, PropertyRecorded>();
  for (const t of trackerRows) {
    if (!t.propertySegmentId) continue;
    recordedBySegment.set(t.propertySegmentId, {
      whatsappLeads: t._sum.whatsappLeads,
      whatsappConfirmed: t._sum.whatsappConfirmed,
      roomNights: t._sum.roomNightsConfirmed,
      daysRecorded: t._count._all,
      daysInPeriod,
    });
  }

  const bookingsByName = new Map<string, number>();
  for (const v of verifiedRows) {
    const k = v.campaignName.trim().toLowerCase();
    bookingsByName.set(k, (bookingsByName.get(k) ?? 0) + v.realBookings);
  }

  type Acc = {
    name: string; names: string[]; objective: string | null; ranking: string | null;
    clicks: number; impressions: number; reach: number | null;
    messages: number; calls: number; leads: number; spend: number;
    /** messages per YYYY-MM-DD, for the chart. */
    perDay: Map<string, number>;
  };
  const byCampaign = new Map<string, Acc>();

  for (const s of snaps) {
    const a = byCampaign.get(s.metaCampaignId) ?? {
      name: s.campaignName, names: [], objective: null, ranking: null,
      clicks: 0, impressions: 0, reach: null, messages: 0, calls: 0, leads: 0, spend: 0,
      perDay: new Map<string, number>(),
    };
    a.name = s.campaignName;
    if (!a.names.includes(s.campaignName)) a.names.push(s.campaignName);
    if (s.objective) a.objective = s.objective;
    if (s.conversionRateRanking) a.ranking = s.conversionRateRanking;
    a.clicks += s.clicks;
    a.impressions += s.impressions;
    if (s.reach != null) a.reach = (a.reach ?? 0) + s.reach;
    const msg = s.messagingStarted ?? 0;
    a.messages += msg;
    a.calls += s.calls ?? 0;
    a.leads += s.leads ?? 0;
    a.spend += Number(s.spend);
    const day = s.date.toISOString().slice(0, 10);
    a.perDay.set(day, (a.perDay.get(day) ?? 0) + msg);
    byCampaign.set(s.metaCampaignId, a);
  }

  const rules: CampaignSegmentRule[] = segments.map((s) => ({
    id: s.id,
    name: s.name,
    campaignNamePatterns: s.campaignNamePatterns,
  }));

  // Every property gets a box even with nothing running, so a reader is never
  // left wondering whether a property was forgotten or simply had no campaigns.
  const groups = new Map<string, MetaPropertyGroup>();
  for (const s of segments) {
    groups.set(s.id, {
      segmentKey: s.id,
      propertyName: s.name,
      campaigns: [],
      recorded: recordedBySegment.get(s.id) ?? null,
      totals: emptyTotals(showAdSpend),
    });
  }

  const daily = new Map<string, Record<string, number>>();

  for (const [campaignId, a] of byCampaign) {
    const { segmentKey } = matchCampaignToSegment(a.name, rules);
    if (!groups.has(segmentKey)) {
      groups.set(segmentKey, {
        segmentKey,
        propertyName: "Unassigned",
        campaigns: [],
        // Not a property, so it keeps no workbook and gets no recorded block.
        recorded: null,
        totals: emptyTotals(showAdSpend),
      });
    }
    const contacts = a.messages + a.calls + a.leads;
    const bookings = a.names.reduce(
      (t, n) => t + (bookingsByName.get(n.trim().toLowerCase()) ?? 0),
      0,
    );

    groups.get(segmentKey)!.campaigns.push({
      campaignId,
      campaignName: a.name,
      objectiveLabel: a.objective
        ? CAMPAIGN_TYPE_LABEL[classifyMetaObjective(a.objective).type]
        : null,
      clicks: a.clicks,
      impressions: a.impressions,
      reach: a.reach,
      messages: a.messages,
      calls: a.calls,
      leads: a.leads,
      contacts,
      spend: showAdSpend ? a.spend : null,
      costPerContact: showAdSpend && contacts > 0 ? a.spend / contacts : null,
      ctr: ratio(a.clicks, a.impressions),
      contactRate: a.clicks > 0 ? contacts / a.clicks : null,
      ranking: a.ranking,
      bookings,
    });

    for (const [day, msg] of a.perDay) {
      const row = daily.get(day) ?? {};
      row[segmentKey] = (row[segmentKey] ?? 0) + msg;
      daily.set(day, row);
    }
  }

  const out: MetaPropertyGroup[] = [...groups.values()].map((g) => {
    g.campaigns.sort((x, y) => (y.spend ?? y.contacts) - (x.spend ?? x.contacts));
    const t = g.campaigns.reduce(
      (acc, c) => {
        acc.clicks += c.clicks;
        acc.impressions += c.impressions;
        if (c.reach != null) acc.reach = (acc.reach ?? 0) + c.reach;
        acc.messages += c.messages;
        acc.calls += c.calls;
        acc.leads += c.leads;
        acc.contacts += c.contacts;
        acc.bookings += c.bookings;
        if (c.spend != null) acc.spend = (acc.spend ?? 0) + c.spend;
        return acc;
      },
      emptyTotals(showAdSpend),
    );
    t.campaigns = g.campaigns.length;
    t.ctr = ratio(t.clicks, t.impressions);
    t.costPerContact = t.spend != null && t.contacts > 0 ? t.spend / t.contacts : null;
    return { ...g, totals: t };
  });

  // Unassigned last, and only when it has campaigns — an empty Unassigned box is
  // noise, but a populated one must never be hidden.
  out.sort((a, b) => Number(a.segmentKey === UNASSIGNED_SEGMENT) - Number(b.segmentKey === UNASSIGNED_SEGMENT));
  let groupsFinal = out.filter((g) => g.segmentKey !== UNASSIGNED_SEGMENT || g.campaigns.length > 0);

  // The property chip filters this view exactly as it filters every other one.
  // Selecting a property and seeing both properties' campaigns is the reader
  // being told the control does nothing.
  if (selectedSegmentKey != null) {
    groupsFinal = groupsFinal.filter((g) => g.segmentKey === selectedSegmentKey);
  }

  const shownKeys = new Set(groupsFinal.map((g) => g.segmentKey));
  const dailyRows = [...daily.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, byProperty]) => ({
      date,
      // Drop series for properties that are not on screen, so the chart cannot
      // plot a line the boxes above it do not explain.
      byProperty: Object.fromEntries(
        Object.entries(byProperty).filter(([key]) => shownKeys.has(key)),
      ),
    }));

  const shownCampaignRankings = groupsFinal.flatMap((g) => g.campaigns.map((c) => c.ranking));

  return {
    spendVisible: showAdSpend,
    groups: groupsFinal,
    daily: dailyRows,
    // About what is ON SCREEN: the note explains the dashes a reader can see.
    rankingsUnavailable: shownCampaignRankings.every((r) => r == null),
  };
}

function emptyTotals(showAdSpend: boolean): MetaPropertyGroup["totals"] {
  return {
    campaigns: 0, clicks: 0, impressions: 0, reach: null,
    messages: 0, calls: 0, leads: 0, contacts: 0,
    spend: showAdSpend ? 0 : null,
    costPerContact: null, ctr: 0, bookings: 0,
  };
}
