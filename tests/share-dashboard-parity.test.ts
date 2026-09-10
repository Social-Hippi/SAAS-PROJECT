import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// SHARE ↔ AGENCY PARITY.
//
// The public /share/<uuid> report and the agency's /agency/hotel/[id] page used
// to be different code: one had five panels, the other twenty-odd, and every
// change to either widened the gap. They are now the same component, and this
// suite exists to keep it that way — plus to pin the four things that are
// ALLOWED to differ, so a future change to any of them has to be deliberate:
//
//   1. CONTROLS. No link into an agency-only page may render for a share reader.
//   2. AD SPEND. showAdSpendToHotel still governs the public link, on the
//      server-rendered half AND the client-fetched half.
//   3. GEOGRAPHY + DEVICES. The GA4 countries/cities/devices row is agency-only:
//      hidden from clients by request, kept for the agency.
//   4. AUTH. The share reader has no session, so the read routes must be
//      reachable without one — while still authenticating every request.
//
// These are source assertions: rendering the dashboard needs a database and a
// React server renderer, and what actually regresses here is the wiring. The
// behavioural half lives in tests/share-link-full-access.test.ts, which drives
// the real route handlers against real fixtures.
// ─────────────────────────────────────────────────────────────────────────────

const DASH = readCode("components/dashboard/FullHotelDashboard.tsx");
const AGENCY_PAGE = readCode("app/(agency)/agency/(app)/hotel/[id]/page.tsx");
const SHARE_PAGE = readCode("app/share/[uuid]/page.tsx");
const PROXY = readCode("proxy.ts");
const HOTEL_AUTH = readCode("lib/hotel-auth.ts");

// ── 1. One dashboard, two surfaces ──────────────────────────────────────────

describe("1. both surfaces render the same dashboard", () => {
  test("each page imports the shared component", () => {
    for (const [name, src] of [["agency page", AGENCY_PAGE], ["share page", SHARE_PAGE]] as const) {
      expect(src, name).toContain(
        'import { FullHotelDashboard } from "@/components/dashboard/FullHotelDashboard"',
      );
      expect(src, name).toContain("<FullHotelDashboard");
    }
  });

  test("neither page re-implements the panels itself", () => {
    // The whole point: a panel lives in ONE file. If a page starts importing
    // KpiStrip or ContentPerformanceTable again, the split is coming back.
    for (const [name, src] of [["agency page", AGENCY_PAGE], ["share page", SHARE_PAGE]] as const) {
      for (const panel of [
        "KpiStrip",
        "ContentPerformanceTable",
        "MetaCampaignBreakdownTable",
        "AttributionPanel",
        "CampaignGrid",
        "RevenueBySource",
        "CommissionSavings",
        "PerformanceOverview",
        "Ga4WebsiteTraffic",
      ]) {
        expect(src, `${name} / ${panel}`).not.toContain(panel);
      }
    }
  });

  test("the share page declares itself the share viewer, on the hotel API, with its token", () => {
    expect(SHARE_PAGE).toContain('viewer="share"');
    expect(SHARE_PAGE).toContain('apiBase="/api/hotel"');
    expect(SHARE_PAGE).toContain("shareToken={uuid}");
  });

  test("the agency page declares itself the agency viewer", () => {
    expect(AGENCY_PAGE).toContain('viewer="agency"');
    expect(AGENCY_PAGE).toContain('apiBase="/api/agency/hotels"');
    // No token: the agency is authorized by its session.
    expect(AGENCY_PAGE).not.toContain("shareToken=");
  });
});

// ── 2. No agency control reaches a public URL ───────────────────────────────

