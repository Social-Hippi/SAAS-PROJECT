import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1B — booking foundation. PURE tests (no database).
//
// The architectural rule under test: a Booking is a FACT, and any belief about
// which marketing journey produced it is EVIDENCE held separately. These tests
// pin that separation into the schema itself, so a later change that "helpfully"
// moves visitorId onto Booking fails here rather than silently turning an
// inference into a fact.
// ─────────────────────────────────────────────────────────────────────────────

import {
  CONFIDENCE_RANK,
  gradeMatch,
  hashGuestEmail,
  hashGuestPhone,
  isAttributable,
  type MatchMethod,
} from "@/lib/booking-identity";
import { saltedHash } from "@/lib/pii";
import { normalizeEmail, normalizePhone } from "@/lib/pii-client";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const SCHEMA = read("prisma/schema.prisma");
const MIGRATION = read("prisma/migrations/20260824000000_add_booking_foundation/migration.sql");
/** Migration with `--` comment lines stripped, so "no DROP/TRUNCATE" assertions
 *  inspect actual STATEMENTS and are not tripped by prose in the header. */
const MIGRATION_SQL = MIGRATION.split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

function modelBlock(name: string): string {
  const start = SCHEMA.indexOf(`model ${name} {`);
  if (start < 0) throw new Error(`model ${name} not found`);
  return SCHEMA.slice(start, SCHEMA.indexOf("\n}", start));
}

// ── FACT vs EVIDENCE separation ───────────────────────────────────────────

describe("Booking is a FACT, not an attribution record", () => {
  const booking = () => modelBlock("Booking");

  test.each(["visitorId", "sessionId", "trackingEventId", "matchMethod", "matchConfidence"])(
    "Booking does NOT carry %s",
    (field) => {
      expect(booking()).not.toMatch(new RegExp(`^\\s+${field}\\s`, "m"));
    },
  );

  test("the attribution fields live on BookingJourneyMatch instead", () => {
    const match = modelBlock("BookingJourneyMatch");
    for (const field of ["visitorId", "sessionId", "trackingEventId", "matchMethod", "matchConfidence"]) {
      expect(match).toMatch(new RegExp(`^\\s+${field}\\s`, "m"));
    }
  });

  test("a booking can exist with no match at all (match is a separate table)", () => {
    // Nothing on Booking references BookingJourneyMatch as required.
    expect(booking()).toMatch(/journeyMatches\s+BookingJourneyMatch\[\]/);
    expect(modelBlock("BookingJourneyMatch")).toContain("bookingId     String");
  });

  test("multiple candidate matches per booking are allowed (ambiguity preserved)", () => {
    // A unique constraint here would force the system to pick one of two equally
    // valid candidates — manufacturing certainty. There must not be one.
    expect(modelBlock("BookingJourneyMatch")).not.toContain("@@unique");
  });
});

// ── Booking facts: idempotency, currency, revenue, channel ────────────────

describe("Booking entity", () => {
  const booking = () => modelBlock("Booking");

  test("2. idempotency key is (hotelClientId, provider, externalBookingId)", () => {
    expect(booking()).toContain("@@unique([hotelClientId, provider, externalBookingId])");
  });

  test("7. currency is nullable — unknown is representable, INR is never assumed", () => {
    expect(booking()).toMatch(/^\s+currency String\?/m);
    expect(booking()).not.toMatch(/currency\s+String\s+@default/);
    expect(booking()).not.toContain('"INR"');
  });

  test("8. every revenue field is nullable — a missing figure stays missing", () => {
    for (const f of ["grossAmount", "netAmount", "roomRevenue", "ancillaryRevenue", "taxAmount", "refundedAmount"]) {
      expect(booking()).toMatch(new RegExp(`${f}\\s+Decimal\\?`));
    }
    // No zero defaults: 0 would be a claim that the provider reported zero.
    expect(booking()).not.toMatch(/Decimal\?\s+@db\.Decimal\(12, 2\)\s+@default/);
  });

  test("bookingChannel exists and is separate from any marketing-source field", () => {
    expect(booking()).toMatch(/^\s+bookingChannel String\?/m);
    // The marketing source must NOT be duplicated onto the booking.
    for (const f of ["utmSource", "utmMedium", "utmCampaign", "gclid", "fbclid", "sourceType"]) {
      expect(booking()).not.toMatch(new RegExp(`^\\s+${f}\\s`, "m"));
    }
  });

  test("guest identity is stored ONLY as the salted hashes", () => {
    expect(booking()).toMatch(/guestEmailHash\s+String\?/);
    expect(booking()).toMatch(/guestPhoneHash\s+String\?/);
    expect(booking()).not.toMatch(/^\s+guestEmail\s+String/m);
    expect(booking()).not.toMatch(/^\s+guestPhone\s+String/m);
  });

  test("provider and bookingChannel are String, per the open-vocabulary rule", () => {
    expect(booking()).toMatch(/^\s+provider\s+String\s*$/m);
    expect(booking()).toMatch(/^\s+bookingChannel String\?/m);
  });
});

