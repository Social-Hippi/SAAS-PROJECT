# Booking provider contract

How a PMS, booking engine, OTA, or channel manager is connected to HotelTrack.

> **No provider is connected yet.** The adapter registry is empty by design — the
> first real provider is a separate decision. This document is the contract that
> provider will implement.

---

## The chain

```
EXTERNAL PROVIDER
      ↓  adapter (the only vendor-aware code)
CanonicalBookingEvent          lib/booking-events.ts
      ↓  ingestBookingEvent()  lib/booking-ingest.ts
Booking            ← the FACT
BookingStatusEvent ← append-only history
      ↓  matchBookingToJourney()  lib/booking-match.ts
BookingJourneyMatch ← the EVIDENCE (method + confidence)
      ↓
[ attribution — a LATER phase, nothing here computes it ]
```

**A provider adapter never writes to the database and never touches an
attribution table.** It translates, and nothing else.

---

## 1. Canonical booking event

`CanonicalBookingEvent` in `lib/booking-events.ts`.

### Required — only four

| Field | Notes |
|---|---|
| `eventType` | `BOOKING_CREATED` \| `BOOKING_UPDATED` \| `BOOKING_CANCELLED` \| `BOOKING_REFUNDED` \| `BOOKING_COMPLETED` |
| `provider` | Slug matching `BookingConnection.provider`, lower-cased (`Cloudbeds` → `cloudbeds`) |
| `externalBookingId` | The provider's own reservation id — the idempotency key |
| `occurredAt` | When the event happened **at the provider**, not when we received it |

### Optional — supply only what the provider actually knows

`externalAccountId` · `status` · `bookingChannel` · `currency` · `bookedAt` ·
`checkIn` · `checkOut` · `guest.{name,email,phone,externalGuestId}` ·
`amounts.{gross,net,roomRevenue,ancillaryRevenue,tax,refunded}` · `rawPayload`

**Never invent a value to fill a field.** An omitted field is stored as `NULL`,
which is a meaningful state the rest of the system understands.

---

## 2. Mapping table — write one of these for every adapter

The adapter maps explicitly; the validator never guesses. Example for a
hypothetical PMS:

| Provider field | Canonical field | Note |
|---|---|---|
| `reservationNumber` | `externalBookingId` | |
| `propertyId` | `externalAccountId` | |
| `arrivalDate` | `checkIn` | |
| `departureDate` | `checkOut` | |
| `createdOn` | `bookedAt` | when the guest booked |
| `lastModified` | `occurredAt` | when *this event* happened |
| `totalAmount` | `amounts.gross` | **not** `net` unless the provider says so |
| `amountAfterTax` | `amounts.net` | only if the provider distinguishes them |
| `taxes` | `amounts.tax` | |
| `currencyCode` | `currency` | ISO-4217, else dropped to `NULL` |
| `sourceOfBusiness` | `bookingChannel` | `ota`, `phone`, `direct_web`… |
| `guestEmail` | `guest.email` | **raw — hashed at ingest, never stored** |
| *(whole record)* | `rawPayload` | kept for audit/repair |

`bookingChannel` is **how the booking was made**. It is not a marketing source
and must never be set to `google_ads`, `meta_ads`, `organic`, etc. A
Google-Ads-acquired guest who books through an OTA has
`bookingChannel = "ota"`, with the marketing source living on the journey side
of the match.

---

## 3. Adapter interface

`BookingProviderAdapter` in `lib/booking-provider.ts`.

```ts
readonly provider: string          // slug
readonly displayName: string
readonly capabilities: { webhook: boolean; polling: boolean }

validateConnection(ctx, credentials): Promise<AdapterResult<{ externalAccountId?: string | null }>>

// webhook-capable adapters
verifyWebhook?(rawBody, headers, credentials): boolean
parseWebhook?(rawBody, headers): AdapterResult<CanonicalBookingEvent[]>

// polling-capable adapters
fetchBookings?(ctx, credentials, since): Promise<AdapterResult<CanonicalBookingEvent[]>>
```

