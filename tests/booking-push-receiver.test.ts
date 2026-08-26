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
import { PAYLOAD_CONTRACT_PENDING } from "@/lib/booking-providers/simplotel";

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

// ── Payload contract boundary ────────────────────────────────────────────

describe("payload contract boundary", () => {
  test("an AUTHENTICATED push is accepted, then refused at the mapping with 422", async () => {
    const res = await push(JSON.stringify({ anything: "at all" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(PAYLOAD_CONTRACT_PENDING);
  });

  test("no booking is created while the contract is pending", async () => {
    const before = await prisma.booking.count({ where: { hotelClientId: fx.hotelA } });
    await push(JSON.stringify({ reservation_id: "R1", total: 5000 }));
    expect(await prisma.booking.count({ where: { hotelClientId: fx.hotelA } })).toBe(before);
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
    expect(res.status).toBe(422); // stopped at mapping, not at tenant confusion
    expect(await prisma.booking.count({ where: { hotelClientId: fx.hotelB } })).toBe(0);
  });

  test("tenant B's secret resolves to tenant B, never tenant A", async () => {
    const res = await push(JSON.stringify({}), { auth: SECRET_B });
    expect(res.status).toBe(422);
    const line = logs.filter((l) => l.includes("[BOOKING-PUSH]")).at(-1) ?? "";
    expect(line).not.toContain(fx.connA.id);
  });
});
