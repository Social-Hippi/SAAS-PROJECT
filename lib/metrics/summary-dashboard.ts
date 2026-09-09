import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { previousRangeOf, type ResolvedRange } from "@/lib/attribution";
import {
  loadAttributionHealth,
  type AttributionHealth,
} from "@/lib/metrics/attribution-health";
import {
  loadIntentMetrics,
  loadLastIntent,
  type IntentMetrics,
  type LastIntentRow,
} from "@/lib/metrics/intent";
import {
  ok,
  notTraceable,
  percentChange,
  ratio,
  type MetricValue,
} from "@/lib/metrics/metric-value";

// ─────────────────────────────────────────────────────────────────────────────
// The Summary view's aggregation service.
//
// One server-side call assembles the whole picture — intent, attribution health,
// the funnel and the period-over-period comparison — so the browser never
// recomputes analytics and no screen can drift from another by loading a
// different slice of the same data.
//
// Everything here is expressed as MetricValue. That is the point: the funnel
// stage a hotel has not instrumented renders "Tracking unavailable" rather than
// a zero that would tell an owner their visitors never showed intent.
// ─────────────────────────────────────────────────────────────────────────────

/** One step of the customer journey, with an honest measurement state. */
export type FunnelStage = {
  key: string;
  label: string;
  value: MetricValue<number>;
  /** Share of the stage above it, when both are known. */
  conversionFromPrevious: MetricValue<number>;
  hint: string;
};

export type IntentComparison = {
  label: string;
  current: MetricValue<number>;
  previous: MetricValue<number>;
  change: MetricValue<number>;
};

export type SummaryDashboard = {
  range: { since: Date; until: Date; label: string };
  previous: { since: Date; until: Date };
  intent: IntentMetrics;
  previousIntent: IntentMetrics;
  /** The interaction table: current vs previous vs change, per signal. */
  comparisons: IntentComparison[];
  attribution: AttributionHealth;
  funnel: FunnelStage[];
  lastIntent: LastIntentRow[];
  /** Unique visitors, split out because several panels lead with it. */
  uniqueVisitors: MetricValue<number>;
  engagedVisitors: MetricValue<number>;
};

/**
 * A visit counts as ENGAGED when it went beyond a single page or lingered.
 *
 * Deliberately derived from HotelTrack's own Session rows rather than GA4's
 * `engagedSessions`: the rest of this funnel is snippet-measured, and mixing two
 * populations would make the stage-to-stage conversion rates meaningless even
 * though every individual number would be defensible.
 */
const ENGAGED_MIN_PAGEVIEWS = 2;
const ENGAGED_MIN_MS = 15_000;

async function loadVisitors(
  hotelClientId: string,
  range: { since: Date; until: Date },
): Promise<{ unique: MetricValue<number>; engaged: MetricValue<number> }> {
  const sessions = await agencyScoped(prisma.session).findMany({
    where: { hotelClientId, startedAt: { gte: range.since, lte: range.until } },
    select: { visitorId: true, pageViewCount: true, totalTimeMs: true },
  });

  const unique = new Set(sessions.map((s) => s.visitorId));
  const engaged = new Set(
    sessions
      .filter(
        (s) => s.pageViewCount >= ENGAGED_MIN_PAGEVIEWS || s.totalTimeMs >= ENGAGED_MIN_MS,
      )
      .map((s) => s.visitorId),
  );

  return { unique: ok(unique.size), engaged: ok(engaged.size) };
}

