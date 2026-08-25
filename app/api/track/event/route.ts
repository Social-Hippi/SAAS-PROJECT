import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, clientIpFromHeaders } from "@/lib/rate-limit";
import { rateLimit } from "@/lib/ratelimit";
import { saltedHash } from "@/lib/pii";
import { cleanCode, isCouponRedeemable, couponRejectReason } from "@/lib/coupon";
import { CLICK_ID_KEYS, parseClickIds, type ClickIds } from "@/lib/click-ids";
import {
  isFunnelStage,
  parseFunnelRules,
  resolveStageFromRules,
  stageRank,
  type FunnelStage,
} from "@/lib/funnel";

// Public ingestion endpoint for the tracking snippet. Handles these event types:
//
//   visit              — legacy v1 page visit → one TrackingEvent (back-compat).
//   pageview           — v2 page load → a TrackingEvent visit (so existing
//                        dashboards keep working) PLUS Session/PageView journey
//                        rows. v2.1 also carries funnelStage (else server matches).
//   page_exit          — v2 page leave → closes the open PageView with time.
//   stage_reached      — v2.1 funnel: session reached a new highest funnel stage.
//   conversion         — booking → TrackingEvent conversion + multi-touch rows.
//   click              — v2.2: a [data-ht-click] element was clicked → ClickEvent.
//   form_field_focused — v2.2: a [data-ht-form-field] field was focused.
//   form_field_blurred — v2.2: a tagged field was blurred (hasValue only).
//   identify           — v2.2: visitor self-identified → upsert VisitorIdentity
//                        with the CLIENT-hashed email/phone (raw never reaches us).
//
// Events arrive via navigator.sendBeacon as text/plain (no CORS preflight). We
// resolve the public siteId to a hotel (+ agencyId) and store ONLY UTM + page
// data and (for identify) a SALTED hash of already-client-hashed PII — never raw
// personal data. Fast + resilient: validates input, never throws.

// Primary flood guards (per-site+IP for visit/conversion; per-visitor for
// journey events) live in lib/ratelimit POLICIES.trackEvent / .trackJourney and
// run on Upstash Redis so they hold across Vercel instances.
//
// Fine per-SESSION caps (Part 3): beyond these, click/form events drop silently.
// Enforced over the session-idle window so one session's events count together.
const CLICK_CAP_PER_SESSION = 50;
const FORM_CAP_PER_SESSION = 100;
const SESSION_CAP_WINDOW_MS = 30 * 60_000;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  // Ingestion responses must never be cached by browsers/CDNs (every POST is a
  // distinct event). Applies to all replies via reply() + the manual 429 path.
  "Cache-Control": "no-store",
};

function reply(status: number, body?: unknown) {
  return body === undefined
    ? new Response(null, { status, headers: CORS })
    : Response.json(body, { status, headers: CORS });
}

export async function OPTIONS() {
  return reply(204);
}

// ── Validation helpers ───────────────────────────────────────────────────────

// Coerce to a bounded, clean string. Defense in depth for spreadsheet-formula /
// CSV injection (audit H-1): strip ASCII control chars and cap length.
function str(v: unknown): string | null {
  if (typeof v !== "string" || !v.length) return null;
  const cleaned = Array.from(v)
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
    .join("")
    .slice(0, 512);
  return cleaned.length ? cleaned : null;
}

