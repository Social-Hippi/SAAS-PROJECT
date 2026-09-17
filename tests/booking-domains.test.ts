import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";
import { normalizeBookingHost } from "@/lib/booking-domains";

// ─────────────────────────────────────────────────────────────────────────────
// The setting that decides whether ad attribution works at all.
//
// A guest clicks a Google ad, lands on the hotel's site carrying a gclid, then
// follows a booking link to a DIFFERENT host. Cookies are per-origin, so nothing
// crosses on its own — the snippet bridges it by rewriting outbound booking
// links with a token carrying the session, visitor, UTMs and click ids.
//
// It only rewrites links to hosts on this list. An empty list decorates nothing,
// every ad click dies at the domain boundary, and the booking that follows looks
// organic forever. Nothing errors.
//
// On Aster that was the entire bottleneck: 4,057 gclid-carrying visits reached
// asterholidays.com and ZERO reached bookings.coffeeberryhills.in. The setting
// had never been reachable — it could only be set when a hotel was created.
// ─────────────────────────────────────────────────────────────────────────────

const ACTIONS = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/booking-domain-actions.ts");
const HELPER = readCode("lib/booking-domains.ts");
const CARD = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/BookingDomainsCard.tsx");
const PAGE = readCode("app/(agency)/agency/(app)/hotel/[id]/integrations/page.tsx");

describe("1. what an operator actually pastes is accepted", () => {
  test.each([
    ["bookings.example.com", "bare host"],
    ["https://bookings.example.com", "full URL"],
    ["http://bookings.example.com/path?x=1", "URL with path and query"],
    ["BOOKINGS.Example.COM", "mixed case"],
    ["bookings.example.com/", "trailing slash"],
    ["bookings.example.com:443", "explicit port"],
    ["  bookings.example.com  ", "padding"],
  ])("%s (%s)", (input) => {
    // A setting that silently fails on a trailing slash is the same class of bug
    // as the one it exists to fix.
    expect(normalizeBookingHost(input)).toBe("bookings.example.com");
  });
});

describe("1b. a wildcard prefix keeps the domain it wildcards", () => {
  test("*.example.com becomes example.com", () => {
    // The snippet already matches true subdomains, so the wildcard is redundant
    // rather than wrong — it is stripped, not rejected.
    expect(normalizeBookingHost("*.example.com")).toBe("example.com");
  });
});

describe("2. what is refused", () => {
  test.each([[""], ["   "], ["not a host"], ["localhost"], ["/just/a/path"], ["..."], ["ex ample.com"]])(
    "%s yields null",
    (input) => {
      expect(normalizeBookingHost(input)).toBeNull();
    },
  );

  test("a partially valid list is refused whole", () => {
    // Saving the valid half looks like success and silently omits a host, which
    // is exactly how attribution goes missing without a symptom.
    expect(ACTIONS).toMatch(/if \(rejected\.length > 0\)/);
    expect(ACTIONS).toMatch(/Not a valid hostname/);
  });
});

describe("3. a listed host receives real visitor identity", () => {
  test("entries are stored as bare hostnames", () => {
    // The snippet matches a host exactly or as a true subdomain — never as a
    // bare suffix, or an entry for "example.com" would hand identity to
    // "evil-example.com".
    expect(normalizeBookingHost("https://a.b.example.com/x")).toBe("a.b.example.com");
  });

  test("duplicates collapse", () => {
    expect(ACTIONS).toMatch(/if \(!hosts\.includes\(host\)\)/);
  });

  test("only an agency admin, scoped to their own hotel, can change it", () => {
    expect(ACTIONS).toContain("requireAdmin");
    expect(ACTIONS).toMatch(/agencyScoped\(prisma\.hotelClient\)[\s\S]{0,120}findFirst/);
    expect(ACTIONS).toMatch(/agencyScoped\(prisma\.hotelClient\)\.updateMany/);
  });
});

describe("4. the UI states the consequence, not the mechanism", () => {
  test("an empty list is called out as breaking attribution", () => {
    // "Cross-domain link decoration" tells an operator nothing about whether it
    // matters. "Bookings from your ads are not counted" does.
    expect(CARD).toMatch(/ad clicks stop at the website/i);
    expect(CARD).toMatch(/cannot be credited to the ad/i);
  });

  test("it offers hosts that have actually sent data", () => {
    // Choosing from reality beats recalling a hostname.
    expect(PAGE).toMatch(/bookingHostsSeen/);
    expect(CARD).toMatch(/Seen sending data/);
  });

  test("the hotel's own site is not offered as a booking domain", () => {
    expect(PAGE).toMatch(/h !== ownHost/);
  });

  test("it says the fix is not retrospective", () => {
    // The clicks that already happened cannot be linked, and an operator who
    // expects yesterday's bookings to appear will think it is broken.
    expect(CARD).toMatch(/cannot be linked retrospectively/i);
  });

  test("the setting is rendered on the integrations page", () => {
    expect(PAGE).toContain("<BookingDomainsCard");
    expect(PAGE).toMatch(/bookingDomains: true/);
  });
});

describe("5. the helper is not a server action", () => {
  test("it lives outside the \"use server\" module", () => {
    // A "use server" file may only export async functions; a sync helper there
    // fails the production build. Tests alone do not catch this.
    expect(HELPER).toContain("export function normalizeBookingHost");
    expect(ACTIONS).not.toContain("export function normalizeBookingHost");
    expect(ACTIONS).toMatch(/import \{ normalizeBookingHost \} from "@\/lib\/booking-domains"/);
  });
});
