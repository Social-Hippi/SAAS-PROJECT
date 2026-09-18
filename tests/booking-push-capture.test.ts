import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import { webhookBaseUrl } from "@/lib/webhook-url";

// ─────────────────────────────────────────────────────────────────────────────
// Booking Push: never answer and lose.
//
// Simplotel's first test bookings reached the thank-you pages — the snippet
// recorded both — but never the Booking Push route. Two things on our side
// stood in the way, and each is pinned here:
//
//   1. The URL we showed was the bare domain, which answers a POST with a 308.
//      A webhook client does not follow that, so the push stopped at the edge:
//      no booking, no error, no log.
//   2. Even a push that arrived would have been answered 422 and its body
//      dropped — losing the booking and the very sample the parser must be
//      written from.
//
// The DB-backed half (held rows really are encrypted, stamped, tenant-bound)
// lives in tests/booking-push-receiver.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE = readCode("app/api/integrations/booking/[provider]/route.ts");
const CAPTURE = readCode("lib/booking-push-capture.ts");
const CARD = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/BookingConnectionCard.tsx");
const PAGE = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/page.tsx");

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const MIGRATION = readFileSync(
  join(MIGRATIONS, readdirSync(MIGRATIONS).find((d) => d.endsWith("_booking_push_capture"))!, "migration.sql"),
  "utf8",
);

describe("1. the URL a provider is given answers directly", () => {
  test("the bare domain is rewritten to www", () => {
    expect(webhookBaseUrl("https://hoteltrack.in")).toBe("https://www.hoteltrack.in");
    expect(webhookBaseUrl("https://hoteltrack.in/")).toBe("https://www.hoteltrack.in");
  });

  test("a host that already answers directly is left alone", () => {
    expect(webhookBaseUrl("https://www.hoteltrack.in")).toBe("https://www.hoteltrack.in");
    // Preview deployments and local dev must keep their own host.
    expect(webhookBaseUrl("https://saas-project-git-x.vercel.app")).toBe(
      "https://saas-project-git-x.vercel.app",
    );
    expect(webhookBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  test("the Booking Push card builds its endpoint from the webhook base, not the app URL", () => {
    expect(CARD).toMatch(/const endpoint = `\$\{webhookBase\}\/api\/integrations\/booking\/\$\{provider\}`/);
    expect(CARD).not.toMatch(/\$\{appUrl\}\/api\/integrations\/booking/);
    expect(PAGE).toMatch(/webhookBase=\{webhookBaseUrl\(appUrl\)\}/);
  });
});

describe("2. an authenticated body is held, never answered and dropped", () => {
  test("an unmappable body is held and answered 202", () => {
    expect(ROUTE).toMatch(/held\(connection, provider, "unmapped_payload", parsed\.error, rawBody\)/);
    expect(ROUTE).toMatch(/json\(202, \{ held: true \}\)/);
    // The old drop must be gone.
    expect(ROUTE).not.toMatch(/return json\(422, \{ error: parsed\.error \}\)/);
  });

  test("events the ingester refused are held too", () => {
    expect(ROUTE).toMatch(/if \(rejected > 0\)/);
    expect(ROUTE).toMatch(/accepted === 0 \? "rejected" : "partial"/);
  });

  test("a body that could not be held is answered 5xx, so a provider retries", () => {
    // Claiming a body was accepted when it was not would lose the booking with
    // no trace — the one outcome this exists to prevent.
    expect(ROUTE).toMatch(/: json\(503, \{ error: "Temporarily unavailable" \}\)/);
    expect(ROUTE).toMatch(/if \(!\(await held\(/);
    expect(CAPTURE).toMatch(/export async function holdPush/);
    // holdPush must propagate failure rather than swallow it.
    const hold = CAPTURE.slice(CAPTURE.indexOf("export async function holdPush"));
    expect(hold.slice(0, hold.indexOf("\n}\n"))).not.toMatch(/catch/);
  });

  test("holding happens only after authentication", () => {
    const authAt = ROUTE.indexOf('outcome: "invalid_auth"');
    const firstHold = ROUTE.indexOf("await held(");
    expect(authAt).toBeGreaterThan(-1);
    expect(firstHold).toBeGreaterThan(authAt);
  });

  test("the body is encrypted before it is stored", () => {
    expect(CAPTURE).toMatch(/bodyEncrypted: encryptToken\(rawBody\)/);
  });

  test("the stored reason is the parser's, never the body's", () => {
    expect(CAPTURE).toMatch(/reason: reason \? reason\.slice\(0, 500\) : null/);
  });
});

describe("3. whether the provider reached us survives the log window", () => {
  test("every post-authentication outcome stamps the connection", () => {
    for (const outcome of ["bad_content_type", "body_too_large", "malformed_json", "no_events", "accepted"]) {
      expect(ROUTE).toContain(`stampPush(connection, "${outcome}")`);
    }
  });

  test("a failed stamp never fails the push", () => {
    const stamp = CAPTURE.slice(CAPTURE.indexOf("export async function stampPush"));
    expect(stamp.slice(0, stamp.indexOf("\n}\n"))).toMatch(/catch/);
  });

  test("the card shows the last push and how many are held", () => {
    expect(CARD).toMatch(/connection\.lastPushAt/);
    expect(CARD).toMatch(/connection\.heldPushCount > 0/);
  });
});

describe("4. held bodies are tenant-isolated at every layer", () => {
  test("writes and counts go through the agency scope", () => {
    expect(CAPTURE).toMatch(/agencyScopedFor\(connection\.agencyId, prisma\.bookingPushCapture\)\.create/);
    expect(CAPTURE).toMatch(/agencyScopedFor\(agencyId, prisma\.bookingPushCapture\)\.count/);
  });

  test("the table gets the same RLS policy as every tenant table", () => {
    // Held bodies carry guest PII, so they must be unreadable across agencies at
    // the database layer too, not only in application code.
    expect(MIGRATION).toContain("ARRAY['BookingPushCapture']");
    expect(MIGRATION).toContain("ENABLE ROW LEVEL SECURITY");
    expect(MIGRATION).toContain("CREATE POLICY tenant_isolation");
  });
});

describe("5. no migration carries tool output", () => {
  test("every migration is SQL only — no CLI banners", () => {
    // `prisma migrate diff … 2>&1 > migration.sql` captured Prisma's "Update
    // available" box into this PR's migration, and Postgres refused the box-
    // drawing characters. CI caught it; nothing local did, because no local
    // test APPLIES migrations. Scan them all, since every earlier migration was
    // generated the same way and only escaped because no update was available.
    for (const dir of readdirSync(MIGRATIONS)) {
      if (!/^\d{14}_/.test(dir)) continue;
      const sql = readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8");
      // Box-drawing rules INSIDE a `--` comment are fine and common here; what
      // Postgres rejects is one on a line that is not a comment.
      const code = sql.split("\n").filter((l) => !l.trim().startsWith("--"));
      for (const line of code) {
        expect(line, dir).not.toMatch(/[┌┐└┘│]/);
        expect(line, dir).not.toMatch(/Update available|npm i |pris\.ly|Loaded Prisma config/);
      }
    }
  });
});