// Strip PII from a stored URL (audit P-1/P-2). Full hrefs/referrers/landing
// pages routinely carry query strings with emails, booking refs, and sometimes
// session/payment tokens — we only need origin + path for attribution/display.
// Drops ?query and #hash; keeps host + pathname. UTM attribution is unaffected
// (UTMs arrive as their own fields, not parsed from the URL here).
function urlPathOnly(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return (u.origin + u.pathname).slice(0, 512);
  } catch {
    // Not an absolute URL (e.g. a bare path) — strip any ?query / #hash manually.
    const bare = s.split(/[?#]/)[0]!;
    return bare.length ? bare : null;
  }
}

// Upper bound for a single booking's conversion value (audit: unbounded revenue
// injection). The column is Decimal(12,2); a real hotel booking is far below
// this. A value over the cap is dropped (event still records, just no revenue)
// so a known siteId can't poison a hotel's revenue KPIs with one request.
const MAX_CONVERSION_VALUE = 10_000_000; // ₹1,00,00,000

// 'sess_' + uuid (36 chars incl hyphens).
const isSessionId = (v: unknown): v is string =>
  typeof v === "string" && /^sess_[0-9a-fA-F-]{36}$/.test(v);
// 'vis_' + uuid OR a legacy id seeded from _ht_vid — lenient charset.
const isVisitorId = (v: unknown): v is string =>
  typeof v === "string" && /^vis_[\w-]{6,64}$/.test(v);

// A page path: non-empty, starts with '/', <= 500 chars, control chars stripped.
function pagePathOf(v: unknown): string | null {
  const s = str(v);
  if (!s || s[0] !== "/" || s.length > 500) return null;
  return s;
}

/**
 * The click identifiers that are actually PRESENT, as a partial update object.
 *
 * Prisma treats an explicit `null` as "set this column to NULL", so spreading a
 * fully-populated ClickIds into an UPDATE would erase the identifier the session
 * landed with on the very next un-tagged pageview. Dropping the null keys makes
 * the write add-only, which is the Phase 1A persistence contract.
 */
function presentClickIds(ids: ClickIds): ClickIds {
  const out: ClickIds = {};
  for (const key of CLICK_ID_KEYS) {
    if (ids[key]) out[key] = ids[key];
  }
  return out;
}

// A non-negative int within a sane bound (viewport dims), else null.
function intOf(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < 100_000 ? n : null;
}

// Event timestamp must be recent — within the last 5 minutes (replay guard) and
// not meaningfully in the future. Returns the Date, or null when out of window.
function recentTs(v: unknown): Date | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const now = Date.now();
  if (n > now + 60_000) return null; // > 1 min ahead
  if (n < now - 5 * 60_000) return null; // > 5 min stale
  return new Date(n);
}

type Hotel = {
  id: string;
  agencyId: string;
  snippetStatus: string;
  deletedAt: Date | null;
  funnelStageRules: Prisma.JsonValue;
};

// The interactive-transaction client type for our EXTENDED Prisma client (the
// scrub extension), which differs from the base Prisma.TransactionClient.
type TxClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$use" | "$transaction" | "$extends"
>;

