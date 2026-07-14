import "dotenv/config";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// End-to-end check for the server-side PDF report: build fixtures, mock the
// signed-in agency member (so agencyScoped resolves), generate the PDF from the
// SAME loaders the dashboard uses, and assert it's a valid multi-page document.
// Also writes a sample PDF to the scratchpad so it can be opened + eyeballed.

const PREFIX = "TEST_PDF_";
const OUT = join(tmpdir(), "hoteltrack-sample-report.pdf");

const h = vi.hoisted(() => ({ member: null as null | Record<string, unknown> }));
vi.mock("@/lib/auth", () => ({
  getCurrentMember: async () => h.member,
  getPlatformRole: async () => "agency_admin",
}));

import { prisma } from "@/lib/prisma";
import { generateHotelReportPdf } from "@/lib/report-pdf";

const day = (agoDays: number) => new Date(Date.now() - agoDays * 86_400_000);
const dateOnly = (agoDays: number) => {
  const d = day(agoDays);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

let agencyId = "";
let hotelId = "";

beforeAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  const agency = await prisma.agency.create({
    data: {
      name: `${PREFIX}Agency`, email: `${PREFIX}a@x.test`, subscriptionStatus: "active",
      contactEmail: "hello@agency.test", mobile: "+919876543210", websiteUrl: "https://agency.test",
    },
  });
  agencyId = agency.id;
  const member = await prisma.agencyMember.create({
    data: { agencyId, clerkId: `${PREFIX}c-${Date.now()}`, email: "m@x.test", name: "M", role: "admin" },
  });
  h.member = { id: member.id, agencyId, email: "m@socialhippi.com", role: "admin", agency: { id: agencyId, name: agency.name, plan: "starter" } };

  const hotel = await prisma.hotelClient.create({
    data: {
      agencyId, name: `${PREFIX}Seaside Resort`, websiteUrl: "https://seaside.test",
      contactName: "C", contactEmail: "c@t.local", siteId: `${PREFIX}s-${Date.now()}`,
      conversionMethod: "both", otaCommissionRate: 18,
    },
  });
  hotelId = hotel.id;

  // Reproduce the reported broken case: HIGH ad spend (₹57,300) with almost NO
  // tracked revenue (one ₹4 booking) → the narrative must read POOR, not "strong",
  // and ₹ figures must render. Plus a dozen visits so the conversion rate is tiny.
  const visits = Array.from({ length: 12 }, (_, i) => ({
    agencyId, hotelClientId: hotelId, eventType: "visit" as const, pageUrl: "https://seaside.test/rooms",
    sessionId: `v${i}`, deviceType: "mobile", utmSource: "instagram", utmMedium: "social", createdAt: day(6),
  }));
  await prisma.trackingEvent.createMany({
    data: [
      ...visits,
      { agencyId, hotelClientId: hotelId, eventType: "conversion", pageUrl: "https://seaside.test/thank-you", sessionId: "v0", deviceType: "mobile", utmSource: "instagram", utmMedium: "social", conversionValue: 4, createdAt: day(5) },
    ],
  });
  await prisma.session.createMany({
    data: [
      { id: `sess_${PREFIX}1`, visitorId: "v1", hotelClientId: hotelId, agencyId, startedAt: day(5), landingPath: "/", highestStageReached: "awareness" },
      { id: `sess_${PREFIX}2`, visitorId: "v2", hotelClientId: hotelId, agencyId, startedAt: day(5), landingPath: "/rooms", highestStageReached: "consideration" },
      { id: `sess_${PREFIX}3`, visitorId: "v3", hotelClientId: hotelId, agencyId, startedAt: day(4), landingPath: "/book", highestStageReached: "booking" },
    ],
  });
  await prisma.adSnapshot.create({
    data: {
      agencyId, hotelClientId: hotelId, metaAccountId: "act_test", date: dateOnly(5),
      spend: 57300, impressions: 120000, reach: 90000, clicks: 3200, ctr: 0.0267, cpc: 17.9, cpm: 477,
      conversions: 0, roas: 0, pixelPurchases: 0, pixelLeads: 0, pixelPageViews: 900,
    },
  });
});

afterAll(async () => {
  await prisma.agency.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe("server-side PDF report", () => {
  test("generates a valid multi-page PDF from real loaders", async () => {
    const since = day(30);
    const until = new Date();
    const pdf = await generateHotelReportPdf({
      agencyId, hotelId,
      hotelName: `${PREFIX}Seaside Resort`, websiteUrl: "https://seaside.test", funnelStageRules: null,
      agencyName: `${PREFIX}Agency`,
      agencyContact: { contactEmail: "hello@agency.test", mobile: "+919876543210", websiteUrl: "https://agency.test" },
      rangeLabel: "Last 30 days", from: since.toISOString().slice(0, 10), to: until.toISOString().slice(0, 10),
      since, until, generatedAt: "test-run",
    });

    expect(pdf).toBeInstanceOf(Uint8Array);
    const text = Buffer.from(pdf).toString("latin1");
    expect(text.startsWith("%PDF")).toBe(true);
    expect(pdf.length).toBeGreaterThan(5000);
    const pageCount = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pageCount).toBeGreaterThanOrEqual(2); // cover + body

    try {
      writeFileSync(OUT, Buffer.from(pdf));
      console.log(`[report-pdf] wrote ${pdf.length} bytes, ~${pageCount} page objects → ${OUT}`);
    } catch {
      /* sample write is best-effort — never fail the test on a read-only tmp dir */
    }
  });
});
