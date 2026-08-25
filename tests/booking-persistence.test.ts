import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1B — booking foundation against a LIVE DATABASE.
//
// Exercises the FACT/EVIDENCE split end to end: bookings persist and de-duplicate
// on their own, lifecycle history accumulates without overwriting, and a journey
// match is a separate, optional, possibly-ambiguous record that can be absent
// entirely without harming the booking.
//
// Requires the 20260824000000_add_booking_foundation migration applied.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { agencyScopedFor } from "@/lib/tenant-scope";
import { hashGuestEmail, gradeMatch } from "@/lib/booking-identity";

const PREFIX = "TEST_BK_";
const GUEST_EMAIL = "guest.one@example.test";

type Fx = { agencyA: string; hotelA: string; agencyB: string; hotelB: string };
let fx: Fx;

const mkHotel = (agencyId: string, tag: string) =>
  prisma.hotelClient.create({
    data: {
      agencyId,
      name: `${PREFIX}${tag}`,
      websiteUrl: "https://hotel.example",
      contactName: "C",
      contactEmail: "c@t.local",
      siteId: `${PREFIX}site-${tag}-${Date.now()}`,
      conversionMethod: "both",
    },
  });

function mkBooking(agencyId: string, hotelClientId: string, externalBookingId: string, over: Record<string, unknown> = {}) {
  return prisma.booking.create({
    data: {
      agencyId,
      hotelClientId,
      provider: "test_provider",
      externalBookingId,
      bookedAt: new Date(),
      currency: "INR",
      grossAmount: "25000.00",
      ...over,
    },
  });
}

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const a = await prisma.agency.create({ data: { name: `${PREFIX}A`, email: `${PREFIX.toLowerCase()}a@x.test`, subscriptionStatus: "active" } });
  const b = await prisma.agency.create({ data: { name: `${PREFIX}B`, email: `${PREFIX.toLowerCase()}b@x.test`, subscriptionStatus: "active" } });
  const ha = await mkHotel(a.id, "A1");
  const hb = await mkHotel(b.id, "B1");
  fx = { agencyA: a.id, hotelA: ha.id, agencyB: b.id, hotelB: hb.id };
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

// ── 1/2. Creation and idempotency ─────────────────────────────────────────

describe("1/2. booking creation and idempotency", () => {
  test("a booking persists with its provider reference", async () => {
    const ext = `RES-${randomUUID()}`;
    const b = await mkBooking(fx.agencyA, fx.hotelA, ext);
    expect(b.externalBookingId).toBe(ext);
    expect(b.status).toBe("CONFIRMED");
    expect(Number(b.grossAmount)).toBe(25000);
  });

  test("the same reservation re-delivered does NOT duplicate revenue", async () => {
    const ext = `RES-${randomUUID()}`;
    await mkBooking(fx.agencyA, fx.hotelA, ext);
    await expect(mkBooking(fx.agencyA, fx.hotelA, ext)).rejects.toThrow(); // unique violation
    const count = await prisma.booking.count({
      where: { hotelClientId: fx.hotelA, provider: "test_provider", externalBookingId: ext },
    });
    expect(count).toBe(1);
  });

  test("the SAME external id from a DIFFERENT provider is a different booking", async () => {
    const ext = `RES-${randomUUID()}`;
    await mkBooking(fx.agencyA, fx.hotelA, ext);
    const other = await mkBooking(fx.agencyA, fx.hotelA, ext, { provider: "other_provider" });
    expect(other.id).toBeTruthy();
  });

  test("7. currency may be UNKNOWN — it is never defaulted", async () => {
    const b = await mkBooking(fx.agencyA, fx.hotelA, `RES-${randomUUID()}`, { currency: null });
    expect(b.currency).toBeNull();
  });

  test("8. unsupplied revenue fields stay NULL, not zero", async () => {
    const b = await mkBooking(fx.agencyA, fx.hotelA, `RES-${randomUUID()}`, { grossAmount: null });
    expect(b.grossAmount).toBeNull();
    expect(b.netAmount).toBeNull();
    expect(b.roomRevenue).toBeNull();
    expect(b.refundedAmount).toBeNull();
  });
});

// ── 4/5/6. Lifecycle, cancellation, refund ────────────────────────────────