export async function POST(request: Request) {
  // Resilient parse — never throw on malformed input.
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await request.text());
    if (!parsed || typeof parsed !== "object") return reply(400, { error: "Invalid body" });
    body = parsed as Record<string, unknown>;
  } catch {
    return reply(400, { error: "Invalid JSON" });
  }

  const siteId = str(body.siteId);
  const rawType = body.type;
  const KNOWN_TYPES = [
    "conversion",
    "pageview",
    "page_exit",
    "stage_reached",
    "visit",
    "click",
    "form_field_focused",
    "form_field_blurred",
    "identify",
  ] as const;
  const type = (KNOWN_TYPES as readonly string[]).includes(rawType as string)
    ? (rawType as (typeof KNOWN_TYPES)[number])
    : null;
  if (!siteId || !type) return reply(400, { error: "Missing siteId or type" });

  const ip = clientIpFromHeaders(request.headers);
  const visitorId = str(body.visitorId);
  // Journey-class events (fire per page/interaction) → per-visitor/min cap.
  const isJourney =
    type === "pageview" ||
    type === "page_exit" ||
    type === "stage_reached" ||
    type === "click" ||
    type === "form_field_focused" ||
    type === "form_field_blurred" ||
    type === "identify";

  // Cross-instance flood guard (Upstash Redis): per-visitor for journey events,
  // per-(site+IP) for visit/conversion. Fails OPEN on a store outage so a Redis
  // blip never drops a real booking. (The per-session click/form fine caps below
  // stay in-memory — cheap, in-session best-effort.)
  const rl = isJourney
    ? await rateLimit("trackJourney", visitorId ?? ip)
    : await rateLimit("trackEvent", `${siteId}:${ip}`);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: "Too many events" }), {
      status: 429,
      headers: { ...CORS, "Content-Type": "application/json", "Retry-After": String(rl.retryAfterSec) },
    });
  }

  let hotel: Hotel | null;
  try {
    hotel = await prisma.hotelClient.findUnique({
      where: { siteId },
      select: { id: true, agencyId: true, snippetStatus: true, deletedAt: true, funnelStageRules: true },
    });
  } catch {
    return reply(503, { error: "Temporarily unavailable" });
  }
  if (!hotel) return reply(403, { error: "Unknown site id" });

  // Soft-deleted hotels do NOT accept new journey events (Part 7) — drop silently.
  // Legacy visit/conversion are still accepted (so a reactivation loses nothing).
  if (hotel.deletedAt && isJourney) return reply(204);

  try {
    if (type === "page_exit") {
      await handlePageExit(hotel, body);
      return reply(204);
    }
    if (type === "stage_reached") {
      // Reject an explicitly-malformed stage (Part 3); ignore other bad fields.
      if (!isFunnelStage(body.stage)) return reply(400, { error: "Invalid stage" });
      await handleStageReached(hotel, body, visitorId);
      return reply(204);
    }
    if (type === "click") {
      await handleClick(hotel, body, visitorId);
      return reply(204);
    }
    if (type === "form_field_focused" || type === "form_field_blurred") {
      await handleFormField(hotel, type, body, visitorId);
      return reply(204);
    }
    if (type === "identify") {
      await handleIdentify(hotel, body, visitorId);
      return reply(204);
    }
    await handleVisitLike(hotel, type, body, visitorId);
  } catch {
    return reply(503, { error: "Temporarily unavailable" });
  }

  return reply(204);
}

// ── recordStage: upsert a StageReached row (idempotent via @@unique) and bump
//    Session.highestStageReached, but only when the rank increases. Hotel-scoped
//    so a guessed sessionId can't write into another site's funnel. ───────────
async function recordStage(
  tx: TxClient,
  opts: {
    sessionId: string;
    hotelClientId: string;
    agencyId: string;
    visitorId: string;
    stage: FunnelStage;
    at: Date;
  },
) {
  const session = await tx.session.findUnique({
    where: { id: opts.sessionId },
    select: { hotelClientId: true, highestStageReached: true },
  });
  // The session must exist and belong to THIS hotel.
  if (!session || session.hotelClientId !== opts.hotelClientId) return;

  // Each (session, stage) at most once — the unique index makes this idempotent.
  await tx.stageReached.createMany({
    data: [
      {
        sessionId: opts.sessionId,
        visitorId: opts.visitorId,
        hotelClientId: opts.hotelClientId,
        agencyId: opts.agencyId,
        stage: opts.stage,
        reachedAt: opts.at,
      },
    ],
    skipDuplicates: true,
  });

  // Advance the denormalized highest stage only when this stage is higher.
  if (stageRank(opts.stage) > stageRank(session.highestStageReached)) {
    await tx.session.update({
      where: { id: opts.sessionId },
      data: { highestStageReached: opts.stage },
    });
  }
}

// ── stage_reached: the snippet detected a new highest funnel stage. ───────────
async function handleStageReached(
  hotel: Hotel,
  body: Record<string, unknown>,
  visitorId: string | null,
) {
  const sessionId = body.sessionId;
  const stage = body.stage;
  if (!isSessionId(sessionId) || !isVisitorId(visitorId) || !isFunnelStage(stage)) return;
  const ts = recentTs(body.timestamp) ?? new Date();
  await prisma.$transaction((tx) =>
    recordStage(tx, {
      sessionId,
      hotelClientId: hotel.id,
      agencyId: hotel.agencyId,
      visitorId,
      stage,
      at: ts,
    }),
  );
}

