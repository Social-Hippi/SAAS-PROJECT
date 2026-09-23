import "dotenv/config";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Simplotel Booking Push receiver.
//
// Covers the transport, authentication, tenant resolution, idempotency and
// journey-matching layers — everything AROUND the provider payload mapping,
// which is deliberately unimplemented until Simplotel supplies a sample (see
// lib/booking-providers/simplotel.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { POST as pushPOST, GET as pushGET } from "@/app/api/integrations/booking/[provider]/route";
import { encryptToken } from "@/lib/encryption";


const PREFIX = "TEST_BP_";
const SECRET_A = "sk_test_simplotel_aaaaaaaaaaaaaaaaaaaa";
const SECRET_B = "sk_test_simplotel_bbbbbbbbbbbbbbbbbbbb";

type Fx = {
  agencyA: string; hotelA: string; connA: { id: string; agencyId: string; hotelClientId: string; provider: string };
  agencyB: string; hotelB: string;
};
let fx: Fx;
const logs: string[] = [];

/**
 * Self-contained key material. These tests encrypt a connection secret, so they
 * must not depend on an ambient ENCRYPTION_KEY being present in the shell — the
 * same snapshot/restore pattern tests/encryption.test.ts uses.
 */
const ENV_KEYS = ["ENCRYPTION_KEY_VERSION", "ENCRYPTION_KEY_V1", "ENCRYPTION_KEY"] as const;
let envSnapshot: Record<string, string | undefined> = {};

const params = (provider: string) => ({ params: Promise.resolve({ provider }) });

/** Push with the Authorization header set VERBATIM, prefix and all. */
function pushRawAuth(body: string, authorization: string) {
  return pushPOST(
    new Request("http://localhost/api/integrations/booking/simplotel", {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body,
    }),
    params("simplotel"),
  );
}

function push(body: string, opts: { auth?: string | null; provider?: string; contentType?: string } = {}) {
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "application/json",
  };
  if (opts.auth !== null) headers.authorization = `Bearer ${opts.auth ?? SECRET_A}`;
  return pushPOST(
    new Request("http://localhost/api/integrations/booking/simplotel", {
      method: "POST", headers, body,
    }),
    params(opts.provider ?? "simplotel"),
  );
}

