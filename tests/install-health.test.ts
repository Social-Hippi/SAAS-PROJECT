import { describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Install health — the diagnostic that would have caught Aster's broken
// booking-engine install on day one instead of after weeks of silent loss.
//
// The DB-touching resolver lives in lib/install-health.ts (server-only); these
// cover the pure halves — redaction and origin parsing — plus the source-level
// guarantees that matter for a public, unauthenticated endpoint.
// ─────────────────────────────────────────────────────────────────────────────

import { redactSiteId, originHost } from "@/lib/install-health";

const REAL = "cmru6bnmo000104l6vl4yiwa6";   // Aster's true siteId
const BROKEN = "cmru6bnm00010416vl4yiwa6";  // what its booking engine ships

describe("siteId redaction", () => {
  test("keeps enough to recognise a near-miss of a real id", () => {
    const a = redactSiteId(REAL);
    const b = redactSiteId(BROKEN);
    expect(a.head).toBe(b.head);            // same prefix — clearly the same intent
    expect(a.length).not.toBe(b.length);    // 25 vs 24 — the tell
    expect(b.length).toBe(24);
  });

  test("never reveals a working id", () => {
    const r = redactSiteId(REAL);
    const shown = r.head + r.tail;
    expect(shown.length).toBeLessThan(REAL.length);
    expect(REAL).not.toBe(shown);
    expect(REAL.includes(r.head)).toBe(true);
  });

  test("is safe for short or empty input", () => {
    expect(() => redactSiteId("")).not.toThrow();
    expect(redactSiteId("abc").length).toBe(3);
  });
});

describe("origin parsing", () => {
  const h = (o: Record<string, string>) => new Headers(o);

  test("reads the Origin header", () => {
    expect(originHost(h({ origin: "https://bookings.coffeeberryhills.in" }))).toBe("bookings.coffeeberryhills.in");
  });

  test("falls back to Referer when Origin is absent", () => {
    expect(originHost(h({ referer: "https://asterholidays.com/rooms/?x=1" }))).toBe("asterholidays.com");
  });

  test("prefers Origin over Referer", () => {
    expect(originHost(h({ origin: "https://a.example", referer: "https://b.example" }))).toBe("a.example");
  });

  test("returns null when absent or unparseable — never throws", () => {
    expect(originHost(h({}))).toBeNull();
    expect(originHost(h({ origin: "not a url" }))).toBeNull();
  });
});

describe("the public endpoints stay write-free", () => {
  const read = async (rel: string) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    return readFileSync(join(__dirname, "..", rel), "utf8");
  };

  test("the diagnostic never writes to the database", async () => {
    const src = await read("lib/install-health.ts");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    // A public, unauthenticated path must not let anyone amplify writes.
    for (const w of ["prisma.alert", ".create(", ".update(", ".upsert(", ".delete("]) {
      expect(code).not.toContain(w);
    }
    expect(code).toContain("findMany");
  });

  test("an ambiguous origin resolves to NO hotel rather than the wrong one", async () => {
    const src = await read("lib/install-health.ts");
    expect(src).toContain("matches.length === 1");
  });

  test("both rejection paths emit the diagnostic", async () => {
    for (const f of ["app/api/track/config/route.ts", "app/api/track/event/route.ts"]) {
      expect(await read(f)).toContain("logSnippetRejection");
    }
  });
});
