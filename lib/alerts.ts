import "server-only";

import type { AlertType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  sendEmail,
  renderEmail,
  statTable,
  statRow,
  lead,
  p,
  esc,
} from "@/lib/email";
import { formatCurrency, formatNumber, formatPercent, formatMultiple } from "@/lib/format";
import { paidRevenueOf } from "@/lib/metrics/canonical";

// Email alerts engine. Detects four conditions across every agency (each query
// scoped by agencyId per the multi-tenancy rule), writes an Alert row for each,
// and emails the agency. Wired into the daily sync job (see /api/meta/sync) and
// triggerable manually at /api/alerts/run.
//
// RESILIENCE: nothing here throws to the caller. Every agency and every check is
// wrapped so one failure (a dead Resend, a malformed row) can never abort the
// sync job. Email outcomes are recorded on the Alert row (sent | failed |
// skipped) for the audit log at /agency/alerts.

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// Tunables.
const PERF_DROP_THRESHOLD = 0.3; // bookings down >30% week-over-week
const PERF_MIN_BASELINE = 5; // ignore tiny prior weeks (noise) — need ≥5 bookings
const SNIPPET_SILENCE_MS = 48 * 60 * 60 * 1000; // 48h of no events after going live
const TOKEN_WARN_DAYS = 14; // warn this many days before a Meta token expires

// Dedup windows: don't re-raise the same alert within this many days.
const PERF_DEDUP_DAYS = 7;
const TOKEN_DEDUP_DAYS = 7;
const WEEKLY_DEDUP_DAYS = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type AgencyCtx = { id: string; name: string; email: string };

export type RunAlertsOptions = {
  /** Restrict to these alert types (default: all). */
  only?: AlertType[];
  /** Restrict to a single agency (used for manual testing). */
  agencyId?: string;
  /** Send the weekly summary regardless of weekday (it normally runs Mondays). */
  includeWeekly?: boolean;
  /** Bypass the dedup windows so an alert always re-fires (testing). */
  force?: boolean;
  /** Override "now" (testing). */
  now?: Date;
};

export type RunAlertsResult = {
  agenciesProcessed: number;
  raised: number;
  byType: Record<string, number>;
  emailsSent: number;
  emailsFailed: number;
  emailsSkipped: number;
  errors: { agencyId: string; check: string; error: string }[];
};

// Accumulates email-delivery tallies as alerts are raised within one run.
type Tally = { sent: number; failed: number; skipped: number };

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs every enabled alert check across the selected agencies. The weekly
 * summary only runs on Mondays (UTC) unless `includeWeekly` (or `only` naming
 * it) forces it. Returns a summary; never throws.
 */
