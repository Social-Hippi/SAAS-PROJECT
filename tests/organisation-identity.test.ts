import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";

import {
  validateAgencyName,
  AGENCY_NAME_MAX,
  AGENCY_NAME_MIN,
} from "@/lib/agency-validation";

// ─────────────────────────────────────────────────────────────────────────────
// ORGANISATION IDENTITY.
//
// `Agency.name` is ORGANISATION-level state: it is what every member of an
// agency sees in the app header, what appears on the reports they share with
// hotels, and what goes out in emails. It is not a per-user preference.
//
// Two defects made it behave like one:
//
//   1. Onboarding pre-filled the field with `${user.firstName}'s Agency`, so the
//      organisation was identified by whichever INDIVIDUAL happened to sign up
//      first. Users accepted the suggestion — scripts/cleanup-demo-data.ts
//      exists partly to delete two agencies created exactly that way.
//
//   2. Nothing could change it afterwards. createAgencyForCurrentUser was the
//      ONLY writer of Agency.name in the entire codebase; the settings action
//      (saveAgencyContact) writes five contact fields and not the name. So the
//      wrong identity was permanent.
//
// These tests pin the validator both write paths now share, and assert — at the
// source level — that the personal-name default is gone and a correction path
// exists. The behavioural half of a server action needs a database and a Clerk
// session, so the source assertions carry the parts that actually regressed.
// Mirrors tests/spend-display-integrity.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const read = readCode;

const ONBOARDING_PAGE = read("app/(agency)/agency/onboarding/page.tsx");
const ONBOARDING_CLIENT = read("app/(agency)/agency/onboarding/OnboardingClient.tsx");
const ONBOARDING_ACTIONS = read("app/(agency)/agency/onboarding/actions.ts");
const SETTINGS_ACTIONS = read("app/(agency)/agency/(app)/settings/actions.ts");
const SETTINGS_PAGE = read("app/(agency)/agency/(app)/settings/page.tsx");
const AGENCY_LAYOUT = read("app/(agency)/agency/(app)/layout.tsx");

// ── 1. The shared validator ─────────────────────────────────────────────────

describe("1. validateAgencyName", () => {
  test("accepts an ordinary organisation name and returns it trimmed", () => {
    const r = validateAgencyName("  Social Hippi  ");
    expect(r).toEqual({ ok: true, name: "Social Hippi" });
  });

  test("collapses internal whitespace, including pasted newlines", () => {
    const r = validateAgencyName("Social\n\n   Hippi\tMedia");
    expect(r.ok && r.name).toBe("Social Hippi Media");
  });

  test("rejects empty and whitespace-only input", () => {
    for (const v of ["", "   ", "\n\t "]) {
      const r = validateAgencyName(v);
      expect(r.ok, JSON.stringify(v)).toBe(false);
      expect(!r.ok && r.error).toMatch(/organisation/i);
    }
  });

  test("enforces the minimum length", () => {
    const r = validateAgencyName("a".repeat(AGENCY_NAME_MIN - 1));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(new RegExp(`${AGENCY_NAME_MIN}`));
  });

  test("enforces the column bound and reports it", () => {
    expect(validateAgencyName("a".repeat(AGENCY_NAME_MAX)).ok).toBe(true);
    const over = validateAgencyName("a".repeat(AGENCY_NAME_MAX + 1));
    expect(over.ok).toBe(false);
    expect(!over.ok && over.error).toMatch(new RegExp(`${AGENCY_NAME_MAX}`));
  });

  test("length is measured AFTER normalization, not before", () => {
    // Padding must not push a valid name over the limit.
    const r = validateAgencyName("   " + "a".repeat(AGENCY_NAME_MAX) + "   ");
    expect(r.ok).toBe(true);
  });

  test("is not defensive about non-string input", () => {
    // Server actions read FormData, which can yield a File or null.
    expect(validateAgencyName(undefined as unknown as string).ok).toBe(false);
    expect(validateAgencyName(null as unknown as string).ok).toBe(false);
  });
});

// ── 2. Onboarding no longer seeds identity from an individual ───────────────

describe("2. onboarding does not derive the organisation name from a person", () => {
  test("the `<FirstName>'s Agency` default is gone", () => {
    expect(ONBOARDING_PAGE).not.toContain("'s Agency");
    expect(ONBOARDING_PAGE).not.toMatch(/user\?\.firstName/);
  });

  test("no suggestedName is threaded into the form at all", () => {
    expect(ONBOARDING_PAGE).not.toContain("suggestedName");
    expect(ONBOARDING_CLIENT).not.toContain("suggestedName");
    expect(ONBOARDING_CLIENT).not.toContain("defaultValue");
  });

  test("the field is still required, so an empty name cannot be submitted", () => {
    expect(ONBOARDING_CLIENT).toMatch(/id="agencyName"[\s\S]{0,400}?required/);
  });

  test("the label and copy describe an ORGANISATION, not an individual", () => {
    expect(ONBOARDING_CLIENT).toContain("Organisation name");
    expect(ONBOARDING_CLIENT).toMatch(/Everyone on your team sees this name/);
  });
});

// ── 3. A correction path exists, and both writers share one validator ───────

