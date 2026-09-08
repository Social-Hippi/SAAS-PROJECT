import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readCode } from "./helpers/read-code";
import { snippetState } from "@/lib/integration-status";
import { trackingHealth } from "@/lib/data-health";

// The defect this suite exists for
// --------------------------------
// The hotel dashboard decided whether to show "Finish setup: install your
// tracking snippet" with:
//
//     const installed = snippetStatus === "installed";
//
// Nothing in the codebase has ever written the string "installed". The tracker
// writes "live", the alert job writes "error", and the schema default is
// "not_installed" — so the comparison was false for every hotel that has ever
// existed, and a hotel whose tracking had been working for months was told, on
// every single load, that it still had to set it up.
//
// It type-checked, it linted, and no test could see it, because the defect was
// not in the shape of the code — it was in a value that no writer produces.
//
// So these assertions are about VOCABULARY and about WIRING, which is where this
// class of bug lives: a reader comparing against a literal nothing writes, or a
// verdict that is computed correctly and then never rendered.

const ROOT = join(__dirname, "..");
const SCAN_DIRS = ["app", "components", "lib"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

const ALL_SOURCES = SCAN_DIRS.flatMap(sourceFiles);
const rel = (abs: string) => abs.slice(ROOT.length + 1);

describe("1. snippetStatus vocabulary", () => {
  // Every literal any writer stores, plus the schema default. This is derived
  // from the source rather than hardcoded, so adding a new status to the writers
  // widens the vocabulary automatically — but MISSPELLING one in a reader still
  // fails, which is the whole point.
  const written = new Set<string>();

  for (const file of ALL_SOURCES) {
    const code = readCode(rel(file));
    for (const m of code.matchAll(/snippetStatus:\s*"([^"]+)"/g)) written.add(m[1]);
  }
  const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
  const dflt = /snippetStatus\s+String\s+@default\("([^"]+)"\)/.exec(schema);
  if (dflt) written.add(dflt[1]);

  it("the writers produce a non-empty, known set of statuses", () => {
    // A guard on the guard: if the scan silently matched nothing, every
    // assertion below would pass vacuously.
    expect(written.size).toBeGreaterThan(0);
    expect(written).toContain("live");
    expect(written).toContain("not_installed");
  });

  it("no reader compares snippetStatus to a value no writer ever stores", () => {
    const bogus: string[] = [];
    for (const file of ALL_SOURCES) {
      const code = readCode(rel(file));
      for (const m of code.matchAll(/snippetStatus\s*[!=]==\s*"([^"]+)"/g)) {
        if (!written.has(m[1])) bogus.push(`${rel(file)}: compares against "${m[1]}"`);
      }
    }
    // "installed" is the value that produced the permanent setup banner.
    expect(bogus).toEqual([]);
  });

  it("snippetStatus is interpreted in exactly one module", () => {
    // Deciding what a raw status MEANS belongs to snippetState(). A second
    // interpreter is how the two surfaces drift into disagreeing about whether
    // the same hotel is set up.
    const interpreters = ALL_SOURCES.filter((f) =>
      /snippetStatus\s*[!=]==\s*"/.test(readCode(rel(f))),
    ).map(rel);

    // The tracking endpoint is allowed: its comparison guards its own WRITE
    // (don't re-stamp "live" on every event), it does not render anything.
    const renderers = interpreters.filter((f) => f !== "app/api/track/event/route.ts");
    expect(renderers).toEqual(["lib/integration-status.ts"]);
  });
});

