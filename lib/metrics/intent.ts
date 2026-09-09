import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { SOURCE_TYPE_LABEL, classifySourceType } from "@/lib/source-classifier";
import {
  ok,
  notTraceable,
  notApplicable,
  ratio,
  type MetricValue,
} from "@/lib/metrics/metric-value";

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER INTENT — the middle of the funnel, which is where hotels actually
// live. A hotel owner does not experience "clicks then bookings"; they
// experience phone calls, WhatsApp messages and enquiry forms.
//
// WHAT THE SNIPPET ACTUALLY GIVES US, having read scripts/snippet.src.js:
//
//   StageReached  awareness → consideration → intent → booking, declared by the
//                 hotel's own markup via [data-ht-stage]. Fires at most once per
//                 stage per session, and only when the session reaches a HIGHER
//                 stage than before.
//   ClickEvent    one row per click on a [data-ht-click]-tagged element. The
//                 target is a FREE-FORM string the hotel chose.
//
// There is no automatic tel: or wa.me detection in the snippet today. So calls
// and WhatsApp are visible ONLY where a hotel tagged those links by hand.
//
// THE CONSEQUENCE, and the whole reason this file is careful: for a hotel that
// never tagged its phone link, "calls this period" is not zero — it is unknown.
// Reporting 0 would tell an owner their advertising produced no phone enquiries
// when in truth we simply never watched the phone. So before reporting a zero we
// ask whether this hotel has EVER produced a matching click. If it has, a zero
// this period is real and we say 0. If it never has, we say "Not traceable" and
// tell them what to tag.
//
// The patterns below are deliberately conservative. A false positive here
// invents intent that did not happen, which is worse than under-counting: an
// un-matched target simply lands in the generic buckets rather than being
// guessed into "call".
// ─────────────────────────────────────────────────────────────────────────────

const CALL_PATTERN = /(^|[-_.])(call|phone|tel|dial|mobile)([-_.]|$)|call[-_]?now|click[-_]?to[-_]?call/i;
const WHATSAPP_PATTERN = /whats[-_]?app|(^|[-_.])wa([-_.]|$)|wa[-_]?me/i;
const BOOKING_PATTERN =
  /book|reserv|availabilit|check[-_]?in|check[-_]?out|room[-_]?rate|stay[-_]?now|ibe|booking[-_]?engine/i;
const ENQUIRY_PATTERN = /enquir|inquir|contact|request|quote|callback|get[-_]?in[-_]?touch/i;

/** The interaction kinds this dashboard reports on. */
export const INTENT_KINDS = [
  "booking_intent",
  "enquiry_intent",
  "call",
  "whatsapp",
  "instagram_message",
] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

export const INTENT_LABEL: Record<IntentKind, string> = {
  booking_intent: "Booking intent",
  enquiry_intent: "Enquiry intent",
  call: "Calls",
  whatsapp: "WhatsApp",
  instagram_message: "Instagram messages",
};

/** Classify one free-form click target. Null when it is not an intent signal. */
export function classifyClickTarget(target: string): IntentKind | null {
  // Order matters: a "whatsapp-enquiry" button is a WhatsApp conversation first
  // and an enquiry second, and a "call-to-book" is a phone call, not a booking.
  if (WHATSAPP_PATTERN.test(target)) return "whatsapp";
  if (CALL_PATTERN.test(target)) return "call";
  if (BOOKING_PATTERN.test(target)) return "booking_intent";
  if (ENQUIRY_PATTERN.test(target)) return "enquiry_intent";
  return null;
}

export type IntentMetrics = {
  propertyVisitors: MetricValue<number>;
  bookingIntent: MetricValue<number>;
  enquiryIntent: MetricValue<number>;
  calls: MetricValue<number>;
  whatsapp: MetricValue<number>;
  instagramMessages: MetricValue<number>;
  /** Share of visitors who showed any intent. */
  intentRate: MetricValue<number>;
};

/**
 * Instagram direct messages are not available from the Instagram API this app
 * is authorised for.
 *
 * The IGAA ("Instagram API with Instagram Login") flow used by lib/instagram.ts
 * exposes account and media insights only. Message counts require the Messaging
 * permissions and a webhook subscription that HotelTrack neither requests nor
 * holds. This is a permanent limitation of the integration, not a gap that more
 * tracking would fill — so it is stated once, here, and rendered honestly.
 */
const INSTAGRAM_DM_REASON =
  "Instagram does not share message counts with connected analytics tools, so we cannot report this.";

const CALL_SETUP_HINT =
  "Phone-call tracking is not set up on this website yet. Tagging the phone link lets us count calls that came from your marketing.";
const WHATSAPP_SETUP_HINT =
  "WhatsApp tracking is not set up on this website yet. Tagging the WhatsApp link lets us count conversations that came from your marketing.";
const STAGE_SETUP_HINT =
  "This website does not yet tell us which pages represent booking or enquiry steps, so we cannot measure intent.";

/**
 * Customer intent for one hotel over a window.
 *
 * `everSeen*` flags come from unbounded existence checks rather than the window,
 * which is what separates "no calls this week" from "we have never been able to
 * see calls". Both are single indexed lookups.
 */
