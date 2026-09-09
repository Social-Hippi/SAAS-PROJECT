import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { prisma } from "@/lib/prisma";
import { POST as ingestPOST } from "@/app/api/integrations/ops-tracker/route";
import { ingestTrackerPayload, secretMatches } from "@/lib/ops-tracker/ingest";
import { parseTrackerPayload, parseTrackerDate } from "@/lib/ops-tracker/parse";
import { TRACKER_LAYOUTS, mapHeader, normaliseHeader } from "@/lib/ops-tracker/layouts";
import { parseCsv } from "@/lib/ops-tracker/csv-source";

// ─────────────────────────────────────────────────────────────────────────────
// GATE 2 — the operations-tracker import.
//
// These sheets are hand-maintained by the properties' own staff and carry
// internal contradictions. The import's job is to be strict at the boundary,
// specific about what it refused, and IDEMPOTENT — because the Apps Script fires
// on every committed keystroke, so the same payload arrives over and over by
// design. Idempotency is the protection, not debouncing.
// ─────────────────────────────────────────────────────────────────────────────

const PREFIX = "TEST_OPS_";
const CBH_SHEET = `${PREFIX}sheet_cbh`;
const CBH_TAB = "Aster | Call Reports Tracker";
const TH_SHEET = `${PREFIX}sheet_th`;
const TH_TAB = "3hills tracker";
const SECRET = "test-ingest-secret-value";

let agencyId: string;
let hotelId: string;
let cbhSegmentId: string;

const CBH_HEADER = [
  "Date", "CBH Enquiry", "Repeat", "Rm Nts Confirmed", "Junk / Spam", "Sold Out",
  "Inhouse", "Low Budget", "Less Room", "WhatsApp Leads", "WhatsApp Confirmed",
  "Total Calls Received", "Total Leads", "Conversion Rate",
];
const TH_HEADER = [
  "Date", "3Hills Enquiry", "Repeat", "Rm Nts Confirmed", "Junk / Spam", "Sold Out",
  "Inhouse", "Low Budget Less Room", "WhatsApp Leads", "WhatsApp Confirmed",
  "Total Calls Received", "Conversion Rate",
];

const cbhRow = (date: string) =>
  [date, "8", "2", "5", "1", "0", "1", "2", "1", "4", "2", "9", "12", "58.3%"];
const thRow = (date: string) =>
  [date, "6", "1", "3", "2", "0", "1", "3", "2", "1", "9", "33.3%"];

const req = (body: unknown, secret: string | null = SECRET) =>
  new Request("http://localhost/api/integrations/ops-tracker", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-ingest-secret": secret } : {}),
    },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  process.env.OPS_TRACKER_INGEST_SECRET = SECRET;
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });

  const agency = await prisma.agency.create({
    data: {
      name: `${PREFIX}Agency`,
      email: `${PREFIX.toLowerCase()}a@x.test`,
      subscriptionStatus: "active",
    },
  });
  agencyId = agency.id;

  const hotel = await prisma.hotelClient.create({
    data: {
      agencyId,
      name: `${PREFIX}Group`,
      websiteUrl: "https://ops-group.example",
      contactName: "C",
      contactEmail: "c@t.local",
      siteId: `${PREFIX}${Date.now()}`,
      conversionMethod: "url_change",
    },
  });
  hotelId = hotel.id;

  const cbh = await prisma.propertySegment.create({
    data: {
      agencyId, hotelClientId: hotelId,
      name: "Coffeeberry Hills", slug: "coffeeberry-hills", displayOrder: 1,
      bookingHosts: ["bookings.coffeeberryhills.in"],
      sourceSheetId: CBH_SHEET, sourceTabName: CBH_TAB, trackerLayout: "cbh_v1",
    },
  });
  cbhSegmentId = cbh.id;

  await prisma.propertySegment.create({
    data: {
      agencyId, hotelClientId: hotelId,
      name: "Three Hills", slug: "three-hills", displayOrder: 2,
      pathPrefixes: ["/three-hills-coorg-resort"],
      sourceSheetId: TH_SHEET, sourceTabName: TH_TAB, trackerLayout: "three_hills_v1",
    },
  });
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.manualLeadDaily.deleteMany({ where: { hotelClientId: hotelId } });
});

// ── 1 · The secret is the only credential ───────────────────────────────────