// Cap a (possibly null) string to n chars. str() already stripped control chars.
function cap(s: string | null, n: number): string | null {
  return s == null ? null : s.slice(0, n);
}

// The session must exist AND belong to THIS hotel, else we don't write the
// interaction (also satisfies the ClickEvent/FormFieldEvent FK to Session).
async function sessionOwnedBy(
  tx: TxClient,
  sessionId: string,
  hotelClientId: string,
): Promise<boolean> {
  const s = await tx.session.findUnique({
    where: { id: sessionId },
    select: { hotelClientId: true },
  });
  return !!s && s.hotelClientId === hotelClientId;
}

// ── click: a [data-ht-click] element was clicked → one ClickEvent ─────────────
async function handleClick(
  hotel: Hotel,
  body: Record<string, unknown>,
  visitorId: string | null,
) {
  const sessionId = body.sessionId;
  const pagePath = pagePathOf(body.pagePath);
  const clickTarget = cap(str(body.clickTarget), 100);
  if (!isSessionId(sessionId) || !isVisitorId(visitorId) || !pagePath || !clickTarget) return;
  const ts = recentTs(body.timestamp) ?? new Date();

  // Per-session cap — drop silently beyond CLICK_CAP_PER_SESSION (Part 3).
  if (!checkRateLimit(`click:${sessionId}`, { limit: CLICK_CAP_PER_SESSION, windowMs: SESSION_CAP_WINDOW_MS }).ok) return;

  await prisma.$transaction(async (tx) => {
    if (!(await sessionOwnedBy(tx, sessionId, hotel.id))) return;
    await tx.clickEvent.create({
      data: {
        sessionId,
        visitorId,
        hotelClientId: hotel.id,
        agencyId: hotel.agencyId,
        pagePath,
        clickTarget,
        elementTag: cap(str(body.elementTag), 32),
        elementText: cap(str(body.elementText), 100), // PII minimization
        occurredAt: ts,
      },
    });
  });
}

// ── form_field_focused / form_field_blurred → one FormFieldEvent ──────────────
async function handleFormField(
  hotel: Hotel,
  type: "form_field_focused" | "form_field_blurred",
  body: Record<string, unknown>,
  visitorId: string | null,
) {
  const sessionId = body.sessionId;
  const pagePath = pagePathOf(body.pagePath);
  const fieldName = cap(str(body.fieldName), 100);
  if (!isSessionId(sessionId) || !isVisitorId(visitorId) || !pagePath || !fieldName) return;
  const ts = recentTs(body.timestamp) ?? new Date();
  const action = type === "form_field_focused" ? "focused" : "blurred";
  // hasValue only carries meaning on blur; never the value itself.
  const hasValue =
    action === "blurred" && typeof body.hasValue === "boolean" ? body.hasValue : null;

  if (!checkRateLimit(`form:${sessionId}`, { limit: FORM_CAP_PER_SESSION, windowMs: SESSION_CAP_WINDOW_MS }).ok) return;

  await prisma.$transaction(async (tx) => {
    if (!(await sessionOwnedBy(tx, sessionId, hotel.id))) return;
    await tx.formFieldEvent.create({
      data: {
        sessionId,
        visitorId,
        hotelClientId: hotel.id,
        agencyId: hotel.agencyId,
        pagePath,
        fieldName,
        action,
        hasValue,
        occurredAt: ts,
      },
    });
  });
}