describe("4/5/6. lifecycle history is append-only", () => {
  test("cancellation and refund are NEW rows; history is never overwritten", async () => {
    const booking = await mkBooking(fx.agencyA, fx.hotelA, `RES-${randomUUID()}`);
    const t0 = new Date(Date.now() - 3 * 86_400_000);

    for (const [status, at, amounts] of [
      ["CONFIRMED", t0, { grossAmount: "25000.00" }],
      ["MODIFIED", new Date(t0.getTime() + 86_400_000), { grossAmount: "30000.00" }],
      ["CANCELLED", new Date(t0.getTime() + 2 * 86_400_000), {}],
      ["REFUNDED", new Date(t0.getTime() + 3 * 86_400_000), { refundedAmount: "30000.00" }],
    ] as const) {
      await prisma.bookingStatusEvent.create({
        data: {
          agencyId: fx.agencyA,
          bookingId: booking.id,
          status,
          occurredAt: at,
          source: "test_provider",
          currency: "INR",
          ...amounts,
        },
      });
    }

    const history = await prisma.bookingStatusEvent.findMany({
      where: { bookingId: booking.id },
      orderBy: { occurredAt: "asc" },
      select: { status: true, grossAmount: true, refundedAmount: true },
    });

    // The full trail survives — original value → modification → cancellation → refund.
    expect(history.map((h) => h.status)).toEqual(["CONFIRMED", "MODIFIED", "CANCELLED", "REFUNDED"]);
    expect(Number(history[0].grossAmount)).toBe(25000);
    expect(Number(history[1].grossAmount)).toBe(30000); // the original is NOT overwritten
    expect(Number(history[3].refundedAmount)).toBe(30000);
  });

  test("the booking's current status can advance without losing the trail", async () => {
    const booking = await mkBooking(fx.agencyA, fx.hotelA, `RES-${randomUUID()}`);
    await prisma.bookingStatusEvent.create({
      data: { agencyId: fx.agencyA, bookingId: booking.id, status: "CANCELLED", occurredAt: new Date(), source: "test_provider" },
    });
    const updated = await prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED" } });
    expect(updated.status).toBe("CANCELLED");
    expect(await prisma.bookingStatusEvent.count({ where: { bookingId: booking.id } })).toBe(1);
  });
});

// ── 9/10/11. Journey match as separate evidence ───────────────────────────

describe("9/10/11. BookingJourneyMatch", () => {
  test("a booking is valid with NO match at all (unknown stays unknown)", async () => {
    const b = await mkBooking(fx.agencyA, fx.hotelA, `RES-${randomUUID()}`);
    expect(await prisma.bookingJourneyMatch.count({ where: { bookingId: b.id } })).toBe(0);
  });

  test("a deterministic match records method and confidence", async () => {
    const b = await mkBooking(fx.agencyA, fx.hotelA, `RES-${randomUUID()}`);
    const m = await prisma.bookingJourneyMatch.create({
      data: {
        agencyId: fx.agencyA,
        hotelClientId: fx.hotelA,
        bookingId: b.id,
        visitorId: `vis_${randomUUID()}`,
        matchMethod: "visitor_id",
        matchConfidence: gradeMatch({ method: "visitor_id", candidateCount: 1 }),
        evidence: { matchedOn: "visitorId", candidateCount: 1 },
      },
    });
    expect(m.matchMethod).toBe("visitor_id");
    expect(m.matchConfidence).toBe("DETERMINISTIC");
  });

  test("AMBIGUITY IS PRESERVED — two candidates produce two PARTIAL rows", async () => {
    const b = await mkBooking(fx.agencyA, fx.hotelA, `RES-${randomUUID()}`, {
      guestEmailHash: hashGuestEmail(GUEST_EMAIL),
    });
    const confidence = gradeMatch({ method: "email_hash", candidateCount: 2 });
    expect(confidence).toBe("PARTIAL");

    for (const v of [`vis_${randomUUID()}`, `vis_${randomUUID()}`]) {
      await prisma.bookingJourneyMatch.create({
        data: {
          agencyId: fx.agencyA, hotelClientId: fx.hotelA, bookingId: b.id,
          visitorId: v, matchMethod: "email_hash", matchConfidence: confidence,
          evidence: { matchedOn: "guestEmailHash", candidateCount: 2 },
        },
      });
    }
    const rows = await prisma.bookingJourneyMatch.findMany({ where: { bookingId: b.id } });
    expect(rows).toHaveLength(2); // NOT collapsed to one "best" guess
    expect(rows.every((r) => r.matchConfidence === "PARTIAL")).toBe(true);
  });

  test("defaults are the safe ones when nothing is asserted", async () => {
    const b = await mkBooking(fx.agencyA, fx.hotelA, `RES-${randomUUID()}`);
    const m = await prisma.bookingJourneyMatch.create({
      data: { agencyId: fx.agencyA, hotelClientId: fx.hotelA, bookingId: b.id },
    });
    expect(m.matchMethod).toBe("unknown");
    expect(m.matchConfidence).toBe("UNKNOWN");
  });

  test("a guest email hashed booking-side matches the tracking-side hash", async () => {
    const visitorId = `vis_${randomUUID()}`;
    // The tracking side stores the hash via the snippet's identify event; here we
    // write the equivalent row directly, then match a booking to it by hash alone.
    await prisma.visitorIdentity.create({
      data: {
        visitorId, hotelClientId: fx.hotelA, agencyId: fx.agencyA,
        emailHash: hashGuestEmail(GUEST_EMAIL), identifiedAt: new Date(),
      },
    });
    const b = await mkBooking(fx.agencyA, fx.hotelA, `RES-${randomUUID()}`, {
      guestEmailHash: hashGuestEmail(GUEST_EMAIL),
    });
    const candidates = await prisma.visitorIdentity.findMany({
      where: { hotelClientId: fx.hotelA, emailHash: b.guestEmailHash },
      select: { visitorId: true },
    });
    expect(candidates.map((c) => c.visitorId)).toContain(visitorId);
  });
});