describe("2. the verdict reaches both audiences", () => {
  const HOTEL_BODY = readCode("components/dashboard/HotelDashboardBody.tsx");
  // Lives in the shared dashboard now, which the agency page and the public
  // /share report both render — so this pins BOTH audiences at once.
  const AGENCY_PAGE = readCode("components/dashboard/FullHotelDashboard.tsx");

  it("the hotel's own dashboard renders the shared verdict", () => {
    expect(HOTEL_BODY).toContain("trackingHealth(");
    expect(HOTEL_BODY).toContain("<DataHealthBanner");
  });

  it("the agency's view of the same hotel renders the same verdict", () => {
    expect(AGENCY_PAGE).toContain("trackingHealth(");
    expect(AGENCY_PAGE).toContain("<DataHealthBanner");
  });

  it("neither surface hand-rolls its own setup banner", () => {
    // The replaced copy. If it comes back, two components are deciding
    // independently whether tracking is working.
    expect(HOTEL_BODY).not.toContain("Finish setup");
    expect(HOTEL_BODY).not.toMatch(/const installed\s*=/);
  });

  it("the banner decides its own visibility", () => {
    // DataHealthBanner returns null when the data is trustworthy. A caller that
    // gates it with its own condition re-introduces a second opinion — and the
    // caller's condition is the one that was wrong last time.
    for (const [name, src] of [
      ["hotel dashboard", HOTEL_BODY],
      ["agency hotel page", AGENCY_PAGE],
    ] as const) {
      const line = src.split("\n").find((l) => l.includes("<DataHealthBanner"));
      expect(line, `${name} renders the banner`).toBeDefined();
      expect(line, `${name} must not gate the banner`).not.toContain("&&");
    }
  });
});

describe("3. lastEventAt actually reaches the verdict", () => {
  const HOTEL_BODY = readCode("components/dashboard/HotelDashboardBody.tsx");
  const HOTEL_PAGE = readCode("app/hotel/[hotelClientId]/dashboard/page.tsx");
  const HOTEL_AUTH = readCode("lib/hotel-auth.ts");

  // Without lastEventAt the verdict collapses: "installed but has never once
  // worked" and "worked, then went silent" both become "no activity in this
  // period", which is the reassuring answer and the wrong one.

  it("the loader selects it", () => {
    expect(HOTEL_AUTH).toMatch(/lastEventAt:\s*true/);
  });

  it("the page passes the loaded value, not a placeholder", () => {
    expect(HOTEL_PAGE).toContain("lastEventAt={hotel.lastEventAt}");
    expect(HOTEL_PAGE).not.toContain("lastEventAt={null}");
  });

  it("the body feeds it to trackingHealth rather than only accepting it", () => {
    const call = /trackingHealth\(\{[\s\S]*?\}\)/.exec(HOTEL_BODY)?.[0] ?? "";
    expect(call).toContain("lastEventAt");
    expect(call).toContain("snippetState(");
    expect(call).toContain("hasEventsInWindow");
  });
});

describe("4. snippetState and trackingHealth agree end to end", () => {
  // The suites for each function pass their own inputs. This one runs the pair
  // the way the dashboards do — raw DB values in, verdict out — because the
  // defect lived in the seam between them, not inside either.
  const now = new Date("2026-09-05T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  const verdict = (snippetStatus: string, lastEventAt: Date | null, hasEventsInWindow: boolean) =>
    trackingHealth({
      snippet: snippetState(snippetStatus, lastEventAt),
      lastEventAt,
      hasEventsInWindow,
      now,
    });

  it("a live, recently-active hotel is told nothing", () => {
    const v = verdict("live", hoursAgo(1), true);
    expect(v.state).toBe("healthy");
    expect(v.trustworthy).toBe(true);
  });

  it("a live hotel with a genuinely quiet week is told its zeros are real", () => {
    const v = verdict("live", hoursAgo(1), false);
    expect(v.state).toBe("no_activity");
    // The distinction the whole module exists for: this zero is a fact.
    expect(v.trustworthy).toBe(true);
  });

  it("a hotel that has gone silent is not told its zeros are real", () => {
    const v = verdict("live", hoursAgo(24 * 7), false);
    expect(v.state).toBe("broken");
    expect(v.trustworthy).toBe(false);
    expect(v.action).toBeTruthy();
  });

  it("a hotel that never installed the snippet is not shown a zero at all", () => {
    const v = verdict("not_installed", null, false);
    expect(v.state).toBe("not_installed");
    expect(v.trustworthy).toBe(false);
  });

  it("a hotel whose snippet errored but is still sending is not called uninstalled", () => {
    // snippetStatus "error" with recent events → the alert job flagged it, but
    // data is arriving. Calling that "not installed" would send the hotel to
    // re-do setup it has already done.
    const v = verdict("error", hoursAgo(2), true);
    expect(v.state).not.toBe("not_installed");
  });
});
