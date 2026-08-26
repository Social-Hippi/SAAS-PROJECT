import "dotenv/config";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Install health — DB-backed resolution.
//
// Aster's booking engine shipped a siteId with `o` read as `0` and `l` as `1`.
// Every event from that host was rejected 403 and nothing recorded it, so 100%
// of booking-engine traffic vanished silently for weeks.
//
// These prove the diagnostic can now name the hotel behind a rejected request
// whenever the origin resolves DETERMINISTICALLY — and, just as important, that
// it names nobody when the origin is ambiguous.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { GET as configGET } from "@/app/api/track/config/route";
import { resolveHotelByOrigin, redactSiteId } from "@/lib/install-health";

const PREFIX = "TEST_IH_";
const SITE_HOST = "ih-hotel.example";
const BOOKING_HOST = "bookings.ih-hotel.example";

let hotelId: string, siteId: string, otherHotelId: string, dupA: string, dupB: string;

const cfg = (id: string | null, origin?: string) =>
  configGET(new Request(`http://localhost/api/track/config${id === null ? "" : `?id=${id}`}`, {
    headers: origin ? { origin: `https://${origin}` } : {},
  }));

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const a = await prisma.agency.create({
    data: { name: `${PREFIX}A`, email: `${PREFIX.toLowerCase()}a@x.test`, subscriptionStatus: "active" },
  });
  const b = await prisma.agency.create({
    data: { name: `${PREFIX}B`, email: `${PREFIX.toLowerCase()}b@x.test`, subscriptionStatus: "active" },
  });
  const mk = (agencyId: string, tag: string, website: string, domains: string[]) =>
    prisma.hotelClient.create({
      data: {
        agencyId, name: `${PREFIX}${tag}`, websiteUrl: website,
        contactName: "C", contactEmail: "c@t.local",
        siteId: `${PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conversionMethod: "url_change", bookingDomains: domains,
      },
    });

  const h = await mk(a.id, "Main", `https://${SITE_HOST}`, [BOOKING_HOST]);
  hotelId = h.id; siteId = h.siteId;
  otherHotelId = (await mk(b.id, "Other", "https://ih-other.example", [])).id;
  // Two hotels in DIFFERENT agencies both claiming the same booking host.
  dupA = (await mk(a.id, "DupA", "https://ih-dup-a.example", ["dup.ih-hotel.example"])).id;
  dupB = (await mk(b.id, "DupB", "https://ih-dup-b.example", ["dup.ih-hotel.example"])).id;
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe("endpoint validation", () => {
  test("VALID site id → 200 with config", async () => {
    const res = await cfg(siteId, SITE_HOST);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.bookingDomains).toContain(BOOKING_HOST);
  });

  test("INVALID site id → 403, and no config leaks", async () => {
    const res = await cfg("cmru6bnm00010416vl4yiwa6", BOOKING_HOST);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Unknown site id");
    expect(body.bookingDomains).toBeUndefined();
    expect(body.thankYouUrlPattern).toBeUndefined();
  });

  test("MISSING site id → 400", async () => {
    const res = await cfg(null);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Missing id");
  });

  test("a rejection never reveals a working id", () => {
    const r = redactSiteId(siteId);
    expect(r.head.length + r.tail.length).toBeLessThan(siteId.length);
  });
});

describe("origin → hotel resolution", () => {
  test("resolves the hotel from its own website host", async () => {
    expect((await resolveHotelByOrigin(SITE_HOST))?.id).toBe(hotelId);
  });

  test("resolves the hotel from a configured BOOKING-ENGINE host", async () => {
    // Exactly Aster's case: the rejected request came from the booking engine.
    expect((await resolveHotelByOrigin(BOOKING_HOST))?.id).toBe(hotelId);
  });

  test("tolerates a www. prefix on the website host", async () => {
    expect((await resolveHotelByOrigin(`www.${SITE_HOST}`))?.id).toBe(hotelId);
  });

  test("WRONG hotel: an unrelated origin resolves to nobody", async () => {
    expect(await resolveHotelByOrigin("totally-unrelated.example")).toBeNull();
  });

  test("WRONG tenant: hotel B's origin never resolves to hotel A", async () => {
    const r = await resolveHotelByOrigin("ih-other.example");
    expect(r?.id).toBe(otherHotelId);
    expect(r?.id).not.toBe(hotelId);
  });

  test("DUPLICATE configuration: an ambiguous host names NOBODY", async () => {
    // Two hotels in two agencies claim dup.ih-hotel.example. Naming either
    // would be a cross-tenant guess, so the diagnostic must name neither.
    expect(await resolveHotelByOrigin("dup.ih-hotel.example")).toBeNull();
    expect(dupA).not.toBe(dupB);
  });

  test("a lookalike host never resolves", async () => {
    expect(await resolveHotelByOrigin(`evil-${SITE_HOST}`)).toBeNull();
  });

  test("no origin resolves to nobody", async () => {
    expect(await resolveHotelByOrigin(null)).toBeNull();
  });
});