export async function loadSummaryDashboard(
  hotelClientId: string,
  range: ResolvedRange,
): Promise<SummaryDashboard> {
  const previous = previousRangeOf(range);

  const [visitors, prevVisitors, intent, previousIntent, attribution, lastIntent] =
    await Promise.all([
      loadVisitors(hotelClientId, range),
      loadVisitors(hotelClientId, previous),
      loadIntentMetrics(hotelClientId, range),
      loadIntentMetrics(hotelClientId, previous),
      loadAttributionHealth(hotelClientId, range),
      loadLastIntent(hotelClientId, range),
    ]);

  // ── The interaction table ────────────────────────────────────────────────
  const comparisons: IntentComparison[] = [
    {
      label: "Unique visitors",
      current: visitors.unique,
      previous: prevVisitors.unique,
      change: percentChange(visitors.unique, prevVisitors.unique),
    },
    {
      label: "Engaged visitors",
      current: visitors.engaged,
      previous: prevVisitors.engaged,
      change: percentChange(visitors.engaged, prevVisitors.engaged),
    },
    {
      label: "Booking intent",
      current: intent.bookingIntent,
      previous: previousIntent.bookingIntent,
      change: percentChange(intent.bookingIntent, previousIntent.bookingIntent),
    },
    {
      label: "Enquiry intent",
      current: intent.enquiryIntent,
      previous: previousIntent.enquiryIntent,
      change: percentChange(intent.enquiryIntent, previousIntent.enquiryIntent),
    },
    {
      label: "Calls",
      current: intent.calls,
      previous: previousIntent.calls,
      change: percentChange(intent.calls, previousIntent.calls),
    },
    {
      label: "WhatsApp",
      current: intent.whatsapp,
      previous: previousIntent.whatsapp,
      change: percentChange(intent.whatsapp, previousIntent.whatsapp),
    },
    {
      label: "Instagram messages",
      current: intent.instagramMessages,
      previous: previousIntent.instagramMessages,
      change: percentChange(intent.instagramMessages, previousIntent.instagramMessages),
    },
  ];

  // ── The funnel ───────────────────────────────────────────────────────────
  // Direct contacts are the one composite: a call and a WhatsApp message are the
  // same step of the journey from the owner's point of view, and either being
  // untracked makes the STEP unmeasurable rather than smaller — which is exactly
  // what sum() enforces.
  const directContact: MetricValue<number> =
    intent.calls.state === "ok" && intent.whatsapp.state === "ok"
      ? ok(intent.calls.value + intent.whatsapp.value)
      : intent.calls.state !== "ok"
        ? intent.calls
        : intent.whatsapp;

  const anyIntent: MetricValue<number> =
    intent.bookingIntent.state === "ok" && intent.enquiryIntent.state === "ok"
      ? ok(intent.bookingIntent.value + intent.enquiryIntent.value)
      : intent.bookingIntent.state !== "ok"
        ? intent.bookingIntent
        : intent.enquiryIntent;

  const stages: Omit<FunnelStage, "conversionFromPrevious">[] = [
    {
      key: "visitors",
      label: "Visitors",
      value: visitors.unique,
      hint: "People who reached your website in this period.",
    },
    {
      key: "engaged",
      label: "Engaged visitors",
      value: visitors.engaged,
      hint: "Visitors who viewed more than one page or stayed at least 15 seconds.",
    },
    {
      key: "intent",
      label: "Booking / enquiry intent",
      value: anyIntent,
      hint: "Visits that reached a booking or enquiry step on your site.",
    },
    {
      key: "contact",
      label: "Calls / WhatsApp",
      value: directContact,
      hint: "Direct contacts started from your website.",
    },
    {
      key: "bookings",
      label: "Bookings",
      value: attribution.totalBookings,
      hint: "Confirmed reservations received from your booking system.",
    },
    {
      key: "revenue",
      label: "Revenue",
      value: attribution.totalRevenue,
      hint: "Value of those reservations, as reported by your booking system.",
    },
  ];

  const funnel: FunnelStage[] = stages.map((stage, i) => {
    const above = i === 0 ? null : stages[i - 1].value;
    return {
      ...stage,
      conversionFromPrevious:
        above == null
          ? notTraceable("This is the first step, so there is nothing above it to compare with.")
          : // Revenue is money, not people: a "conversion rate" from bookings to
            // revenue would be a currency amount expressed as a percentage.
            stage.key === "revenue"
            ? notTraceable("Revenue is an amount, not a count, so no rate applies here.")
            : ratio(stage.value, above),
    };
  });

  return {
    range: { since: range.since, until: range.until, label: range.label },
    previous,
    intent,
    previousIntent,
    comparisons,
    attribution,
    funnel,
    lastIntent,
    uniqueVisitors: visitors.unique,
    engagedVisitors: visitors.engaged,
  };
}