export async function loadIntentMetrics(
  hotelClientId: string,
  range: { since: Date; until: Date },
): Promise<IntentMetrics> {
  const [sessions, clicks, stages, everClick, everStage] = await Promise.all([
    agencyScoped(prisma.session).findMany({
      where: { hotelClientId, startedAt: { gte: range.since, lte: range.until } },
      select: { visitorId: true },
    }),
    agencyScoped(prisma.clickEvent).findMany({
      where: { hotelClientId, occurredAt: { gte: range.since, lte: range.until } },
      select: { clickTarget: true, sessionId: true },
    }),
    agencyScoped(prisma.stageReached).findMany({
      where: { hotelClientId, reachedAt: { gte: range.since, lte: range.until } },
      select: { stage: true, sessionId: true },
    }),
    // Has this hotel EVER produced a tagged click? Decides 0 vs "not traceable".
    agencyScoped(prisma.clickEvent).findMany({
      where: { hotelClientId },
      select: { clickTarget: true },
      distinct: ["clickTarget"],
      take: 200,
    }),
    agencyScoped(prisma.stageReached).findFirst({
      where: { hotelClientId },
      select: { id: true },
    }),
  ]);

  const visitors = new Set(sessions.map((s) => s.visitorId));

  // Which intent kinds this hotel is instrumented for at all.
  const everKinds = new Set<IntentKind>();
  for (const c of everClick) {
    const kind = classifyClickTarget(c.clickTarget);
    if (kind) everKinds.add(kind);
  }

  const counts: Record<IntentKind, number> = {
    booking_intent: 0,
    enquiry_intent: 0,
    call: 0,
    whatsapp: 0,
    instagram_message: 0,
  };
  const intentSessions = new Set<string>();

  for (const c of clicks) {
    const kind = classifyClickTarget(c.clickTarget);
    if (!kind) continue;
    counts[kind] += 1;
    intentSessions.add(c.sessionId);
  }

  // Declared funnel stages are the other booking/enquiry-intent signal, and the
  // more reliable one where a hotel has marked its pages up.
  for (const s of stages) {
    if (s.stage === "booking") {
      counts.booking_intent += 1;
      intentSessions.add(s.sessionId);
    } else if (s.stage === "intent") {
      counts.enquiry_intent += 1;
      intentSessions.add(s.sessionId);
    }
  }

  const stageInstrumented = Boolean(everStage);

  /** 0 only when we can see this kind at all; otherwise say so. */
  const measured = (
    kind: IntentKind,
    alsoInstrumented: boolean,
    hint: string,
  ): MetricValue<number> =>
    everKinds.has(kind) || alsoInstrumented ? ok(counts[kind]) : notTraceable(hint);

  const visitorCount = visitors.size;

  return {
    propertyVisitors: ok(visitorCount),
    bookingIntent: measured("booking_intent", stageInstrumented, STAGE_SETUP_HINT),
    enquiryIntent: measured("enquiry_intent", stageInstrumented, STAGE_SETUP_HINT),
    calls: measured("call", false, CALL_SETUP_HINT),
    whatsapp: measured("whatsapp", false, WHATSAPP_SETUP_HINT),
    instagramMessages: notTraceable(INSTAGRAM_DM_REASON),
    intentRate:
      visitorCount === 0
        ? notApplicable("There were no visitors in this period, so there is no rate to calculate.")
        : ratio(ok(intentSessions.size), ok(visitorCount)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LAST INTENT
//
// When a booking cannot be tied to a campaign, the journey that led up to it is
// usually still visible. Throwing that away because the final hop is missing
// discards the most useful thing we know.
//
// So: for sessions that reached a high-intent moment, report WHAT the last
// high-intent action was and WHICH source brought that session. This is
// explicitly NOT a booking attribution and must never be counted as one — it is
// "here is where your interested visitors came from and what they did last".
// ─────────────────────────────────────────────────────────────────────────────

export type LastIntentRow = {
  /** The last high-intent action, e.g. "WhatsApp". */
  intent: string;
  /** Where that session came from, e.g. "Meta Ads". */
  source: string;
  sessions: number;
};

export async function loadLastIntent(
  hotelClientId: string,
  range: { since: Date; until: Date },
  limit = 8,
): Promise<LastIntentRow[]> {
  const clicks = await agencyScoped(prisma.clickEvent).findMany({
    where: { hotelClientId, occurredAt: { gte: range.since, lte: range.until } },
    orderBy: { occurredAt: "asc" },
    select: { sessionId: true, clickTarget: true },
  });

  // Last matching intent action per session (ascending order → last write wins).
  const lastBySession = new Map<string, IntentKind>();
  for (const c of clicks) {
    const kind = classifyClickTarget(c.clickTarget);
    if (kind) lastBySession.set(c.sessionId, kind);
  }
  if (lastBySession.size === 0) return [];

  const sessions = await agencyScoped(prisma.session).findMany({
    where: { hotelClientId, id: { in: [...lastBySession.keys()] } },
    select: {
      id: true,
      utmSource: true,
      utmMedium: true,
      gclid: true,
      gbraid: true,
      wbraid: true,
      fbclid: true,
    },
  });

  const tally = new Map<string, LastIntentRow>();
  for (const s of sessions) {
    const kind = lastBySession.get(s.id);
    if (!kind) continue;
    // The SAME classifier the rest of the app uses, so "Meta Ads" means the same
    // thing here as it does in revenue and ROAS. classifySourceType (rather than
    // canonicalSourceType) because a Session carries no conversion value.
    const sourceType = classifySourceType({
      utmSource: s.utmSource,
      utmMedium: s.utmMedium,
      gclid: s.gclid,
      gbraid: s.gbraid,
      wbraid: s.wbraid,
      fbclid: s.fbclid,
    });
    const key = `${kind}|${sourceType}`;
    const row = tally.get(key) ?? {
      intent: INTENT_LABEL[kind],
      source: SOURCE_TYPE_LABEL[sourceType] ?? sourceType,
      sessions: 0,
    };
    row.sessions += 1;
    tally.set(key, row);
  }

  return [...tally.values()].sort((a, b) => b.sessions - a.sessions).slice(0, limit);
}
