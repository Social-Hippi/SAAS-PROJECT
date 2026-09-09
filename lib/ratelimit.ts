import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { checkRateLimit, clientIpFromHeaders } from "@/lib/rate-limit";

// Re-export so call sites need a single import for "get the client key + limit it".
export { clientIpFromHeaders };

// ─────────────────────────────────────────────────────────────────────────────
// Distributed rate limiting for HotelTrack's PUBLIC / abuse-prone endpoints,
// backed by Upstash Redis so a limit holds ACROSS Vercel's stateless serverless
// instances. (The in-memory limiter in lib/rate-limit.ts counts per-instance
// only; it is kept for in-session fine caps — e.g. per-session click/form spam —
// and as a local-dev fallback when Upstash isn't configured.)
//
// SETUP (one-time, done by the operator):
//   1. Create a Redis database at https://console.upstash.com/
//   2. From its "REST API" panel, copy the URL + token into env — BOTH
//      .env.local (dev) and Vercel → Project → Settings → Environment Variables:
//        UPSTASH_REDIS_REST_URL=...
//        UPSTASH_REDIS_REST_TOKEN=...
//
// If those vars are absent we log ONE warning and fall back to the per-instance
// in-memory limiter: fine for local dev, NOT valid protection on Vercel.
// ─────────────────────────────────────────────────────────────────────────────

type Policy = { limit: number; window: `${number} s`; failOpen: boolean };

// Per-endpoint policies. `failOpen` decides behavior ONLY on a Redis OUTAGE:
//   true  → allow the request (tracking/exports/webhooks: never lose a real
//           booking, billing event, or block a paying user over a Redis blip).
//   false → block the request (share / hotel-owner / join / oauth: the safe
//           choice against token/code enumeration).
// When the store is healthy, exceeding the limit always returns ok:false (429).
export const POLICIES = {
  // Public tracking ingest — high legitimate volume; per (siteId+IP).
  trackEvent: { limit: 60, window: "60 s", failOpen: true },
  // Journey events fire on every page → higher cap, keyed per visitor.
  trackJourney: { limit: 200, window: "60 s", failOpen: true },
  // Snippet config fetch (one per page load), per (siteId+IP).
  trackConfig: { limit: 120, window: "60 s", failOpen: true },
  // Public share report page load, per IP (anti-enumeration).
  sharePage: { limit: 30, window: "60 s", failOpen: false },
  // Share password attempts, per (token+IP) — tight anti-brute-force.
  sharePassword: { limit: 5, window: "60 s", failOpen: false },
  // Saving a low-balance reminder, per (hotelClientId+IP). No longer reachable
  // from a share link — the action requires a session (see funds/actions.ts) —
  // so this is now defence in depth on the authenticated path rather than the
  // only bound on a public write. Still fails CLOSED: a store outage must not
  // open an unmetered write to the address that receives a hotel's balance.
  shareReminder: { limit: 5, window: "60 s", failOpen: false },
  // Public hotel-owner dashboard (/h/<token>) load, per IP.
  hotelOwner: { limit: 30, window: "60 s", failOpen: false },
  // Hotel self-signup, per IP (invite-code probing + account spam).
  joinSignup: { limit: 10, window: "60 s", failOpen: false },
  // Expensive authenticated PDF/xlsx/csv exports, per signed-in member.
  export: { limit: 20, window: "60 s", failOpen: true },
  // Razorpay webhook (HMAC is the real auth) — generous defense-in-depth, per IP.
  webhook: { limit: 100, window: "60 s", failOpen: true },
  // OAuth callbacks (signed state is the real auth) — slow brute-force, per IP.
  oauthCallback: { limit: 20, window: "60 s", failOpen: false },
} satisfies Record<string, Policy>;

export type PolicyName = keyof typeof POLICIES;

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
const configured = Boolean(url && token);

// Shared across policies: one Redis client + one in-process ephemeral cache. The
// ephemeral cache lets Upstash short-circuit identifiers already known to be
// blocked this window, saving Redis round-trips (and free-tier commands).
let redis: Redis | null = null;
const ephemeralCache = new Map<string, number>();
const limiters = new Map<PolicyName, Ratelimit>();

function limiterFor(name: PolicyName): Ratelimit {
  let limiter = limiters.get(name);
  if (!limiter) {
    redis ??= new Redis({ url: url!, token: token! });
    const p = POLICIES[name];
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(p.limit, p.window),
      ephemeralCache,
      prefix: `ht:rl:${name}`,
      analytics: false,
    });
    limiters.set(name, limiter);
  }
  return limiter;
}

const windowSeconds = (p: Policy): number => parseInt(p.window, 10) || 60;

let warnedNoStore = false;

export type RateLimitOutcome = { ok: boolean; retryAfterSec: number };

/**
 * Check `key` against the named policy. ok=false means the limit is exceeded and
 * the caller should reply 429 with a Retry-After header. On a Redis OUTAGE the
 * policy's `failOpen` decides allow-vs-block; when Upstash isn't configured at
 * all we use the per-instance in-memory limiter (local dev only).
 */
export async function rateLimit(name: PolicyName, key: string): Promise<RateLimitOutcome> {
  const p = POLICIES[name];

  if (!configured) {
    if (!warnedNoStore) {
      warnedNoStore = true;
      console.warn(
        "[ratelimit] UPSTASH_REDIS_REST_URL/TOKEN not set — using in-memory fallback (per-instance only; NOT valid protection in production).",
      );
    }
    const r = checkRateLimit(`${name}:${key}`, { limit: p.limit, windowMs: windowSeconds(p) * 1000 });
    return { ok: r.ok, retryAfterSec: Math.ceil(r.resetInMs / 1000) };
  }

  try {
    const r = await limiterFor(name).limit(key);
    return { ok: r.success, retryAfterSec: Math.max(1, Math.ceil((r.reset - Date.now()) / 1000)) };
  } catch (err) {
    // Store unreachable — honor the policy's failure stance, and log it so the
    // outage (and any bypass) is visible.
    console.error(`[ratelimit] store error on "${name}" (failOpen=${p.failOpen}):`, err);
    return { ok: p.failOpen, retryAfterSec: windowSeconds(p) };
  }
}

/** Build a 429 JSON response with Retry-After; merge extra headers (e.g. CORS). */
export function tooManyRequests(
  retryAfterSec: number,
  extraHeaders?: Record<string, string>,
): Response {
  return Response.json(
    { error: "Too many requests" },
    {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, retryAfterSec)), ...extraHeaders },
    },
  );
}