Register at module load:

```ts
registerBookingProvider(myAdapter);
```

**Adapters must not throw.** Return `{ ok: false, error }` — one bad record must
never abort a batch. This mirrors `runGoogleAdsSync` / `runMetaSync`.

---

## 4. Webhook vs polling

Both transports converge on the same service, so idempotency, lifecycle, and
matching behave identically:

```
WEBHOOK   provider → route → verifyWebhook() → parseWebhook() → ingestBookingEvents()
POLLING   cron     →                           fetchBookings() → ingestBookingEvents()
```

A webhook route must, in order: resolve the `BookingConnection` from the URL
(never from the body) → read the credential via `getTokenForApiCall("booking_provider", connectionId, …)`
→ `verifyWebhook()` on the **raw** body → `parseWebhook()` → `ingestBookingEvents()`.

*The HTTP route is intentionally not built yet* — its signature scheme is
provider-specific, and shipping a public unauthenticated endpoint with no
adapters registered would be attack surface for no benefit.

---

## 5. Guarantees the ingestion service provides

| Guarantee | How |
|---|---|
| **Idempotency** | `@@unique([hotelClientId, provider, externalBookingId])`. Re-delivery updates, never duplicates. |
| **Add-only updates** | Only fields the event supplies are written; a later event omitting `currency` cannot erase it. |
| **History is never rewritten** | `BookingStatusEvent` rows are appended, never updated. A redelivery that changes nothing appends nothing. |
| **Tenant safety** | `agencyId`/`hotelClientId` come from the trusted connection. A payload claiming another hotel is ignored; a provider mismatch is rejected. |
| **PII** | Raw `guest.email`/`guest.phone` are hashed at the service boundary and discarded. Only salted hashes reach a column. |
| **No invented money** | An unusable amount → `NULL`, never `0`. Over-width amounts are dropped, never truncated. |
| **No assumed currency** | A malformed code → `NULL` (unknown). `INR` is never assumed. |

---

## 6. Identity matching

Deterministic only, strongest identifier first: `customerId` → `emailHash` →
`phoneHash`, all scoped to the hotel.

| Candidates | Confidence |
|---|---|
| exactly 1, via an id we issued (`visitor_id`, `session_id`, `tracking_event`, `booking_id`) | `DETERMINISTIC` |
| exactly 1, via a shared identifier (`email_hash`, `phone_hash`, `customer_id`, `coupon_code`) | `STRONG` |
| 2 or more | `PARTIAL` — **every** candidate is recorded; none is chosen |
| none | `UNKNOWN` — recorded explicitly, so "we looked and found nothing" is distinguishable from "never looked" |
| `manual` | `PARTIAL` — a human assertion is a claim, not a deterministic identifier |

**There is no probabilistic matching.** No IP, no timing proximity, no
user-agent or device similarity, no geo, no fuzzy names. If identifiers don't
match exactly, the answer is `UNKNOWN`.

---

## 7. What this layer deliberately does *not* do

No attribution, no revenue credit, no first/last/multi-touch, no campaign or ad
ROAS. Ingestion establishes *"here is the booking"* and *"here is the evidence
connecting it to a journey"* — and stops.

`TrackingEvent.conversionValue` (the DOM-scraped thank-you-page value) is
untouched and is **not** a booking. It remains an observed checkout value, in a
different table, under a different name, and is never promoted into `Booking`.

---

## 8. Adding a provider — checklist

1. `lib/booking-providers/<slug>.ts` implementing `BookingProviderAdapter`.
2. Write the mapping table (§2) into that file's header comment.
3. `registerBookingProvider()` at module load.
4. Store the credential encrypted on `BookingConnection.credentials`
   (`encryptWithAudit`), read it only via `getTokenForApiCall("booking_provider", …)`.
5. Webhook adapters: add the route shell; polling adapters: add a cron entry to
   `vercel.json` guarded by `CRON_SECRET`.
6. Tests: normalization (DB-free) + ingestion (DB-backed), including a
   cross-tenant isolation case.
