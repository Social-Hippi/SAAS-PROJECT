import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1B ingestion service against a LIVE DATABASE.
//
// Drives the real ingestBookingEvent() end to end: idempotency, lifecycle
// history, deterministic identity matching, ambiguity preservation, tenant
// isolation, and the guarantee that raw guest PII never lands in a column.
//
// Requires 20260821000000_add_click_identifiers and
// 20260824000000_add_booking_foundation to be applied.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { ingestBookingEvent, type TrustedBookingConnection } from "@/lib/booking-ingest";
import { hashGuestEmail, hashGuestPhone } from "@/lib/booking-identity";
import type { CanonicalBookingEvent } from "@/lib/booking-events";

const PREFIX = "TEST_BI_";
const PROVIDER = "test_pms";
const GUEST_EMAIL = "ingest.guest@example.test";
const GUEST_PHONE = "+91 90000 11111";

type Fx = {
  agencyA: string; hotelA: string; connA: TrustedBookingConnection;
  agencyB: string; hotelB: string; connB: TrustedBookingConnection;
};
let fx: Fx;

const evt = (over: Partial<CanonicalBookingEvent> = {}): CanonicalBookingEvent => ({
  eventType: "BOOKING_CREATED",
  provider: PROVIDER,
  externalBookingId: `RES-${randomUUID()}`,
  occurredAt: new Date().toISOString(),
  ...over,
});

async function mkTenant(tag: string) {
  const agency = await prisma.agency.create({
    data: { name: `${PREFIX}${tag}`, email: `${PREFIX.toLowerCase()}${tag}@x.test`, subscriptionStatus: "active" },
  });
  const hotel = await prisma.hotelClient.create({
    data: {
      agencyId: agency.id, name: `${PREFIX}${tag}`, websiteUrl: "https://hotel.example",
      contactName: "C", contactEmail: "c@t.local",
      siteId: `${PREFIX}site-${tag}-${Date.now()}`, conversionMethod: "both",
    },
  });
  const conn = await prisma.bookingConnection.create({
    data: { agencyId: agency.id, hotelClientId: hotel.id, provider: PROVIDER, credentials: "ciphertext-secret", status: "active" },
  });
  return {
    agencyId: agency.id,
    hotelId: hotel.id,
    conn: { id: conn.id, agencyId: agency.id, hotelClientId: hotel.id, provider: PROVIDER } as TrustedBookingConnection,
  };
}

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const a = await mkTenant("A");
  const b = await mkTenant("B");
  fx = { agencyA: a.agencyId, hotelA: a.hotelId, connA: a.conn, agencyB: b.agencyId, hotelB: b.hotelId, connB: b.conn };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

const bookingRow = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });
const history = (id: string) =>
  prisma.bookingStatusEvent.findMany({ where: { bookingId: id }, orderBy: { occurredAt: "asc" } });
const matches = (id: string) => prisma.bookingJourneyMatch.findMany({ where: { bookingId: id } });

// ── 1/2/3. Create, idempotency, update ────────────────────────────────────