async function mkTenant(tag: string, secret: string | null) {
  const agency = await prisma.agency.create({
    data: { name: `${PREFIX}${tag}`, email: `${PREFIX.toLowerCase()}${tag}@x.test`, subscriptionStatus: "active" },
  });
  const hotel = await prisma.hotelClient.create({
    data: {
      agencyId: agency.id, name: `${PREFIX}${tag}`, websiteUrl: `https://${tag}.example`,
      contactName: "C", contactEmail: "c@t.local",
      siteId: `${PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      conversionMethod: "url_change",
    },
  });
  const conn = secret
    ? await prisma.bookingConnection.create({
        data: {
          agencyId: agency.id, hotelClientId: hotel.id, provider: "simplotel",
          credentials: encryptToken(secret), status: "active",
        },
        select: { id: true, agencyId: true, hotelClientId: true, provider: true },
      })
    : null;
  return { agencyId: agency.id, hotelId: hotel.id, conn };
}

beforeAll(async () => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ENCRYPTION_KEY_V1 = "11".repeat(32);
  process.env.ENCRYPTION_KEY_VERSION = "v1";
  vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const a = await mkTenant("A", SECRET_A);
  const b = await mkTenant("B", SECRET_B);
  fx = { agencyA: a.agencyId, hotelA: a.hotelId, connA: a.conn!, agencyB: b.agencyId, hotelB: b.hotelId };
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  vi.restoreAllMocks();
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

// ── Transport + authentication ───────────────────────────────────────────

describe("route is reachable server-to-server", () => {
  test("the receiver is declared PUBLIC in the proxy", async () => {
    // A booking provider has no Clerk session. Without this the middleware
    // redirects the push to sign-in (307) and it never reaches the handler —
    // which is exactly what production smoke testing caught.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const proxy = readFileSync(join(__dirname, "..", "proxy.ts"), "utf8");
    expect(proxy).toContain("/api/integrations/booking(.*)");
    const publicBlock = proxy.slice(proxy.indexOf("isPublicRoute"), proxy.indexOf("isAgencyRoute"));
    expect(publicBlock).toContain("/api/integrations/booking(.*)");
  });
});

describe("transport and authentication", () => {
  test("GET is rejected — POST only", async () => {
    expect((await pushGET()).status).toBe(405);
  });

  test("unknown provider → 404 before any credential work", async () => {
    expect((await push("{}", { provider: "not-a-provider" })).status).toBe(404);
  });

  test("MISSING authentication → 401", async () => {
    const res = await push("{}", { auth: null });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Missing Authorization");
  });

  test("INVALID authentication → 403", async () => {
    const res = await push("{}", { auth: "sk_wrong_secret_value_00000000000000" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Invalid credentials");
  });

  test("a BARE token authenticates, exactly as a Bearer one does", async () => {
    // Simplotel's Booking Push form is a free-text JSON box, and the example it
    // ships shows a bare token: {"Authorization": "a9c98543dd94..."}. A partner
    // copying that shape would otherwise get a 401 indistinguishable from a
    // wrong secret — and the round trip to discover why runs to weeks.
    //
    // 202 is the PASS here: authentication succeeded and the request reached the
    // adapter, which cannot map any body until the payload contract is agreed —
    // so the body is held for replay rather than refused.
    const res = await pushRawAuth("{}", SECRET_A);
    expect(res.status).toBe(202);
  });

  test("a bare token that is not the secret is still refused", async () => {
    // Tolerating the prefix must not tolerate the credential.
    const res = await pushRawAuth("{}", "sk_wrong_secret_value_00000000000000");
    expect(res.status).toBe(403);
  });

  test("wrong content type → 415", async () => {
    expect((await push("{}", { contentType: "text/plain" })).status).toBe(415);
  });

  test("MALFORMED JSON → 400", async () => {
    const res = await push("{not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Malformed JSON");
  });

  test("oversized body → 413", async () => {
    expect((await push(JSON.stringify({ pad: "x".repeat(300_000) }))).status).toBe(413);
  });
});

// ── Mapping boundary ─────────────────────────────────────────────────────

describe("mapping boundary", () => {
  test("a REAL Simplotel payload is recorded as a booking", async () => {
    // Written from the bodies Simplotel actually sent on 19 and 21 Sep.
    const body = {
      hotel_id: "8642",
      booking_id: `${PREFIX}SKQVHO`,
      checkin_date: "2026-09-28",
      checkout_date: "2026-09-29",
      total_amount: "9086.0000",
      booking_status: "CONFIRMED",
      name: "A Guest",
      email: "guest@example.test",
      phone: "919000000051",
      rooms: [
        {
          total_taxes: "1386.0000",
          total_amount_before_taxes: "7700.0000",
          total_amount: "9086.0000",
          is_cancelled: false,
          refund_amount: "0.0000",
        },
      ],
      booking_date: "2026-09-21",
    };
    const res = await push(JSON.stringify(body));
    expect(res.status).toBe(200);

    const booking = await prisma.booking.findFirst({
      where: { hotelClientId: fx.hotelA, externalBookingId: `${PREFIX}SKQVHO` },
    });
    expect(booking).not.toBeNull();
    expect(booking!.status).toBe("CONFIRMED");
    expect(booking!.grossAmount?.toString()).toBe("9086");
    expect(booking!.taxAmount?.toString()).toBe("1386");
    // No journey id is sent, so none is stored — matching falls back to hashes.
    expect(booking!.journeySessionId).toBeNull();
    expect(booking!.guestPhoneHash).not.toBeNull();
    // Currency is unknown, never assumed.
    expect(booking!.currency).toBeNull();
  });

  test("an AUTHENTICATED push that cannot be mapped is HELD and answered 202", async () => {
    // It used to be answered 422 and dropped. That lost the booking AND the
    // sample the parser has to be written from, and providers rarely retry a
    // 4xx — so the first real pushes would have been lost for good.
    const res = await push(JSON.stringify({ anything: "at all" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ held: true });
  });

  test("a body that cannot be filed creates no booking", async () => {
    const before = await prisma.booking.count({ where: { hotelClientId: fx.hotelA } });
    await push(JSON.stringify({ reservation_id: "R1", total: 5000 }));
    expect(await prisma.booking.count({ where: { hotelClientId: fx.hotelA } })).toBe(before);
  });

  test("the held body is stored ENCRYPTED, recoverable, and never in plain text", async () => {
    const marker = "HELD_MARKER_guest@example.test";
    await push(JSON.stringify({ reservation_id: "R-HOLD", guest_email: marker }));
    const row = await prisma.bookingPushCapture.findFirst({
      where: { connectionId: fx.connA.id },
      orderBy: { receivedAt: "desc" },
    });
    expect(row).not.toBeNull();
    expect(row!.outcome).toBe("unmapped_payload");
    // The reason names what was wrong with THIS body, so a held push explains
    // itself: here, no booking_id to file it under.
    expect(row!.reason).toMatch(/booking_id/);
    expect(row!.replayedAt).toBeNull();
    // Guest PII must not sit in the column in the clear…
    expect(row!.bodyEncrypted).not.toContain(marker);
    // …but must come back intact, or replay has nothing to work from.
    const { decryptToken } = await import("@/lib/encryption");
    expect(JSON.parse(decryptToken(row!.bodyEncrypted).reveal()).guest_email).toBe(marker);
  });

  test("the connection records that the provider reached us", async () => {
    // Vercel keeps about an hour of logs. Without this stamp, "did they reach
    // us at all?" had no answer an hour after a provider tried.
    await push(JSON.stringify({ reservation_id: "R-STAMP" }));
    const conn = await prisma.bookingConnection.findUnique({
      where: { id: fx.connA.id },
      select: { lastPushAt: true, lastPushOutcome: true },
    });
    expect(conn!.lastPushAt).not.toBeNull();
    expect(conn!.lastPushOutcome).toBe("unmapped_payload");
  });

  test("an UNAUTHENTICATED caller can hold nothing", async () => {
    // Otherwise the table is a free storage bucket for anyone who finds the URL.
    const before = await prisma.bookingPushCapture.count();
    await push(JSON.stringify({ spam: true }), { auth: "sk_wrong_secret_value_00000000000000" });
    await push(JSON.stringify({ spam: true }), { auth: null });
    expect(await prisma.bookingPushCapture.count()).toBe(before);
  });
});

// ── Secrets and PII never reach the logs ─────────────────────────────────

describe("logging safety", () => {
  test("no credential material is ever logged", async () => {
    logs.length = 0;
    await push(JSON.stringify({ guest_email: "someone@example.test" }));
    const all = logs.join("\n");
    expect(all).not.toContain(SECRET_A);
    expect(all).not.toContain(SECRET_B);
  });

  test("no guest PII is ever logged", async () => {
    logs.length = 0;
    await push(JSON.stringify({ guest_email: "leaky@example.test", phone: "+919000011111" }));
    const all = logs.join("\n");
    for (const needle of ["leaky@example.test", "+919000011111", "9000011111"]) {
      expect(all).not.toContain(needle);
    }
  });

  test("the raw body is never echoed into logs", async () => {
    logs.length = 0;
    await push(JSON.stringify({ secretish: "MARKER_DO_NOT_LOG_12345" }));
    expect(logs.join("\n")).not.toContain("MARKER_DO_NOT_LOG_12345");
  });
});

// ── Tenant resolution comes from the SECRET, never the body ──────────────

describe("tenant safety", () => {
  test("a body naming another agency/hotel cannot redirect the write", async () => {
    // Authenticated as tenant A but asking for tenant B — the body has no say.
    const res = await push(JSON.stringify({ agencyId: fx.agencyB, hotelClientId: fx.hotelB }));
    expect(res.status).toBe(202); // held at mapping, not routed by the body
    expect(await prisma.booking.count({ where: { hotelClientId: fx.hotelB } })).toBe(0);
    // The held copy belongs to the tenant the SECRET named, never the body's.
    expect(await prisma.bookingPushCapture.count({ where: { hotelClientId: fx.hotelB } })).toBe(0);
  });

  test("tenant B's secret resolves to tenant B, never tenant A", async () => {
    const res = await push(JSON.stringify({}), { auth: SECRET_B });
    expect(res.status).toBe(202);
    const line = logs.filter((l) => l.includes("[BOOKING-PUSH]")).at(-1) ?? "";
    expect(line).not.toContain(fx.connA.id);
  });
});