describe("1. authentication", () => {
  test("a wrong secret is refused and writes nothing", async () => {
    const res = await ingestPOST(
      req({ spreadsheetId: CBH_SHEET, tab: CBH_TAB, header: CBH_HEADER, rows: [cbhRow("2026-08-01")] }, "wrong"),
    );
    expect(res.status).toBe(401);
    expect(await prisma.manualLeadDaily.count({ where: { hotelClientId: hotelId } })).toBe(0);
  });

  test("a missing secret is refused and writes nothing", async () => {
    const res = await ingestPOST(
      req({ spreadsheetId: CBH_SHEET, tab: CBH_TAB, header: CBH_HEADER, rows: [cbhRow("2026-08-01")] }, null),
    );
    expect(res.status).toBe(401);
    expect(await prisma.manualLeadDaily.count({ where: { hotelClientId: hotelId } })).toBe(0);
  });

  test("a wrong secret and a missing secret answer identically", async () => {
    // Telling a caller WHICH way they got it wrong is a free bit about a credential.
    const a = await ingestPOST(req({ spreadsheetId: CBH_SHEET, tab: CBH_TAB, header: CBH_HEADER, rows: [] }, "wrong"));
    const b = await ingestPOST(req({ spreadsheetId: CBH_SHEET, tab: CBH_TAB, header: CBH_HEADER, rows: [] }, null));
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  });

  test("secretMatches is length-safe and does not throw on a mismatch", () => {
    expect(secretMatches("abc", "abcdef")).toBe(false);
    expect(secretMatches("abcdef", "abcdef")).toBe(true);
    expect(secretMatches(null, "abcdef")).toBe(false);
    expect(secretMatches("abc", undefined)).toBe(false);
  });
});

// ── 2 · Idempotency ─────────────────────────────────────────────────────────

describe("2. idempotency", () => {
  const payload = {
    spreadsheetId: CBH_SHEET, tab: CBH_TAB, header: CBH_HEADER,
    rows: [cbhRow("2026-08-01"), cbhRow("2026-08-02"), cbhRow("2026-08-03")],
  };

  test("running the import twice yields identical row counts and no duplicates", async () => {
    const first = await ingestTrackerPayload(payload);
    expect(first.body.rowsAccepted).toBe(3);
    const afterFirst = await prisma.manualLeadDaily.count({ where: { hotelClientId: hotelId } });

    const second = await ingestTrackerPayload(payload);
    expect(second.body.rowsAccepted).toBe(3);
    const afterSecond = await prisma.manualLeadDaily.count({ where: { hotelClientId: hotelId } });

    expect(afterFirst).toBe(3);
    expect(afterSecond).toBe(3);
  });

  test("replaying an identical payload changes no stored value", async () => {
    await ingestTrackerPayload(payload);
    const before = await prisma.manualLeadDaily.findMany({
      where: { hotelClientId: hotelId },
      orderBy: { date: "asc" },
      select: { date: true, enquiries: true, totalCallsReceived: true, roomNightsConfirmed: true },
    });

    await ingestTrackerPayload(payload);
    const after = await prisma.manualLeadDaily.findMany({
      where: { hotelClientId: hotelId },
      orderBy: { date: "asc" },
      select: { date: true, enquiries: true, totalCallsReceived: true, roomNightsConfirmed: true },
    });

    expect(after).toEqual(before);
  });

  test("a corrected cell DOES update on replay", async () => {
    await ingestTrackerPayload(payload);
    const corrected = {
      ...payload,
      rows: [["2026-08-01", "99", "2", "5", "1", "0", "1", "2", "1", "4", "2", "9", "12", "58.3%"]],
    };
    await ingestTrackerPayload(corrected);
    const row = await prisma.manualLeadDaily.findFirst({
      where: { hotelClientId: hotelId, date: new Date("2026-08-01T00:00:00.000Z") },
      select: { enquiries: true },
    });
    expect(row?.enquiries).toBe(99);
  });

  test("the two workbooks do not collide on the same date", async () => {
    // Both properties hang off ONE HotelClient, so a (hotelClientId, date) key
    // would have made these overwrite each other.
    await ingestTrackerPayload(payload);
    await ingestTrackerPayload({
      spreadsheetId: TH_SHEET, tab: TH_TAB, header: TH_HEADER, rows: [thRow("2026-08-01")],
    });
    const onThatDate = await prisma.manualLeadDaily.count({
      where: { hotelClientId: hotelId, date: new Date("2026-08-01T00:00:00.000Z") },
    });
    expect(onThatDate).toBe(2);
  });
});

// ── 3 · Per-row rejection, batch survives ───────────────────────────────────