describe("1/2/3. create, idempotency, update", () => {
  test("1. a booking is created from a canonical event", async () => {
    const r = await ingestBookingEvent(fx.connA, evt({ currency: "INR", amounts: { gross: 50000 } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    const b = await bookingRow(r.bookingId);
    expect(b.hotelClientId).toBe(fx.hotelA);
    expect(b.status).toBe("CONFIRMED");
    expect(Number(b.grossAmount)).toBe(50000);
    expect(b.currency).toBe("INR");
  });

  test("2. the SAME event twice yields exactly ONE booking", async () => {
    const e = evt({ amounts: { gross: 50000 } });
    const first = await ingestBookingEvent(fx.connA, e);
    const second = await ingestBookingEvent(fx.connA, e);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.bookingId).toBe(first.bookingId);
    expect(second.created).toBe(false);

    const count = await prisma.booking.count({
      where: { hotelClientId: fx.hotelA, provider: PROVIDER, externalBookingId: e.externalBookingId as string },
    });
    expect(count).toBe(1);
  });

  test("3. an update keeps the same booking and does not null out earlier values", async () => {
    const id = `RES-${randomUUID()}`;
    await ingestBookingEvent(fx.connA, evt({ externalBookingId: id, currency: "INR", amounts: { gross: 50000 } }));
    // A later event that omits currency must not erase it.
    const upd = await ingestBookingEvent(
      fx.connA,
      evt({ externalBookingId: id, eventType: "BOOKING_UPDATED", amounts: { gross: 55000 } }),
    );
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    const b = await bookingRow(upd.bookingId);
    expect(Number(b.grossAmount)).toBe(55000);
    expect(b.currency).toBe("INR"); // preserved
    expect(b.status).toBe("MODIFIED");
  });
});

// ── 4/5/6. Lifecycle, cancellation, refund ────────────────────────────────

describe("4/5/6. lifecycle history", () => {
  test("the full sequence is retained in order and never overwritten", async () => {
    const id = `RES-${randomUUID()}`;
    const t = (min: number) => new Date(Date.now() - (60 - min) * 60_000).toISOString();

    await ingestBookingEvent(fx.connA, evt({ externalBookingId: id, occurredAt: t(0), currency: "INR", amounts: { gross: 50000 } }));
    await ingestBookingEvent(fx.connA, evt({ externalBookingId: id, eventType: "BOOKING_UPDATED", occurredAt: t(10), currency: "INR", amounts: { gross: 55000 } }));
    await ingestBookingEvent(fx.connA, evt({ externalBookingId: id, eventType: "BOOKING_CANCELLED", occurredAt: t(20) }));
    const last = await ingestBookingEvent(fx.connA, evt({ externalBookingId: id, eventType: "BOOKING_REFUNDED", occurredAt: t(30), currency: "INR", amounts: { refunded: 55000 } }));
    expect(last.ok).toBe(true);
    if (!last.ok) return;

    const h = await history(last.bookingId);
    expect(h.map((x) => x.status)).toEqual(["CONFIRMED", "MODIFIED", "CANCELLED", "REFUNDED"]);
    expect(Number(h[0].grossAmount)).toBe(50000); // the original survives
    expect(Number(h[1].grossAmount)).toBe(55000);
    expect(Number(h[3].refundedAmount)).toBe(55000);

    // Current state on the fact row.
    expect((await bookingRow(last.bookingId)).status).toBe("REFUNDED");
  });

  test("a redelivery that changes nothing appends NO lifecycle row", async () => {
    const e = evt({ externalBookingId: `RES-${randomUUID()}` }); // no amounts
    const first = await ingestBookingEvent(fx.connA, e);
    const again = await ingestBookingEvent(fx.connA, e);
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(first.statusEventAppended).toBe(true);
    expect(again.statusEventAppended).toBe(false); // history is events, not redeliveries
    expect(await history(first.bookingId)).toHaveLength(1);
  });
});

// ── 9/10/11/12. Deterministic identity matching ───────────────────────────

describe("9/10/11/12. identity matching", () => {
  test("9. a booking matches a visitor by EMAIL hash → STRONG", async () => {
    const visitorId = `vis_${randomUUID()}`;
    await prisma.visitorIdentity.create({
      data: { visitorId, hotelClientId: fx.hotelA, agencyId: fx.agencyA, emailHash: hashGuestEmail(GUEST_EMAIL), identifiedAt: new Date() },
    });
    const r = await ingestBookingEvent(fx.connA, evt({ guest: { email: GUEST_EMAIL } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.match).toEqual({ method: "email_hash", confidence: "STRONG", created: 1 });
    const m = await matches(r.bookingId);
    expect(m[0].visitorId).toBe(visitorId);
  });

  test("10. a booking matches by PHONE hash → STRONG", async () => {
    const visitorId = `vis_${randomUUID()}`;
    const phone = "+91 90000 22222";
    await prisma.visitorIdentity.create({
      data: { visitorId, hotelClientId: fx.hotelA, agencyId: fx.agencyA, phoneHash: hashGuestPhone(phone), identifiedAt: new Date() },
    });
    const r = await ingestBookingEvent(fx.connA, evt({ guest: { phone } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.match?.method).toBe("phone_hash");
    expect(r.match?.confidence).toBe("STRONG");
  });

  test("11. TWO candidates produce TWO PARTIAL rows — ambiguity is preserved", async () => {
    const shared = "shared.guest@example.test";
    const ids = [`vis_${randomUUID()}`, `vis_${randomUUID()}`];
    for (const visitorId of ids) {
      await prisma.visitorIdentity.create({
        data: { visitorId, hotelClientId: fx.hotelA, agencyId: fx.agencyA, emailHash: hashGuestEmail(shared), identifiedAt: new Date() },
      });
    }
    const r = await ingestBookingEvent(fx.connA, evt({ guest: { email: shared } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.match?.confidence).toBe("PARTIAL");
    const m = await matches(r.bookingId);
    expect(m).toHaveLength(2); // NOT collapsed to one arbitrary winner
    expect(m.every((x) => x.matchConfidence === "PARTIAL")).toBe(true);
    expect(m.map((x) => x.visitorId).sort()).toEqual([...ids].sort());
  });

  test("12. no candidate produces an explicit UNKNOWN row", async () => {
    const r = await ingestBookingEvent(fx.connA, evt({ guest: { email: "nobody@example.test" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.match).toEqual({ method: "unknown", confidence: "UNKNOWN", created: 1 });
    const m = await matches(r.bookingId);
    // "We looked and found nothing" must be distinguishable from "never looked".
    expect(m[0].matchMethod).toBe("unknown");
    expect(m[0].visitorId).toBeNull();
  });

  test("re-ingesting does not accumulate duplicate evidence", async () => {
    const e = evt({ guest: { email: "nobody2@example.test" } });
    const first = await ingestBookingEvent(fx.connA, e);
    await ingestBookingEvent(fx.connA, e);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await matches(first.bookingId)).toHaveLength(1);
  });

  test("customerId outranks email when both would match", async () => {
    const visitorId = `vis_${randomUUID()}`;
    const customerId = `PMS-${randomUUID()}`;
    await prisma.visitorIdentity.create({
      data: { visitorId, hotelClientId: fx.hotelA, agencyId: fx.agencyA, customerId, emailHash: hashGuestEmail(GUEST_EMAIL), identifiedAt: new Date() },
    });
    const r = await ingestBookingEvent(fx.connA, evt({ guest: { email: GUEST_EMAIL, externalGuestId: customerId } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.match?.method).toBe("customer_id");
  });
});

// ── 7. Tenant / cross-hotel isolation ─────────────────────────────────────

describe("7. tenant isolation", () => {
  test("the booking lands on the CONNECTION's hotel, never a payload-supplied one", async () => {
    // A hostile payload claiming another hotel must be ignored entirely.
    const r = await ingestBookingEvent(
      fx.connA,
      evt({ hotelClientId: fx.hotelB, agencyId: fx.agencyB } as unknown as Partial<CanonicalBookingEvent>),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = await bookingRow(r.bookingId);
    expect(b.hotelClientId).toBe(fx.hotelA);
    expect(b.agencyId).toBe(fx.agencyA);
  });

  test("an event whose provider disagrees with the connection is REJECTED", async () => {
    const r = await ingestBookingEvent(fx.connA, evt({ provider: "other_pms" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toContain("does not match connection provider");
  });

  test("hotel A's guest email never matches hotel B's visitor", async () => {
    const email = "crosstenant@example.test";
    await prisma.visitorIdentity.create({
      data: { visitorId: `vis_${randomUUID()}`, hotelClientId: fx.hotelB, agencyId: fx.agencyB, emailHash: hashGuestEmail(email), identifiedAt: new Date() },
    });
    const r = await ingestBookingEvent(fx.connA, evt({ guest: { email } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.match?.method).toBe("unknown"); // the other hotel's visitor is invisible
  });

  test("the same externalBookingId can exist for both hotels independently", async () => {
    const shared = `RES-SHARED-${randomUUID()}`;
    const a = await ingestBookingEvent(fx.connA, evt({ externalBookingId: shared }));
    const b = await ingestBookingEvent(fx.connB, evt({ externalBookingId: shared }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.bookingId).not.toBe(b.bookingId);
  });
});

// ── 8/15. Secrets and PII ─────────────────────────────────────────────────

describe("8/15. credential scrubbing and PII", () => {
  test("8. the connection credential never appears in a query result", async () => {
    const row = await prisma.bookingConnection.findFirst({ where: { hotelClientId: fx.hotelA } });
    expect(row).not.toBeNull();
    expect((row as unknown as Record<string, unknown>).credentials).toBeUndefined();
  });

  test("15. raw guest email/phone are NEVER persisted — only the hashes", async () => {
    const r = await ingestBookingEvent(fx.connA, evt({ guest: { email: GUEST_EMAIL, phone: GUEST_PHONE, name: "Test Guest" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = await bookingRow(r.bookingId);

    expect(b.guestEmailHash).toBe(hashGuestEmail(GUEST_EMAIL));
    expect(b.guestPhoneHash).toBe(hashGuestPhone(GUEST_PHONE));
    // The raw values appear nowhere on the row — including rawPayload, which the
    // adapter chose not to include here.
    //
    // Every needle must be LONG and SPECIFIC. An earlier revision searched for
    // "90000" — a five-digit slice of the phone — against a blob that also holds
    // random cuid/uuid identifiers, so it tripped intermittently on a chance
    // digit run rather than on leaked PII. These check the full raw value in
    // each representation the ingest path could plausibly store it in, which is
    // both stricter and not vulnerable to coincidence.
    const serialized = JSON.stringify(b);
    const RAW_NEEDLES = [
      GUEST_EMAIL,                       // ingest.guest@example.test
      GUEST_EMAIL.split("@")[0],         // ingest.guest
      GUEST_PHONE,                       // "+91 90000 11111" as supplied
      GUEST_PHONE.replace(/\s/g, ""),    // +919000011111 (E.164)
      GUEST_PHONE.replace(/\D/g, ""),    // 919000011111 (digits only)
      "9000011111",                      // national form, 10 digits
    ];
    for (const needle of RAW_NEEDLES) {
      expect(serialized).not.toContain(needle);
    }
    // guestName is stored by policy (same as InfluencerRedemption.guestName).
    expect(b.guestName).toBe("Test Guest");
  });
});

// ── 13/14. FACT vs EVIDENCE, legacy conversions ───────────────────────────

describe("13/14. separation of concerns", () => {
  test("13. the Booking row carries no attribution fields", async () => {
    const r = await ingestBookingEvent(fx.connA, evt({ guest: { email: GUEST_EMAIL } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = await bookingRow(r.bookingId) as unknown as Record<string, unknown>;
    for (const f of ["visitorId", "sessionId", "trackingEventId", "matchMethod", "matchConfidence"]) {
      expect(b[f]).toBeUndefined();
    }
  });

  test("14. a legacy scraped conversion is NEVER promoted into a Booking", async () => {
    const sessionId = `sess_${randomUUID()}`;
    await prisma.trackingEvent.create({
      data: {
        agencyId: fx.agencyA, hotelClientId: fx.hotelA, eventType: "conversion",
        pageUrl: "https://hotel.example/thank-you", conversionValue: "77777.00",
        sessionId, deviceType: "desktop",
      },
    });
    // Ingestion is the ONLY writer of Booking, and it was not called for that
    // scrape — so no booking exists for it.
    const fromScrape = await prisma.booking.findFirst({
      where: { hotelClientId: fx.hotelA, grossAmount: "77777.00" },
    });
    expect(fromScrape).toBeNull();
  });
});