// ── identify: visitor self-identified → upsert VisitorIdentity ────────────────
// emailHash/phoneHash arrive ALREADY client-side SHA-256-hashed; we apply the
// salted server layer (lib/pii) and store that. Raw email/phone are never read,
// so they can never reach the DB. name/customerId are stored as-is.
async function handleIdentify(
  hotel: Hotel,
  body: Record<string, unknown>,
  visitorId: string | null,
) {
  if (!isVisitorId(visitorId)) return;
  const sessionId = isSessionId(body.sessionId) ? (body.sessionId as string) : null;
  const ts = recentTs(body.timestamp) ?? new Date();

  const emailHash = saltedHash(typeof body.emailHash === "string" ? body.emailHash : null);
  const phoneHash = saltedHash(typeof body.phoneHash === "string" ? body.phoneHash : null);
  const name = cap(str(body.name), 200);
  const customerId = cap(str(body.customerId), 200);

  // Nothing actually identifying → ignore.
  if (!emailHash && !phoneHash && !name && !customerId) return;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.visitorIdentity.findUnique({
      where: { visitorId },
      select: { hotelClientId: true },
    });
    // Cross-tenant guard: a visitorId already owned by another hotel is left alone.
    if (existing && existing.hotelClientId !== hotel.id) return;

    if (existing) {
      await tx.visitorIdentity.update({
        where: { visitorId },
        data: {
          // Only overwrite a field when this event actually provides it.
          ...(name ? { name } : {}),
          ...(emailHash ? { emailHash } : {}),
          ...(phoneHash ? { phoneHash } : {}),
          ...(customerId ? { customerId } : {}),
          identifiedAt: ts,
          ...(sessionId ? { identifiedInSessionId: sessionId } : {}),
        },
      });
    } else {
      await tx.visitorIdentity.create({
        data: {
          visitorId,
          hotelClientId: hotel.id,
          agencyId: hotel.agencyId,
          name,
          emailHash,
          phoneHash,
          customerId,
          identifiedAt: ts,
          identifiedInSessionId: sessionId,
        },
      });
    }
  });
}

// ── page_exit: close the open PageView for this session + hotel ───────────────
async function handlePageExit(hotel: Hotel, body: Record<string, unknown>) {
  const sessionId = body.sessionId;
  if (!isSessionId(sessionId)) return; // malformed — ignore
  const ts = recentTs(body.timestamp);
  if (!ts) return; // out-of-window — ignore (replay guard)
  const exitReason = str(body.exitReason);
  const reason =
    exitReason === "navigation" || exitReason === "unload" || exitReason === "inactivity_timeout"
      ? exitReason
      : null;

  await prisma.$transaction(async (tx) => {
    // hotelClientId-scoped so a guessed sessionId can't close another site's page.
    const open = await tx.pageView.findFirst({
      where: { sessionId, hotelClientId: hotel.id, exitedAt: null },
      orderBy: { enteredAt: "desc" },
      select: { id: true, enteredAt: true },
    });
    if (!open) return;

    const timeOnPageMs = Math.max(0, ts.getTime() - open.enteredAt.getTime());
    await tx.pageView.update({
      where: { id: open.id },
      data: { exitedAt: ts, timeOnPageMs, exitReason: reason },
    });
    await tx.session.update({
      where: { id: sessionId },
      data: {
        totalTimeMs: { increment: timeOnPageMs },
        // unload / inactivity end the session; navigation keeps it open.
        ...(reason === "unload" || reason === "inactivity_timeout" ? { endedAt: ts } : {}),
      },
    });
  });
}