describe("3. validation", () => {
  test("a malformed date rejects that row only, with a reason", async () => {
    const out = await ingestTrackerPayload({
      spreadsheetId: CBH_SHEET, tab: CBH_TAB, header: CBH_HEADER,
      rows: [cbhRow("2026-08-01"), cbhRow("2026-13-45"), cbhRow("2026-08-03")],
    });
    expect(out.body.rowsAccepted).toBe(2);
    expect(out.body.rowsRejected).toBe(1);
    expect(out.body.rejected?.[0]?.reason).toMatch(/not a recognised date/i);
    expect(await prisma.manualLeadDaily.count({ where: { hotelClientId: hotelId } })).toBe(2);
  });

  test("a negative count rejects that row only, with a reason", async () => {
    const bad = cbhRow("2026-08-02");
    bad[1] = "-3";
    const out = await ingestTrackerPayload({
      spreadsheetId: CBH_SHEET, tab: CBH_TAB, header: CBH_HEADER,
      rows: [cbhRow("2026-08-01"), bad],
    });
    expect(out.body.rowsAccepted).toBe(1);
    expect(out.body.rejected?.[0]?.reason).toMatch(/negative/i);
  });

  test("an unknown column rejects the WHOLE batch and writes nothing", async () => {
    // A changed sheet shape means no row's mapping can be trusted.
    const out = await ingestTrackerPayload({
      spreadsheetId: CBH_SHEET, tab: CBH_TAB,
      header: [...CBH_HEADER, "Mystery Column"],
      rows: [[...cbhRow("2026-08-01"), "x"]],
    });
    expect(out.status).toBe(422);
    expect(out.body.unknownColumns).toContain("Mystery Column");
    expect(await prisma.manualLeadDaily.count({ where: { hotelClientId: hotelId } })).toBe(0);
  });

  test("an unmapped tab writes nothing and says so", async () => {
    const out = await ingestTrackerPayload({
      spreadsheetId: "not-configured", tab: "whatever", header: CBH_HEADER, rows: [cbhRow("2026-08-01")],
    });
    expect(out.status).toBe(404);
    expect(out.body.error).toMatch(/No property segment is configured/i);
    expect(await prisma.manualLeadDaily.count({ where: { hotelClientId: hotelId } })).toBe(0);
  });

  test("a payload above the row cap is refused outright", async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => cbhRow(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`));
    const out = await ingestTrackerPayload({ spreadsheetId: CBH_SHEET, tab: CBH_TAB, header: CBH_HEADER, rows });
    expect(out.status).toBe(413);
  });

  test("a blank cell stores null — NOT zero", async () => {
    const row = cbhRow("2026-08-04");
    row[2] = ""; // Repeat not recorded that day
    await ingestTrackerPayload({ spreadsheetId: CBH_SHEET, tab: CBH_TAB, header: CBH_HEADER, rows: [row] });
    const stored = await prisma.manualLeadDaily.findFirst({
      where: { hotelClientId: hotelId, date: new Date("2026-08-04T00:00:00.000Z") },
      select: { repeatContacts: true, enquiries: true },
    });
    expect(stored?.repeatContacts).toBeNull();
    expect(stored?.enquiries).toBe(8);
  });

  test("a duplicate date inside one payload is rejected deterministically", async () => {
    const out = await ingestTrackerPayload({
      spreadsheetId: CBH_SHEET, tab: CBH_TAB, header: CBH_HEADER,
      rows: [cbhRow("2026-08-01"), cbhRow("2026-08-01")],
    });
    expect(out.body.rowsAccepted).toBe(1);
    expect(out.body.rejected?.[0]?.reason).toMatch(/already appears/i);
  });
});

// ── 4 · The two layouts genuinely differ ────────────────────────────────────

describe("4. per-property column layouts", () => {
  test("Three Hills' combined column is stored whole, never split", async () => {
    await ingestTrackerPayload({
      spreadsheetId: TH_SHEET, tab: TH_TAB, header: TH_HEADER, rows: [thRow("2026-08-05")],
    });
    const row = await prisma.manualLeadDaily.findFirst({
      where: { hotelClientId: hotelId, sourceTabName: TH_TAB },
      select: { lowBudgetLessRoom: true, lowBudget: true, lessRoom: true, storedTotalLeads: true },
    });
    expect(row?.lowBudgetLessRoom).toBe(3);
    // Splitting the combined value would invent two numbers from one.
    expect(row?.lowBudget).toBeNull();
    expect(row?.lessRoom).toBeNull();
    // Three Hills has no Total Leads column at all.
    expect(row?.storedTotalLeads).toBeNull();
  });

  test("Coffeeberry Hills' split columns stay split", async () => {
    await ingestTrackerPayload({
      spreadsheetId: CBH_SHEET, tab: CBH_TAB, header: CBH_HEADER, rows: [cbhRow("2026-08-06")],
    });
    const row = await prisma.manualLeadDaily.findFirst({
      where: { hotelClientId: hotelId, sourceTabName: CBH_TAB },
      select: { lowBudget: true, lessRoom: true, lowBudgetLessRoom: true, storedTotalLeads: true },
    });
    expect(row?.lowBudget).toBe(2);
    expect(row?.lessRoom).toBe(1);
    expect(row?.lowBudgetLessRoom).toBeNull();
    expect(row?.storedTotalLeads).toBe(12);
  });

  test("each layout refuses the other's header", () => {
    expect(mapHeader(TH_HEADER, TRACKER_LAYOUTS.cbh_v1).ok).toBe(false);
    expect(mapHeader(CBH_HEADER, TRACKER_LAYOUTS.three_hills_v1).ok).toBe(false);
  });

  test("header normalisation tolerates spacing but not renaming", () => {
    expect(normaliseHeader("Junk / Spam")).toBe(normaliseHeader("Junk/Spam"));
    expect(normaliseHeader("  Total  Calls   Received ")).toBe("total calls received");
    // The property name in the enquiry column is REAL and must not be normalised away.
    expect(normaliseHeader("CBH Enquiry")).not.toBe(normaliseHeader("3Hills Enquiry"));
  });

  test("the rows a payload rejects do not stop the ones it accepts", () => {
    const parsed = parseTrackerPayload(
      CBH_HEADER,
      [cbhRow("2026-08-01"), cbhRow("nonsense"), cbhRow("2026-08-03")],
      TRACKER_LAYOUTS.cbh_v1,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rejected).toHaveLength(1);
  });
});

// ── 5 · Date and CSV parsing ────────────────────────────────────────────────

describe("5. date and CSV handling", () => {
  test("ISO is accepted and impossible dates are refused", () => {
    expect(parseTrackerDate("2026-08-31")).toBe("2026-08-31");
    expect(parseTrackerDate("2026-13-45")).toBeNull();
    expect(parseTrackerDate("2026-02-30")).toBeNull();
    expect(parseTrackerDate("")).toBeNull();
    expect(parseTrackerDate("banana")).toBeNull();
  });

  test("an unambiguous D/M/Y is read by its proven order, whatever the flag", () => {
    expect(parseTrackerDate("31/07/2026", true)).toBe("2026-07-31");
    expect(parseTrackerDate("31/07/2026", false)).toBe("2026-07-31");
  });

  test("an ambiguous D/M/Y follows the configured order", () => {
    expect(parseTrackerDate("05/09/2026", true)).toBe("2026-09-05");
    expect(parseTrackerDate("05/09/2026", false)).toBe("2026-05-09");
  });

  test("CSV parsing handles quotes, embedded commas and a BOM", () => {
    const rows = parseCsv('﻿"Date","A, B"\n"2026-08-01","he said ""hi"""\n');
    expect(rows[0]).toEqual(["Date", "A, B"]);
    expect(rows[1]).toEqual(["2026-08-01", 'he said "hi"']);
  });
});

// ── 6 · Storage keeps the audit trail ───────────────────────────────────────

describe("6. audit trail", () => {
  test("the raw row is stored, and formula-injection is neutralised", async () => {
    const row = cbhRow("2026-08-07");
    row[1] = "=cmd|'/c calc'!A1"; // a hostile cell that Excel would execute
    const out = await ingestTrackerPayload({
      spreadsheetId: CBH_SHEET, tab: CBH_TAB, header: CBH_HEADER, rows: [row],
    });
    // The cell is not a number, so the row is refused outright...
    expect(out.body.rowsRejected).toBe(1);

    // ...and a benign row still keeps its raw values for tracing a dispute.
    await ingestTrackerPayload({
      spreadsheetId: CBH_SHEET, tab: CBH_TAB, header: CBH_HEADER, rows: [cbhRow("2026-08-08")],
    });
    const stored = await prisma.manualLeadDaily.findFirst({
      where: { hotelClientId: hotelId, date: new Date("2026-08-08T00:00:00.000Z") },
      select: { sourceRow: true, sourceSheetId: true, sourceTabName: true, importedAt: true },
    });
    expect(stored?.sourceRow).toMatchObject({ "CBH Enquiry": "8" });
    expect(stored?.sourceSheetId).toBe(CBH_SHEET);
    expect(stored?.importedAt).toBeInstanceOf(Date);
  });

  test("rows are bound to their property segment", async () => {
    await ingestTrackerPayload({
      spreadsheetId: CBH_SHEET, tab: CBH_TAB, header: CBH_HEADER, rows: [cbhRow("2026-08-09")],
    });
    const stored = await prisma.manualLeadDaily.findFirst({
      where: { hotelClientId: hotelId, date: new Date("2026-08-09T00:00:00.000Z") },
      select: { propertySegmentId: true },
    });
    expect(stored?.propertySegmentId).toBe(cbhSegmentId);
  });
});