// ── Lifecycle is append-only ──────────────────────────────────────────────

describe("4/5/6. booking lifecycle", () => {
  test("BookingStatusEvent exists with its own amounts and occurredAt", () => {
    const ev = modelBlock("BookingStatusEvent");
    expect(ev).toMatch(/status\s+BookingStatus/);
    expect(ev).toMatch(/occurredAt DateTime/);
    for (const f of ["grossAmount", "netAmount", "refundedAmount", "currency"]) {
      expect(ev).toContain(f);
    }
  });

  test("the status vocabulary covers cancellation and refund", () => {
    const block = SCHEMA.slice(SCHEMA.indexOf("enum BookingStatus"));
    for (const v of ["CONFIRMED", "MODIFIED", "CANCELLED", "REFUNDED", "COMPLETED"]) {
      expect(block.slice(0, block.indexOf("}"))).toContain(v);
    }
  });

  test("history is append-only: no updatedAt on the event row", () => {
    // An updatedAt would invite in-place edits of history.
    expect(modelBlock("BookingStatusEvent")).not.toContain("updatedAt");
  });
});

// ── Deterministic identity: the hash chain is reproducible ────────────────

describe("deterministic guest identity", () => {
  const RAW_EMAIL = "Priya.Sharma@Example.COM";
  const RAW_PHONE = "+91 98765 43210";

  test("a booking-side email reproduces the EXACT VisitorIdentity.emailHash", () => {
    // What the browser would have produced for the same address…
    const clientHash = createHash("sha256").update(normalizeEmail(RAW_EMAIL)).digest("hex");
    const asStoredByTracking = saltedHash(clientHash);
    // …must equal what the booking side computes from the raw value.
    expect(hashGuestEmail(RAW_EMAIL)).toBe(asStoredByTracking);
    expect(hashGuestEmail(RAW_EMAIL)).not.toBeNull();
  });

  test("phone matching survives formatting differences", () => {
    const clientHash = createHash("sha256").update(normalizePhone(RAW_PHONE)).digest("hex");
    expect(hashGuestPhone(RAW_PHONE)).toBe(saltedHash(clientHash));
    expect(hashGuestPhone("09876543210")).toBe(hashGuestPhone("+91 98765 43210".replace("+91 ", "0")));
  });

  test("case and whitespace do not break the join", () => {
    expect(hashGuestEmail("  priya.sharma@example.com ")).toBe(hashGuestEmail("PRIYA.SHARMA@EXAMPLE.COM"));
  });

  test("the hash is not reversible to the raw value", () => {
    const h = hashGuestEmail(RAW_EMAIL)!;
    expect(h).not.toContain("priya");
    expect(h).not.toContain("example.com");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("blank/absent input yields null, never a join key that matches everything", () => {
    for (const v of ["", "   ", null, undefined]) {
      expect(hashGuestEmail(v as string | null)).toBeNull();
      expect(hashGuestPhone(v as string | null)).toBeNull();
    }
  });

  test("different people never collide", () => {
    expect(hashGuestEmail("a@example.com")).not.toBe(hashGuestEmail("b@example.com"));
  });
});

// ── 10/11. Match methods and confidence ──────────────────────────────────

describe("match methods and confidence", () => {
  test.each<[MatchMethod, number, string]>([
    ["tracking_event", 1, "DETERMINISTIC"],
    ["session_id", 1, "DETERMINISTIC"],
    ["visitor_id", 1, "DETERMINISTIC"],
    ["booking_id", 1, "DETERMINISTIC"],
    ["email_hash", 1, "STRONG"],
    ["phone_hash", 1, "STRONG"],
    ["customer_id", 1, "STRONG"],
    ["coupon_code", 1, "STRONG"],
    ["manual", 1, "PARTIAL"],
    ["unknown", 1, "UNKNOWN"],
  ])("%s with one candidate → %s", (method, count, expected) => {
    expect(gradeMatch({ method, candidateCount: count })).toBe(expected);
  });

  test("AMBIGUITY IS NEVER PROMOTED — two candidates downgrade to PARTIAL", () => {
    expect(gradeMatch({ method: "email_hash", candidateCount: 2 })).toBe("PARTIAL");
    expect(gradeMatch({ method: "tracking_event", candidateCount: 2 })).toBe("PARTIAL");
  });

  test("no candidates → UNKNOWN, whatever the method claims", () => {
    for (const m of ["email_hash", "tracking_event", "manual"] as MatchMethod[]) {
      expect(gradeMatch({ method: m, candidateCount: 0 })).toBe("UNKNOWN");
    }
  });

  test("only DETERMINISTIC and STRONG are attributable", () => {
    expect(isAttributable("DETERMINISTIC")).toBe(true);
    expect(isAttributable("STRONG")).toBe(true);
    expect(isAttributable("PARTIAL")).toBe(false);
    expect(isAttributable("UNKNOWN")).toBe(false);
  });

  test("the confidence ordering is DETERMINISTIC > STRONG > PARTIAL > UNKNOWN", () => {
    expect(CONFIDENCE_RANK.DETERMINISTIC).toBeGreaterThan(CONFIDENCE_RANK.STRONG);
    expect(CONFIDENCE_RANK.STRONG).toBeGreaterThan(CONFIDENCE_RANK.PARTIAL);
    expect(CONFIDENCE_RANK.PARTIAL).toBeGreaterThan(CONFIDENCE_RANK.UNKNOWN);
  });

  test("there is no probabilistic match method in the vocabulary", () => {
    const block = SCHEMA.slice(SCHEMA.indexOf("enum BookingMatchMethod"));
    const values = block.slice(0, block.indexOf("}"));
    for (const banned of ["ip", "fingerprint", "timestamp", "fuzzy", "probable", "likely", "name_match"]) {
      expect(values.toLowerCase()).not.toContain(banned);
    }
  });

  test("defaults are the SAFE ones (unknown / UNKNOWN)", () => {
    const m = modelBlock("BookingJourneyMatch");
    expect(m).toContain("@default(unknown)");
    expect(m).toContain("@default(UNKNOWN)");
  });
});

// ── 3/12. Tenant isolation ────────────────────────────────────────────────

describe("3/12. tenant isolation", () => {
  test.each(["BookingConnection", "Booking", "BookingStatusEvent", "BookingJourneyMatch"])(
    "%s carries agencyId and indexes it",
    (model) => {
      const b = modelBlock(model);
      expect(b).toMatch(/^\s+agencyId\s+String/m);
      expect(b).toContain("@@index([agencyId])");
    },
  );

  test("all four are registered as multi-tenant models", () => {
    const scope = read("lib/tenant-scope.ts");
    for (const m of ["bookingConnection", "booking", "bookingStatusEvent", "bookingJourneyMatch"]) {
      expect(scope).toContain(`"${m}"`);
    }
  });

  test("RLS policies are created for all four tables", () => {
    expect(MIGRATION).toContain("ENABLE ROW LEVEL SECURITY");
    for (const t of ["BookingConnection", "Booking", "BookingStatusEvent", "BookingJourneyMatch"]) {
      expect(MIGRATION).toContain(`'${t}'`);
    }
    expect(MIGRATION).toContain("tenant_isolation");
  });

  test("the match is hotel-scoped so it cannot cross hotels", () => {
    expect(modelBlock("BookingJourneyMatch")).toMatch(/^\s+hotelClientId String/m);
  });

  test("the provider credential is scrubbed from ordinary query results", () => {
    const prismaLib = read("lib/prisma.ts");
    expect(prismaLib).toContain("bookingConnection:");
    expect(prismaLib).toContain('scrub(await query(args), "credentials")');
  });
});

// ── 13/14. No regression; legacy conversion stays distinguishable ─────────

describe("13/14. existing tracking is untouched", () => {
  test("TrackingEvent still owns the legacy scraped conversionValue", () => {
    const te = modelBlock("TrackingEvent");
    // Whitespace-tolerant: `prisma format` column-aligns field types, so the gap
    // between name and type is layout, not meaning.
    expect(te).toMatch(/conversionValue\s+Decimal\?/);
    // Phase 1A click ids survive.
    for (const f of ["gclid", "gbraid", "wbraid", "fbclid"]) {
      expect(te).toMatch(new RegExp(`${f}\\s+String\\?`));
    }
  });

  test("real booking revenue lives on a DIFFERENT model with different names", () => {
    // "conversionValue" must not leak into the booking world, and the booking
    // amounts must not be named conversionValue — the two must stay tellable apart.
    expect(modelBlock("Booking")).not.toContain("conversionValue");
    expect(modelBlock("Booking")).toContain("grossAmount");
  });

  test("the migration is purely additive — no existing table is touched", () => {
    expect(MIGRATION_SQL).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
    // The only ALTER TABLEs are FK constraints on the four NEW tables.
    const alters = MIGRATION_SQL.match(/ALTER TABLE "(\w+)"/g) ?? [];
    for (const a of alters) {
      expect(a).toMatch(/"(BookingConnection|Booking|BookingStatusEvent|BookingJourneyMatch)"/);
    }
  });

  test("no backfill: nothing invents a Booking from historic tracking rows", () => {
    expect(MIGRATION_SQL).not.toMatch(/INSERT INTO "Booking"/i);
    expect(MIGRATION_SQL).not.toMatch(/^\s*UPDATE /im);
  });

  test("the Phase 1A click-id migration is preserved", () => {
    const phase1a = read("prisma/migrations/20260821000000_add_click_identifiers/migration.sql");
    expect(phase1a).toContain('ALTER TABLE "TrackingEvent"');
    expect(phase1a).toContain("gclid");
  });
});