// ── visit / pageview / conversion: always write a TrackingEvent; pageview also
//    writes Session + PageView journey rows ─────────────────────────────────
async function handleVisitLike(
  hotel: Hotel,
  type: "visit" | "pageview" | "conversion",
  body: Record<string, unknown>,
  visitorId: string | null,
) {
  if (hotel.deletedAt) {
    console.log("[TRACK] hotel_deleted", JSON.stringify({ hotelClientId: hotel.id, type }));
  }

  // TrackingEvent: pageview is recorded as a "visit" (preserves every existing
  // visit-based dashboard/metric). Only "conversion" is its own event type.
  const eventType = type === "conversion" ? "conversion" : "visit";

  // Revenue guard (Phase 0). MAX_CONVERSION_VALUE was declared but never applied,
  // so any caller holding a hotel's PUBLIC siteId could inject an arbitrary
  // booking value straight into that hotel's revenue KPIs. The event is still
  // recorded (we never lose the booking) — only the implausible amount is
  // dropped, and the rejection is logged so it can be investigated.
  let conversionValue: string | null = null;
  if (type === "conversion" && body.value != null) {
    const n = Number(body.value);
    if (Number.isFinite(n) && n >= 0) {
      if (n > MAX_CONVERSION_VALUE) {
        console.log(
          "[TRACK-VALUE-REJECTED]",
          JSON.stringify({
            hotelClientId: hotel.id,
            sessionId: str(body.sessionId),
            value: n,
            max: MAX_CONVERSION_VALUE,
            reason: "over_max_conversion_value",
          }),
        );
      } else {
        conversionValue = n.toFixed(2);
      }
    }
  }

  // Coupon code captured by the snippet (Phase R2) — only on conversions.
  const couponCodeUsed = type === "conversion" ? cleanCode(str(body.couponCodeUsed)) : null;

  // Ad click identifiers (Phase 1A). parseClickIds re-applies the full contract
  // server-side — trim, 255-char ceiling, URL-safe charset, DROP (never truncate)
  // an invalid value, and null when absent. Raw values are never logged.
  const eventClickIds: ClickIds = parseClickIds(body);

  const teData = {
    agencyId: hotel.agencyId,
    hotelClientId: hotel.id,
    eventType,
    utmSource: str(body.utmSource),
    utmMedium: str(body.utmMedium),
    utmCampaign: str(body.utmCampaign),
    utmContent: str(body.utmContent),
    utmTerm: str(body.utmTerm),
    pageUrl: str(body.pageUrl) ?? "",
    conversionValue,
    couponCodeUsed,
    sessionId: str(body.sessionId) ?? "",
    visitorId,
    deviceType: str(body.deviceType) ?? "unknown",
    // Ad click identifiers in effect for this visitor/session (Phase 1A). The
    // snippet sends the REMEMBERED ids, so a booking made pages after the ad
    // click still names that click. Re-validated here: the payload is public
    // input and the browser is never trusted blindly.
    ...eventClickIds,
  } as const;

  // Multi-touch journey (conversion only) — same parsing as before.
  type TouchRow = {
    position: number;
    timestamp: Date;
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    utmContent: string | null;
    utmTerm: string | null;
    referrer: string | null;
    landingPage: string | null;
  } & ClickIds;
  let touches: TouchRow[] = [];
  if (type === "conversion" && Array.isArray(body.journey)) {
    try {
      touches = body.journey.slice(0, 20).map((raw, i): TouchRow => {
        const tp = (raw ?? {}) as Record<string, unknown>;
        const tsNum = Number(tp.ts);
        return {
          position: i + 1,
          timestamp: Number.isFinite(tsNum) ? new Date(tsNum) : new Date(),
          utmSource: str(tp.utm_source),
          utmMedium: str(tp.utm_medium),
          utmCampaign: str(tp.utm_campaign),
          utmContent: str(tp.utm_content),
          utmTerm: str(tp.utm_term),
          referrer: str(tp.referrer),
          landingPage: str(tp.landing_page),
          // CRITICAL: the ids the snippet stamped on THIS touch — i.e. the ones
          // actually on the URL for that page load — never the remembered value.
          // Copying the remembered id onto later touches would invent a second
          // ad click that never happened.
          ...parseClickIds(tp),
        };
      });
    } catch {
      touches = [];
    }
  }

  // For pageview, decide whether the journey rows can be written: well-formed ids
  // + path + fresh timestamp. If not, we still write the TrackingEvent (data is
  // never lost) but skip the Session/PageView rows.
  const sessionId = body.sessionId;
  const pagePath = pagePathOf(body.pagePath);
  const ts = recentTs(body.timestamp);
  const canJourney =
    type === "pageview" &&
    isSessionId(sessionId) &&
    isVisitorId(visitorId) &&
    !!pagePath &&
    !!ts;

  await prisma.$transaction(async (tx) => {
    if (canJourney) {
      // Guard against a sessionId minted on another hotel's site (cross-tenant):
      // if the session already exists under a DIFFERENT hotel, skip journey rows.
      const existing = await tx.session.findUnique({
        where: { id: sessionId as string },
        select: { hotelClientId: true },
      });
      const foreign = existing && existing.hotelClientId !== hotel.id;

      if (!foreign) {
        await tx.session.upsert({
          where: { id: sessionId as string },
          create: {
            id: sessionId as string,
            visitorId: visitorId as string,
            hotelClientId: hotel.id,
            agencyId: hotel.agencyId,
            startedAt: ts as Date,
            landingPath: pagePath as string,
            exitPath: pagePath as string,
            pageViewCount: 1,
            utmSource: str(body.utmSource),
            utmMedium: str(body.utmMedium),
            utmCampaign: str(body.utmCampaign),
            utmContent: str(body.utmContent),
            utmTerm: str(body.utmTerm),
            referrer: str(body.referrer),
            userAgent: str(body.userAgent),
            // What this session LANDED with (Phase 1A).
            ...eventClickIds,
          },
          update: {
            pageViewCount: { increment: 1 },
            exitPath: pagePath as string,
            // ADD-ONLY merge: `presentClickIds` contains ONLY the identifiers
            // actually supplied on this request, so a later pageview without any
            // (every internal navigation) can never null out what the session
            // landed with, while a genuinely new ad click replaces that
            // platform's value. Prisma omits absent keys from the UPDATE entirely.
            ...presentClickIds(eventClickIds),
          },
        });

        // Funnel stage for this page: the snippet's data-ht-stage (payload), else
        // the hotel's server-side URL rules. Stored on the PageView and recorded
        // as a StageReached when it's a new highest stage for the session.
        const payloadStage = isFunnelStage(body.funnelStage) ? body.funnelStage : null;
        const stage =
          payloadStage ??
          resolveStageFromRules(parseFunnelRules(hotel.funnelStageRules), pagePath as string);

        await tx.pageView.create({
          data: {
            sessionId: sessionId as string,
            visitorId: visitorId as string,
            hotelClientId: hotel.id,
            agencyId: hotel.agencyId,
            pagePath: pagePath as string,
            pageTitle: str(body.pageTitle),
            referrer: str(body.referrer),
            enteredAt: ts as Date,
            funnelStage: stage,
            viewportWidth: intOf(body.viewportWidth),
            viewportHeight: intOf(body.viewportHeight),
          },
        });

        if (stage) {
          await recordStage(tx, {
            sessionId: sessionId as string,
            hotelClientId: hotel.id,
            agencyId: hotel.agencyId,
            visitorId: visitorId as string,
            stage,
            at: ts as Date,
          });
        }
      }
    }

    // Always refresh last activity; flip the snippet to "live" on the first event.
    // Runs BEFORE the duplicate-conversion guard below so a repeat beacon still
    // counts as "the snippet is alive", even though it records no second booking.
    await tx.hotelClient.update({
      where: { id: hotel.id },
      data: {
        lastEventAt: new Date(),
        ...(hotel.snippetStatus !== "live" ? { snippetStatus: "live" } : {}),
      },
    });

    // ── Conversion idempotency (Phase 0) ────────────────────────────────────
    // One booking per session. The snippet already tries to fire a conversion at
    // most once (`_ht_conv` cookie), but that guard is keyed to a sessionStorage
    // session id, so a REOPENED TAB — or a replayed/retried beacon — produced a
    // second TrackingEvent and double-counted both the booking and its revenue.
    // The (hotelClientId, sessionId) pair is the natural key the snippet already
    // supplies, and TrackingEvent has an index on sessionId, so this is a cheap
    // lookup. No schema change.
    //
    // Guarded on a NON-EMPTY sessionId: legacy/malformed payloads store "" and
    // collapsing every one of those into a single booking would lose real data.
    if (type === "conversion" && teData.sessionId) {
      const existing = await tx.trackingEvent.findFirst({
        where: {
          hotelClientId: hotel.id,
          eventType: "conversion",
          sessionId: teData.sessionId,
        },
        select: { id: true },
      });
      if (existing) {
        console.log(
          "[TRACK-CONVERSION-DUPLICATE]",
          JSON.stringify({
            hotelClientId: hotel.id,
            sessionId: teData.sessionId,
            existingEventId: existing.id,
          }),
        );
        return; // no second TrackingEvent, no second redemption, no touchpoints
      }
    }

    const ev = await tx.trackingEvent.create({ data: teData, select: { id: true } });

    // Path A (Phase R2): if the booking carried a coupon code, attribute it to the
    // influencer that owns that code FOR THIS HOTEL. The TrackingEvent is always
    // written (above) — a missing/expired/disabled code just falls back to UTM and
    // logs [COUPON-MISMATCH]; it never errors the booking.
    if (type === "conversion" && couponCodeUsed) {
      const now = new Date();
      const coupon = await tx.couponCode.findUnique({
        where: { hotelClientId_code: { hotelClientId: hotel.id, code: couponCodeUsed } },
        select: { id: true, influencerId: true, status: true, validFrom: true, validUntil: true },
      });
      // NOTE on redemption duplication: there is deliberately NO extra dedupe
      // check here. A previous revision looked up an existing redemption by
      // `trackingEventId: ev.id`, but `ev` is created two lines above with a
      // fresh cuid — that predicate can never match, so it was dead code that
      // read like a safeguard while providing none.
      //
      // The real guarantee is upstream: the conversion-idempotency guard means a
      // repeat beacon for the same (hotel, session) never reaches this block, so
      // one booking yields at most one snippet_auto redemption. That is an
      // APPLICATION-level invariant, not a database one — there is no unique
      // constraint on InfluencerRedemption, and adding one needs a migration
      // (deferred to Phase 1). Under true write concurrency a duplicate remains
      // possible.
      if (coupon && isCouponRedeemable(coupon, now)) {
        await tx.influencerRedemption.create({
          data: {
            couponCodeId: coupon.id,
            influencerId: coupon.influencerId,
            hotelClientId: hotel.id,
            agencyId: hotel.agencyId,
            bookingValue: conversionValue ?? "0",
            redemptionSource: "snippet_auto",
            trackingEventId: ev.id,
            sessionId: str(body.sessionId),
            redeemedAt: now,
          },
        });
      } else {
        console.log(
          "[COUPON-MISMATCH]",
          JSON.stringify({
            code: couponCodeUsed,
            hotelClientId: hotel.id,
            reason: coupon ? couponRejectReason(coupon, now) : "not_found",
          }),
        );
      }
    }

    if (touches.length > 0) {
      await tx.touchpoint.createMany({
        data: touches.map((t) => ({
          agencyId: hotel.agencyId,
          hotelClientId: hotel.id,
          visitorId: visitorId ?? "",
          conversionId: ev.id,
          position: t.position,
          timestamp: t.timestamp,
          utmSource: t.utmSource,
          utmMedium: t.utmMedium,
          utmCampaign: t.utmCampaign,
          utmContent: t.utmContent,
          utmTerm: t.utmTerm,
          referrer: t.referrer,
          landingPage: t.landingPage,
          // Per-touch ids only — see the TouchRow mapping above.
          gclid: t.gclid ?? null,
          gbraid: t.gbraid ?? null,
          wbraid: t.wbraid ?? null,
          fbclid: t.fbclid ?? null,
        })),
      });
    }
  });
}