describe("3. the organisation name is correctable", () => {
  test("settings exposes a saveAgencyName server action", () => {
    expect(SETTINGS_ACTIONS).toMatch(/export async function saveAgencyName/);
  });

  test("it is admin-gated server-side, not merely hidden in the UI", () => {
    const at = SETTINGS_ACTIONS.indexOf("export async function saveAgencyName");
    const body = SETTINGS_ACTIONS.slice(at, at + 1200);
    expect(body).toContain("await requireAdmin()");
  });

  test("it writes through agencyScoped, so it can only rename the caller's agency", () => {
    const at = SETTINGS_ACTIONS.indexOf("export async function saveAgencyName");
    const body = SETTINGS_ACTIONS.slice(at, at + 1600);
    expect(body).toMatch(/agencyScoped\(prisma\.agency\)\.update/);
    expect(body).toMatch(/where:\s*\{\s*id:\s*member\.agencyId\s*\}/);
  });

  test("BOTH write paths use the same validator (they cannot diverge)", () => {
    expect(ONBOARDING_ACTIONS).toContain("validateAgencyName");
    expect(SETTINGS_ACTIONS).toContain("validateAgencyName");
    // The old hand-rolled onboarding check is gone.
    expect(ONBOARDING_ACTIONS).not.toContain("Agency name must be 120 characters");
  });

  test("the settings page renders the control", () => {
    expect(SETTINGS_PAGE).toContain("<OrganisationName");
    expect(SETTINGS_PAGE).toContain("member.agency.name");
  });
});

// ── 4. The rename is organisation-wide, not per-user ────────────────────────

describe("4. the name is shared organisation state", () => {
  test("the header reads it from the AGENCY record, not from the signed-in user", () => {
    // If this ever became a user-derived value, one member could see a different
    // organisation name from another — which is the bug this whole file guards.
    expect(AGENCY_LAYOUT).toContain("member.agency.name");
    expect(AGENCY_LAYOUT).not.toMatch(/user\.firstName|user\?\.firstName/);
  });

  test("a rename revalidates every surface that displays it", () => {
    const at = SETTINGS_ACTIONS.indexOf("export async function saveAgencyName");
    const body = SETTINGS_ACTIONS.slice(at, at + 2000);
    for (const path of ["/agency/settings", "/agency/dashboard", "/agency/hotels"]) {
      expect(body, path).toContain(`revalidatePath("${path}")`);
    }
  });
});

// ── 5. No two KPI cards on one screen share a bare label ────────────────────

describe("5. the agency dashboard does not show two bare 'ROAS' cards", () => {
  const DASHBOARD = readCode("app/(agency)/agency/(app)/dashboard/page.tsx");
  const ROLLUP = readCode("components/dashboard/AgencyRevenueRollup.tsx");

  test("the page-level card and the rollup card are distinguishable", () => {
    // Both figures are legitimate, but they answer different questions: the page
    // card is a fixed 30 days classified by UTM; the rollup has its own range +
    // hotel filter and classifies on the revenue-by-source basis (a coupon
    // booking counts as influencer, not paid). Two identical labels showing
    // different numbers on one screen is what destroyed confidence.
    expect(DASHBOARD).toContain('label="ROAS"');
    expect(ROLLUP).not.toContain('label="ROAS"');
    expect(ROLLUP).toContain('label="ROAS · this selection"');
  });

  test("every headline KPI on the agency dashboard states what it means", () => {
    // These cards previously carried no hint at all — unlike the hotel KPI
    // strip, which has explained itself for some time.
    for (const label of ["Visits", "Bookings", "Revenue", "ROAS", "Ad spend"]) {
      const at = DASHBOARD.indexOf(`label="${label}"`);
      expect(at, label).toBeGreaterThan(-1);
      expect(DASHBOARD.slice(at, at + 400), label).toContain("hint");
    }
  });

  test("the hints name the period, so the number is not undated", () => {
    expect(DASHBOARD).toContain("Paid-channel revenue ÷ ad spend · last 30 days");
    expect(DASHBOARD).toContain("Tracked page views · last 30 days");
  });
});

// ── 6. One date context per dashboard ───────────────────────────────────────

describe("6. the hotel dashboard has a single date context", () => {
  // The panels moved into the shared dashboard the agency page and the public
  // /share report both render; the invariant is unchanged, its home is not.
  const HOTEL_PAGE = readCode("components/dashboard/FullHotelDashboard.tsx");
  const SAVINGS = readCode("components/dashboard/CommissionSavings.tsx");
  const RBS = readCode("components/dashboard/RevenueBySource.tsx");

  test("the page selector is propagated to the panels that used to ignore it", () => {
    // CommissionSavings and RevenueBySource each owned a 7/30/90 toggle
    // defaulting to 30, so setting the page to 90 days left them on 30 with
    // nothing on screen revealing it.
    expect(HOTEL_PAGE).toMatch(/<CommissionSavings[^>]*from=\{range\.fromInput\}[^>]*to=\{range\.toInput\}/);
    expect(HOTEL_PAGE).toMatch(/<RevenueBySource[^>]*from=\{range\.fromInput\}[^>]*to=\{range\.toInput\}/);
  });

  test("a controlled panel uses the supplied range, not its own", () => {
    for (const [name, src] of [["CommissionSavings", SAVINGS], ["RevenueBySource", RBS]] as const) {
      expect(src, name).toMatch(/if \(from && to\) return \{ startDate: from, endDate: to \}/);
      expect(src, name).toContain("const controlled = Boolean(from && to);");
    }
  });

  test("a controlled panel hides its competing toggle and states the window", () => {
    for (const [name, src] of [["CommissionSavings", SAVINGS], ["RevenueBySource", RBS]] as const) {
      expect(src, name).toMatch(/controlled \?[\s\S]{0,300}\{startDate\} → \{endDate\}/);
    }
  });

  test("no panel carries its own period toggle any more", () => {
    // OwnerSummaryCard was the last one, and it is DELETED rather than fixed:
    // its API only ever supported a fixed 1d/7d/30d set, so on a 90-day or
    // custom report it silently showed a 30-day summary beside 90-day figures.
    // The two assertions it used to carry are replaced by its absence.
    expect(HOTEL_PAGE).not.toContain("OwnerSummaryCard");
    expect(HOTEL_PAGE).not.toContain("pageRangeKey");
  });
});