describe("2. controls stay on the agency surface", () => {
  test("every agency deep link in the shared dashboard is behind isAgencyViewer", () => {
    // A link a public reader would only be bounced from is a dead end at best;
    // a link to a WRITE surface is worse.
    const lines = DASH.split("\n");
    const hrefLines = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /href=\{`\/agency\//.test(line));

    expect(hrefLines.length, "expected agency hrefs to exist at all").toBeGreaterThan(0);

    for (const { line, i } of hrefLines) {
      const window = lines.slice(Math.max(0, i - 8), i).join("\n");
      expect(window, `unguarded agency href at line ${i + 1}: ${line.trim()}`).toContain(
        "isAgencyViewer",
      );
    }
  });

  test("the integrations href is null for a share reader", () => {
    expect(DASH).toContain(
      "const manageHref = isAgencyViewer ? `/agency/hotel/${hotelId}/integrations` : null;",
    );
    // Everything that offers an integrations CTA takes that value, so there is
    // one decision rather than one per call site.
    for (const consumer of [
      "<IntegrationBadges",
      "<IntegrationEmptyState",
      "<Ga4WebsiteTraffic",
    ]) {
      const at = DASH.indexOf(consumer);
      expect(at, consumer).toBeGreaterThan(-1);
      expect(DASH.slice(at, at + 400), consumer).toContain("manageHref");
    }
  });

  test("the share page renders no agency-only control", () => {
    for (const control of [
      "ShareLinkManager",      // mints/revokes the reader's own credential
      "DeleteHotelDangerZone", // a destructive write
      "ReportMenu",            // agency exports
      "DateRangeSelector",     // agency-only custom range picker
      "ContactInfoBanner",     // a nudge about the AGENCY's own profile
    ]) {
      expect(SHARE_PAGE, control).not.toContain(control);
    }
  });

  test("the agency page keeps them", () => {
    for (const control of ["ShareLinkManager", "DeleteHotelDangerZone", "ReportMenu", "DateRangeSelector"]) {
      expect(AGENCY_PAGE, control).toContain(control);
    }
  });

  test("no copy sends a public reader to an agency-only page", () => {
    // Caught by reading a real rendered report: several strings told the hotel to
    // "set the rate on the Integrations page" or "create influencers & codes
    // under Influencers & Coupons" - instructions for surfaces they cannot open.
    // Each is now gated on the viewer rather than assumed to be the agency.
    for (const phrase of ["Set the rate on the Integrations page"]) {
      const at = DASH.indexOf(phrase);
      expect(at, phrase).toBeGreaterThan(-1);
      // The phrase must sit inside an isAgencyViewer branch, not be unconditional.
      expect(DASH.slice(Math.max(0, at - 300), at), phrase).toContain("isAgencyViewer");
    }
    const INF = readCode("components/dashboard/InfluencerPerformance.tsx");
    expect(INF).toContain("viewerIsAgency");
    expect(DASH).toContain("viewerIsAgency={isAgencyViewer}");
  });

  test("the health banner speaks to the audience actually reading it", () => {
    // "Reinstall the snippet" is an instruction only the agency can act on.
    expect(DASH).toContain('audience={isAgencyViewer ? "agency" : "hotel"}');
    expect(DASH).not.toContain('audience="agency"');
  });
});

// ── 3. The ad-spend toggle survives on both halves of the page ──────────────

describe("3. showAdSpendToHotel still governs the public link", () => {
  test("the share page passes the hotel's flag; the agency page always sees spend", () => {
    expect(SHARE_PAGE).toContain("showAdSpend={link.showAdSpend}");
    expect(AGENCY_PAGE).toMatch(/showAdSpend\s*\n/); // bare `showAdSpend` === true
  });

  test("the prop is required and never defaults to visible", () => {
    // A caller that forgets it must fail closed, not quietly publish spend.
    expect(DASH).toMatch(/showAdSpend: boolean;/);
    expect(DASH).not.toMatch(/showAdSpend\?: boolean/);
    expect(DASH).not.toMatch(/showAdSpend = true/);
  });

  test("the client-fetched half is gated too, not just the rendered half", () => {
    // The panels below fetch their own data. Gating only the server-rendered
    // markup would leave spend sitting in a JSON response one devtools tab away.
    const GATE = readCode("lib/share-spend-gate.ts");
    expect(GATE).toContain("export function stripSpendFromOwnerMetrics");
    expect(GATE).toContain("export function stripSpendFromChannelView");

    for (const route of ["owner-metrics", "channel-view"]) {
      const src = readCode(`app/api/hotel/[hotelClientId]/${route}/route.ts`);
      expect(src, route).toContain("access.spendVisible");
      expect(src, route).toContain("share-spend-gate");
    }
  });

  test("no ratio survives that spend can be divided out of", () => {
    // The gap this catches, found by diffing a real spend-hidden render: the
    // multi-touch channel table has a True ROAS column, and credited revenue
    // sits in the row beside it — so `spend = revenue / roas` was recoverable
    // while every headline spend figure was correctly hidden.
    //
    // Fixed at the SOURCE (no spend goes into computeChannelPerformance, so
    // every trueRoas is null) as well as in the UI (the column is dropped).
    // Either alone would work; both means a future caller cannot reintroduce it
    // by passing the panel a different row set.
    expect(DASH).toContain("showAdSpend && metaConnected && campaignTotalSpend > 0");
    expect(DASH).toContain("<AttributionPanel byModel={channelByModel} showRoas={showAdSpend} />");

    const TABLE = readCode("components/dashboard/mission/ChannelPerformanceTable.tsx");
    expect(TABLE).toContain("showRoas");
    // The column and its cell must BOTH be gated - a header with no body cell
    // (or the reverse) misaligns every row.
    expect(TABLE).toMatch(/\{showRoas && \([\s\S]{0,200}True ROAS/);
    expect(TABLE).toMatch(/\{showRoas && \([\s\S]{0,200}r\.trueRoas/);
  });

  test("the narrated summary is regenerated, not post-stripped", () => {
    // Its output is prose ("Meta Ads: spent X at Yx ROAS"), so zeroing a field
    // afterwards would leave the sentence intact. It must be told up front.
    const SUMMARY_ROUTE = readCode("app/api/hotel/[hotelClientId]/summary/route.ts");
    expect(SUMMARY_ROUTE).toContain("hideSpend");
    // …and hideSpend must key the cache, or a hidden reader could be served the
    // spend-quoting summary generated for someone else.
    expect(SUMMARY_ROUTE).toMatch(/const key = [^\n]*hideSpend/);
  });

  test("a session always sees spend, whatever the flag says", () => {
    expect(HOTEL_AUTH).toContain("spendVisible: true");
    expect(HOTEL_AUTH).toContain("spendVisible: link.showAdSpend");
  });
});

// ── 4. Geography and devices are agency-only ───────────────────────────────

describe("4. the GA4 geography + device row is hidden from share readers", () => {
  const GA4 = readCode("components/dashboard/Ga4WebsiteTraffic.tsx");

  test("the panel takes a required viewerIsAgency and never defaults to visible", () => {
    // Same fail-closed rule as showAdSpend: a new call site that forgets it must
    // not quietly publish the row to a client. Required means TypeScript stops
    // that at the call site rather than a reviewer having to catch it.
    expect(GA4).toMatch(/viewerIsAgency: boolean;/);
    expect(GA4).not.toMatch(/viewerIsAgency\?: boolean/);
    expect(GA4).not.toMatch(/viewerIsAgency = true/);
  });

  test("the row is INSIDE the gate, not merely adjacent to it", () => {
    // Assert on order: the conditional must open before the markup, or the
    // headings are rendering unconditionally with a gate sitting nearby.
    const gate = GA4.indexOf("{viewerIsAgency && (");
    expect(gate, "expected a viewerIsAgency gate").toBeGreaterThan(-1);
    for (const heading of ["Top countries", "Top cities", "Devices", "Mobile-heavy traffic"]) {
      const at = GA4.indexOf(heading);
      expect(at, heading).toBeGreaterThan(gate);
    }
  });

  test("every call site passes the real viewer, not a literal", () => {
    // `viewerIsAgency={true}` would defeat the whole thing, because the share
    // page renders this same shared dashboard.
    const calls = [...DASH.matchAll(/<Ga4WebsiteTraffic[^/]*\/>/g)].map((m) => m[0]);
    expect(calls.length, "expected Ga4WebsiteTraffic call sites").toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain("viewerIsAgency={isAgencyViewer}");
      expect(call).not.toMatch(/viewerIsAgency=\{true\}/);
    }
  });
});

// ── 5. The read routes are reachable without a session, and still guarded ───

describe("5. the share reader can reach the data routes", () => {
  test("/api/hotel is exempt from the middleware session gate", () => {
    // Without this the report renders and every client panel 307s to /sign-in.
    expect(PROXY).toContain('"/api/hotel(.*)"');
  });

  test("the exemption is not a hole: every route there authenticates itself", () => {
    for (const route of [
      "owner-metrics", "channel-view", "summary",
      "revenue-by-source", "savings", "instagram-reach-split",
    ]) {
      const src = readCode(`app/api/hotel/[hotelClientId]/${route}/route.ts`);
      expect(src, route).toContain("requireReadAccess(request, hotelClientId)");
      // GET only — a public-to-middleware prefix must expose no writes.
      expect(src, route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
    }
  });

  test("the /hotel PAGE routes are NOT swept into the exemption", () => {
    // They still require a session; only the token-authenticated API is exempt.
    const at = PROXY.indexOf("if (isHotelRoute(req))");
    expect(at).toBeGreaterThan(-1);
    expect(PROXY).toMatch(/if \(!userId\) \{[\s\S]{0,120}redirectToSignIn/);
  });

  test("the share gate pins the token to ONE hotel", () => {
    // A share token is the only credential on that request, so without this an
    // agency's every hotel is one URL edit away.
    const gate = HOTEL_AUTH.slice(HOTEL_AUTH.indexOf("export async function requireShareLinkAccess"));
    expect(gate).toContain("if (link.hotelClientId !== hotelClientId) return null;");
    expect(gate).toContain("isOwner: false");
    expect(gate).toContain("isAgencyMember: false");
  });

  test("the page and the routes resolve the link through the SAME function", () => {
    // Otherwise a revoked link can keep serving JSON to a page that already
    // stopped rendering, or vice versa.
    expect(SHARE_PAGE).toContain("resolveShareLink(uuid)");
    expect(HOTEL_AUTH).toContain("await resolveShareLink(token)");
  });
});
