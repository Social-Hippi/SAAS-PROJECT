import type { CanonicalBookingEvent } from "@/lib/booking-events";

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING PROVIDER ADAPTER CONTRACT.
//
// One adapter per external system (PMS, booking engine, OTA, channel manager).
// Its ONLY job is translation: vendor shape → CanonicalBookingEvent. It performs
// no database work, does no matching, and never touches an attribution table.
// The ingestion service treats every provider identically.
//
// TRANSPORT-AGNOSTIC BY DESIGN. Not every provider offers webhooks, so an
// adapter implements whichever half it supports:
//
//   WEBHOOK  provider → route → verifyWebhook() → parseWebhook() → ingest
//   POLLING  cron     → fetchBookings(since)    →                → ingest
//
// Both produce the same CanonicalBookingEvent[], so the ingestion service, the
// idempotency rules, the lifecycle handling and the identity matching are
// identical either way. An adapter may implement both.
//
// THE REGISTRY IS DELIBERATELY EMPTY. No real provider is connected yet — the
// first one is a separate decision. Everything here is the seam it plugs into.
// ─────────────────────────────────────────────────────────────────────────────

/** Non-secret context an adapter needs. Credentials are passed separately and
 *  only for the duration of a call — never stored on the adapter. */
export type BookingProviderContext = {
  /** Trusted, resolved from BookingConnection — never from a payload. */
  hotelClientId: string;
  agencyId: string;
  /** The hotel's id at the provider (property id, account id …), if any. */
  externalAccountId: string | null;
};

/** Uniform result so an adapter never throws into the ingestion loop. */
export type AdapterResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface BookingProviderAdapter {
  /** Slug matching BookingConnection.provider, e.g. "cloudbeds". */
  readonly provider: string;

  /** Human-readable name for the integrations UI. */
  readonly displayName: string;

  /** Which transports this adapter supports. Drives what the platform offers. */
  readonly capabilities: {
    webhook: boolean;
    polling: boolean;
  };

  /**
   * Confirm the stored credential still works, and optionally report the
   * account id the provider says it belongs to. Mirrors the validate step the
   * Meta / GA4 / Google Ads connections already perform on connect.
   */
  validateConnection(
    ctx: BookingProviderContext,
    credentials: string,
  ): Promise<AdapterResult<{ externalAccountId?: string | null }>>;

  /**
   * Constant-time verification that a webhook body genuinely came from this
   * provider. Required for webhook-capable adapters — an unverified body must
   * never reach the ingestion service.
   */
  verifyWebhook?(rawBody: string, headers: Headers, credentials: string): boolean;

  /** Translate a verified webhook body into canonical events. Must not throw. */
  parseWebhook?(rawBody: string, headers: Headers): AdapterResult<CanonicalBookingEvent[]>;

  /**
   * Polling: every booking created or changed since `since`. Callers page until
   * the adapter returns an empty batch. Must not throw.
   */
  fetchBookings?(
    ctx: BookingProviderContext,
    credentials: string,
    since: Date,
  ): Promise<AdapterResult<CanonicalBookingEvent[]>>;
}

// ── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY = new Map<string, BookingProviderAdapter>();

/** Register an adapter. Called once at module load by each provider module. */
export function registerBookingProvider(adapter: BookingProviderAdapter): void {
  REGISTRY.set(adapter.provider, adapter);
}

/** Look up an adapter by provider slug. Null when nothing is registered — which
 *  is the current state, and the correct answer rather than a stub. */
export function getBookingProvider(provider: string): BookingProviderAdapter | null {
  return REGISTRY.get(provider) ?? null;
}

/** Every registered adapter (for the integrations UI). Empty today. */
export function listBookingProviders(): BookingProviderAdapter[] {
  return [...REGISTRY.values()];
}

/** Test hook: drop all registrations. */
export function resetBookingProviders(): void {
  REGISTRY.clear();
}