export async function runDailyAlerts(
  opts: RunAlertsOptions = {},
): Promise<RunAlertsResult> {
  const now = opts.now ?? new Date();
  const wants = (t: AlertType) => !opts.only || opts.only.includes(t);

  const result: RunAlertsResult = {
    agenciesProcessed: 0,
    raised: 0,
    byType: {},
    emailsSent: 0,
    emailsFailed: 0,
    emailsSkipped: 0,
    errors: [],
  };
  const tally: Tally = { sent: 0, failed: 0, skipped: 0 };

  const doWeekly =
    wants("weekly_summary") &&
    (opts.includeWeekly || opts.only?.includes("weekly_summary") || now.getUTCDay() === 1);

  const agencies = await prisma.agency.findMany({
    where: opts.agencyId ? { id: opts.agencyId } : undefined,
    select: { id: true, name: true, email: true },
  });

  for (const agency of agencies) {
    result.agenciesProcessed += 1;

    const checks: { name: string; run: () => Promise<number> }[] = [];
    if (wants("performance_drop"))
      checks.push({ name: "performance_drop", run: () => checkPerformanceDrop(agency, now, opts, tally) });
    if (wants("snippet_error"))
      checks.push({ name: "snippet_error", run: () => checkSnippetError(agency, now, tally) });
    if (wants("meta_token_expiry"))
      checks.push({ name: "meta_token_expiry", run: () => checkMetaTokenExpiry(agency, now, opts, tally) });
    if (doWeekly)
      checks.push({ name: "weekly_summary", run: () => checkWeeklySummary(agency, now, opts, tally) });

    for (const check of checks) {
      try {
        const n = await check.run();
        result.raised += n;
        result.byType[check.name] = (result.byType[check.name] ?? 0) + n;
      } catch (err) {
        result.errors.push({
          agencyId: agency.id,
          check: check.name,
          error: err instanceof Error ? err.message : "Unknown error.",
        });
      }
    }
  }

  result.emailsSent = tally.sent;
  result.emailsFailed = tally.failed;
  result.emailsSkipped = tally.skipped;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/** True if an alert of this type (and hotel) was raised within `days`. */
async function recentAlertExists(
  agencyId: string,
  type: AlertType,
  hotelClientId: string | null,
  days: number,
  now: Date,
): Promise<boolean> {
  const since = new Date(now.getTime() - days * DAY_MS);
  const found = await prisma.alert.findFirst({
    where: {
      agencyId,
      type,
      hotelClientId: hotelClientId ?? null,
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  return found !== null;
}

/**
 * Persists an Alert row and sends its email, recording the delivery outcome on
 * the row. Resilient: any failure is swallowed and reflected in emailStatus.
 */
async function raiseAlert(
  input: {
    agency: AgencyCtx;
    hotelClientId?: string | null;
    type: AlertType;
    severity: "info" | "warning" | "critical";
    title: string;
    message: string;
    subject: string;
    html: string;
    text: string;
  },
  tally: Tally,
): Promise<void> {
  const to = input.agency.email?.trim() || null;

  const row = await prisma.alert.create({
    data: {
      agencyId: input.agency.id,
      hotelClientId: input.hotelClientId ?? null,
      type: input.type,
      severity: input.severity,
      title: input.title,
      message: input.message,
      emailTo: to,
      emailStatus: "pending",
    },
    select: { id: true },
  });

  let status: "sent" | "failed" | "skipped" = "skipped";
  let error: string | null = null;

  if (!to) {
    error = "No agency email on file.";
  } else {
    const res = await sendEmail({
      to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    if (res.ok) {
      status = "sent";
      tally.sent += 1;
    } else if (res.skipped) {
      status = "skipped";
      error = res.error ?? "Email skipped.";
      tally.skipped += 1;
    } else {
      status = "failed";
      error = res.error ?? "Send failed.";
      tally.failed += 1;
    }
  }

  await prisma.alert.update({
    where: { id: row.id },
    data: { emailStatus: status, emailError: error },
  });
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) Performance drop — weekly bookings down >30% vs the prior week
// ─────────────────────────────────────────────────────────────────────────────

async function checkPerformanceDrop(
  agency: AgencyCtx,
  now: Date,
  opts: RunAlertsOptions,
  tally: Tally,
): Promise<number> {
  const weekAgo = new Date(now.getTime() - WEEK_MS);
  const twoWeeksAgo = new Date(now.getTime() - 2 * WEEK_MS);

  const [hotels, thisWeek, priorWeek] = await Promise.all([
    prisma.hotelClient.findMany({
      where: { agencyId: agency.id, deletedAt: null },
      select: { id: true, name: true },
    }),
    prisma.trackingEvent.groupBy({
      by: ["hotelClientId"],
      where: { agencyId: agency.id, eventType: "conversion", createdAt: { gte: weekAgo } },
      _count: { _all: true },
      _sum: { conversionValue: true },
    }),
    prisma.trackingEvent.groupBy({
      by: ["hotelClientId"],
      where: {
        agencyId: agency.id,
        eventType: "conversion",
        createdAt: { gte: twoWeeksAgo, lt: weekAgo },
      },
      _count: { _all: true },
    }),
  ]);

  const current = new Map(thisWeek.map((g) => [g.hotelClientId, g._count._all]));
  const revenue = new Map(
    thisWeek.map((g) => [g.hotelClientId, Number(g._sum.conversionValue ?? 0)]),
  );
  const prior = new Map(priorWeek.map((g) => [g.hotelClientId, g._count._all]));

  let raised = 0;
  for (const hotel of hotels) {
    const priorCount = prior.get(hotel.id) ?? 0;
    const currentCount = current.get(hotel.id) ?? 0;
    if (priorCount < PERF_MIN_BASELINE) continue;

    const dropRatio = (priorCount - currentCount) / priorCount;
    if (dropRatio <= PERF_DROP_THRESHOLD) continue;

    if (
      !opts.force &&
      (await recentAlertExists(agency.id, "performance_drop", hotel.id, PERF_DEDUP_DAYS, now))
    ) {
      continue;
    }

    const dropPct = formatPercent(dropRatio, 0);
    const message = `${hotel.name}: bookings fell ${dropPct} this week (${priorCount} → ${currentCount}) vs the prior week.`;

    await raiseAlert(
      {
        agency,
        hotelClientId: hotel.id,
        type: "performance_drop",
        severity: "critical",
        title: `Bookings dropped ${dropPct} at ${hotel.name}`,
        message,
        subject: `⚠️ Bookings down ${dropPct} at ${hotel.name}`,
        html: renderEmail({
          heading: "Bookings dropped this week",
          preheader: message,
          accent: "critical",
          bodyHtml:
            lead(
              `Bookings at <strong>${esc(hotel.name)}</strong> are down <strong>${dropPct}</strong> compared with the previous week.`,
            ) +
            statTable(
              statRow("Bookings this week", formatNumber(currentCount)) +
                statRow("Bookings last week", formatNumber(priorCount)) +
                statRow("Change", `−${dropPct}`) +
                statRow("Revenue this week", formatCurrency(revenue.get(hotel.id) ?? 0)),
            ) +
            p("It's worth checking whether a campaign ended, a link broke, or tracking stopped firing."),
          cta: { label: "Open hotel dashboard", url: `${APP_URL}/agency/hotel/${hotel.id}` },
        }),
        text: message,
      },
      tally,
    );
    raised += 1;
  }
  return raised;
}

// ─────────────────────────────────────────────────────────────────────────────
// (2) Snippet error — a live hotel sent no events for 48h+
// ─────────────────────────────────────────────────────────────────────────────

async function checkSnippetError(
  agency: AgencyCtx,
  now: Date,
  tally: Tally,
): Promise<number> {
  const cutoff = new Date(now.getTime() - SNIPPET_SILENCE_MS);

  // Was live and previously sending, but has gone quiet for 48h+. Flipping the
  // status to "error" below is also the natural dedup — it no longer matches.
  const silent = await prisma.hotelClient.findMany({
    where: {
      agencyId: agency.id,
      deletedAt: null,
      snippetStatus: "live",
      lastEventAt: { not: null, lt: cutoff },
    },
    select: { id: true, name: true, websiteUrl: true, lastEventAt: true },
  });

  let raised = 0;
  for (const hotel of silent) {
    await prisma.hotelClient.update({
      where: { id: hotel.id },
      data: { snippetStatus: "error" },
    });

    const lastSeen = hotel.lastEventAt ? fmtDate(hotel.lastEventAt) : "unknown";
    const message = `${hotel.name}: no tracking events for 48h+ — snippet flagged as error (last event ${lastSeen}).`;

    await raiseAlert(
      {
        agency,
        hotelClientId: hotel.id,
        type: "snippet_error",
        severity: "critical",
        title: `Tracking stopped at ${hotel.name}`,
        message,
        subject: `🚨 Tracking may be broken at ${hotel.name}`,
        html: renderEmail({
          heading: "Tracking has gone quiet",
          preheader: message,
          accent: "critical",
          bodyHtml:
            lead(
              `We haven't received any tracking events from <strong>${esc(hotel.name)}</strong> in over 48 hours.`,
            ) +
            statTable(
              statRow("Last event seen", lastSeen) +
                statRow("Website", hotel.websiteUrl) +
                statRow("Snippet status", "Error"),
            ) +
            p(
              "This usually means the tracking snippet was removed, a site deploy dropped it, or the page changed. Re-check the install to keep attribution flowing.",
            ),
          cta: { label: "Check integrations", url: `${APP_URL}/agency/hotel/${hotel.id}/integrations` },
        }),
        text: message,
      },
      tally,
    );
    raised += 1;
  }
  return raised;
}

// ─────────────────────────────────────────────────────────────────────────────
// (3) Meta token expiry — warn 14 days out
// ─────────────────────────────────────────────────────────────────────────────

async function checkMetaTokenExpiry(
  agency: AgencyCtx,
  now: Date,
  opts: RunAlertsOptions,
  tally: Tally,
): Promise<number> {
  const horizon = new Date(now.getTime() + TOKEN_WARN_DAYS * DAY_MS);

  // Non-expiring tokens use a year-2999 sentinel, so `lte: horizon` excludes them.
  const tokens = await prisma.metaToken.findMany({
    where: {
      agencyId: agency.id,
      status: "connected",
      tokenExpiresAt: { gt: now, lte: horizon },
    },
    select: { id: true, tokenExpiresAt: true },
  });
  if (tokens.length === 0) return 0;

  if (
    !opts.force &&
    (await recentAlertExists(agency.id, "meta_token_expiry", null, TOKEN_DEDUP_DAYS, now))
  ) {
    return 0;
  }

  // One connection per agency — alert on the soonest expiry.
  const soonest = tokens.reduce((a, b) =>
    a.tokenExpiresAt < b.tokenExpiresAt ? a : b,
  );
  const daysLeft = Math.max(
    0,
    Math.ceil((soonest.tokenExpiresAt.getTime() - now.getTime()) / DAY_MS),
  );
  const message = `Your Meta connection expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (on ${fmtDate(soonest.tokenExpiresAt)}). Reconnect to keep ad ROI syncing.`;

  await raiseAlert(
    {
      agency,
      hotelClientId: null,
      type: "meta_token_expiry",
      severity: daysLeft <= 3 ? "critical" : "warning",
      title: `Meta token expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
      message,
      subject: `Action needed: your Meta connection expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
      html: renderEmail({
        heading: "Meta connection expiring soon",
        preheader: message,
        accent: daysLeft <= 3 ? "critical" : "warning",
        bodyHtml:
          lead(
            `Your Meta access token will expire in <strong>${daysLeft} day${daysLeft === 1 ? "" : "s"}</strong>.`,
          ) +
          statTable(
            statRow("Expires on", fmtDate(soonest.tokenExpiresAt)) +
              statRow("Days remaining", String(daysLeft)),
          ) +
          p(
            "When it expires, ad-spend and ROI syncing will stop until you paste a fresh token. Reconnecting now avoids any gap in your ad reporting.",
          ),
        cta: { label: "Reconnect Meta", url: `${APP_URL}/agency/settings` },
      }),
      text: message,
    },
    tally,
  );
  return 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// (4) Weekly summary — digest of every hotel's last-7-days performance
// ─────────────────────────────────────────────────────────────────────────────

async function checkWeeklySummary(
  agency: AgencyCtx,
  now: Date,
  opts: RunAlertsOptions,
  tally: Tally,
): Promise<number> {
  if (
    !opts.force &&
    (await recentAlertExists(agency.id, "weekly_summary", null, WEEKLY_DEDUP_DAYS, now))
  ) {
    return 0;
  }

  const weekAgo = new Date(now.getTime() - WEEK_MS);
  const twoWeeksAgo = new Date(now.getTime() - 2 * WEEK_MS);

  const [hotels, eventsThis, bookingsPrior, spendThis, googleSpendThis, conversionRows] =
    await Promise.all([
    prisma.hotelClient.findMany({
      where: { agencyId: agency.id, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    }),
    prisma.trackingEvent.groupBy({
      by: ["hotelClientId", "eventType"],
      where: { agencyId: agency.id, createdAt: { gte: weekAgo } },
      _count: { _all: true },
      _sum: { conversionValue: true },
    }),
    prisma.trackingEvent.groupBy({
      by: ["hotelClientId"],
      where: {
        agencyId: agency.id,
        eventType: "conversion",
        createdAt: { gte: twoWeeksAgo, lt: weekAgo },
      },
      _count: { _all: true },
    }),
    prisma.adSnapshot.groupBy({
      by: ["hotelClientId"],
      where: { agencyId: agency.id, archived: false, date: { gte: weekAgo } },
      _sum: { spend: true },
    }),
    // Phase 0: Google Ads spend, previously missing entirely from this email.
    prisma.googleAdsCampaignSnapshot.groupBy({
      by: ["hotelClientId"],
      where: { agencyId: agency.id, date: { gte: weekAgo } },
      _sum: { spend: true },
    }),
    // Phase 0: row-level conversions so the summary's ROAS can use PAID revenue.
    // The groupBy above can't classify by source, and the email previously
    // divided ALL booking revenue by Meta-only spend and called it ROAS.
    prisma.trackingEvent.findMany({
      where: { agencyId: agency.id, eventType: "conversion", createdAt: { gte: weekAgo } },
      // hotelClientId so soft-deleted hotels can be excluded, matching `rows`.
      select: {
        hotelClientId: true,
        utmSource: true,
        utmMedium: true,
        utmContent: true,
        gclid: true, gbraid: true, wbraid: true, fbclid: true,
        conversionValue: true,
      },
    }),
  ]);

  if (hotels.length === 0) return 0;

  type Row = { name: string; visits: number; bookings: number; revenue: number; priorBookings: number };
  const rows = new Map<string, Row>(
    hotels.map((h) => [h.id, { name: h.name, visits: 0, bookings: 0, revenue: 0, priorBookings: 0 }]),
  );

  for (const g of eventsThis) {
    const r = rows.get(g.hotelClientId);
    if (!r) continue;
    if (g.eventType === "visit") {
      r.visits = g._count._all;
    } else {
      r.bookings = g._count._all;
      r.revenue = Number(g._sum.conversionValue ?? 0);
    }
  }
  for (const g of bookingsPrior) {
    const r = rows.get(g.hotelClientId);
    if (r) r.priorBookings = g._count._all;
  }
  // Combined paid spend per hotel: Meta + Google — restricted to the SAME hotel
  // population as `rows` (agency, non-soft-deleted). `hotels` is already filtered
  // on deletedAt: null, but the spend groupBys are agency-wide, so a soft-deleted
  // hotel's spend would otherwise land in totalSpend while its bookings never
  // reach totals.revenue (they're dropped by the `if (!r) continue` above).
  const activeHotelIds = new Set(hotels.map((h) => h.id));
  const spendMap = new Map<string, number>();
  for (const g of [...spendThis, ...googleSpendThis]) {
    if (!activeHotelIds.has(g.hotelClientId)) continue;
    spendMap.set(g.hotelClientId, (spendMap.get(g.hotelClientId) ?? 0) + Number(g._sum.spend ?? 0));
  }

  const list = [...rows.values()];
  const totals = list.reduce(
    (acc, r) => ({
      visits: acc.visits + r.visits,
      bookings: acc.bookings + r.bookings,
      revenue: acc.revenue + r.revenue,
    }),
    { visits: 0, bookings: 0, revenue: 0 },
  );
  const totalSpend = [...spendMap.values()].reduce((a, b) => a + b, 0);
  // Phase 0: PAID revenue ÷ paid spend. Was totals.revenue (every channel,
  // including direct and organic) ÷ Meta-only spend — emailed weekly as "ROAS".
  const paidRevenue = paidRevenueOf(
    conversionRows
      .filter((c) => activeHotelIds.has(c.hotelClientId))
      .map((c) => ({ ...c, value: c.conversionValue == null ? 0 : Number(c.conversionValue) })),
  );
  const roas = totalSpend > 0 ? paidRevenue / totalSpend : null;

  const hotelRowsHtml = list
    .map((r) => {
      const delta = r.bookings - r.priorBookings;
      const trend =
        delta > 0
          ? `<span style="color:#16a34a;">▲ ${delta}</span>`
          : delta < 0
            ? `<span style="color:#dc2626;">▼ ${Math.abs(delta)}</span>`
            : `<span style="color:#a1a1aa;">—</span>`;
      return `<tr>
        <td style="padding:8px 0;font-size:13px;color:#18181b;border-bottom:1px solid #f4f4f5;">${esc(r.name)}</td>
        <td style="padding:8px 0;font-size:13px;color:#3f3f46;text-align:right;border-bottom:1px solid #f4f4f5;">${formatNumber(r.visits)}</td>
        <td style="padding:8px 0;font-size:13px;color:#18181b;font-weight:600;text-align:right;border-bottom:1px solid #f4f4f5;">${formatNumber(r.bookings)} ${trend}</td>
        <td style="padding:8px 0;font-size:13px;color:#18181b;font-weight:600;text-align:right;border-bottom:1px solid #f4f4f5;">${esc(formatCurrency(r.revenue))}</td>
      </tr>`;
    })
    .join("");

  const hotelTable = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 16px;">
    <tr>
      <td style="padding:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#a1a1aa;">Hotel</td>
      <td style="padding:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#a1a1aa;text-align:right;">Visits</td>
      <td style="padding:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#a1a1aa;text-align:right;">Bookings</td>
      <td style="padding:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#a1a1aa;text-align:right;">Revenue</td>
    </tr>
    ${hotelRowsHtml}
  </table>`;

  const message = `Weekly summary: ${formatNumber(totals.bookings)} bookings and ${formatCurrency(totals.revenue)} revenue across ${list.length} hotel${list.length === 1 ? "" : "s"} (last 7 days).`;

  await raiseAlert(
    {
      agency,
      hotelClientId: null,
      type: "weekly_summary",
      severity: "info",
      title: "Weekly performance summary",
      message,
      subject: `Your HotelTrack weekly summary — ${formatNumber(totals.bookings)} bookings`,
      html: renderEmail({
        heading: "Your weekly performance summary",
        preheader: message,
        accent: "info",
        bodyHtml:
          lead(
            `Here's how your ${list.length} hotel${list.length === 1 ? "" : "s"} performed over the last 7 days.`,
          ) +
          statTable(
            statRow("Visits", formatNumber(totals.visits)) +
              statRow("Bookings", formatNumber(totals.bookings)) +
              statRow("Revenue", formatCurrency(totals.revenue)) +
              statRow("Ad spend", formatCurrency(totalSpend)) +
              statRow("ROAS", formatMultiple(roas)),
          ) +
          `<div style="margin:18px 0 6px;font-size:13px;font-weight:700;color:#18181b;">By hotel</div>` +
          hotelTable,
        cta: { label: "Open dashboard", url: `${APP_URL}/agency/dashboard` },
      }),
      text: message,
    },
    tally,
  );
  return 1;
}