// ── 3/12. Tenant isolation ────────────────────────────────────────────────

describe("3/12. tenant isolation", () => {
  test("agency B cannot read agency A's bookings through the scoped client", async () => {
    const ext = `RES-${randomUUID()}`;
    await mkBooking(fx.agencyA, fx.hotelA, ext);
    const seenByB = await agencyScopedFor(fx.agencyB, prisma.booking).findMany({
      where: { externalBookingId: ext },
    });
    expect(seenByB).toHaveLength(0);
  });

  test("the same external booking id can exist for two different hotels", async () => {
    const ext = `RES-SHARED-${randomUUID()}`;
    await mkBooking(fx.agencyA, fx.hotelA, ext);
    const forB = await mkBooking(fx.agencyB, fx.hotelB, ext);
    expect(forB.hotelClientId).toBe(fx.hotelB);
  });

  test("a match cannot be read across hotels", async () => {
    const b = await mkBooking(fx.agencyA, fx.hotelA, `RES-${randomUUID()}`);
    await prisma.bookingJourneyMatch.create({
      data: { agencyId: fx.agencyA, hotelClientId: fx.hotelA, bookingId: b.id, matchMethod: "manual", matchConfidence: "PARTIAL" },
    });
    const seenByB = await agencyScopedFor(fx.agencyB, prisma.bookingJourneyMatch).findMany({
      where: { bookingId: b.id },
    });
    expect(seenByB).toHaveLength(0);
  });

  test("the provider credential never rides along in a query result", async () => {
    await prisma.bookingConnection.create({
      data: { agencyId: fx.agencyA, hotelClientId: fx.hotelA, provider: "test_provider", credentials: "ciphertext-should-be-stripped" },
    });
    const row = await prisma.bookingConnection.findFirst({ where: { hotelClientId: fx.hotelA } });
    expect(row).not.toBeNull();
    expect((row as unknown as Record<string, unknown>).credentials).toBeUndefined();
  });
});

// ── 13/14. Legacy conversions remain distinguishable ──────────────────────

describe("13/14. legacy tracking is untouched and distinguishable", () => {
  test("a scraped TrackingEvent conversion and a real Booking coexist independently", async () => {
    const sessionId = `sess_${randomUUID()}`;
    const legacy = await prisma.trackingEvent.create({
      data: {
        agencyId: fx.agencyA, hotelClientId: fx.hotelA, eventType: "conversion",
        pageUrl: "https://hotel.example/thank-you", conversionValue: "9999.00",
        sessionId, deviceType: "desktop",
      },
    });
    const real = await mkBooking(fx.agencyA, fx.hotelA, `RES-${randomUUID()}`, { grossAmount: "25000.00" });

    // Two different tables, two different fields — no silent merge, no rename.
    expect(Number(legacy.conversionValue)).toBe(9999);
    expect(Number(real.grossAmount)).toBe(25000);
    // The booking carries no conversionValue and the event carries no grossAmount.
    expect((real as unknown as Record<string, unknown>).conversionValue).toBeUndefined();
    expect((legacy as unknown as Record<string, unknown>).grossAmount).toBeUndefined();
  });
});
