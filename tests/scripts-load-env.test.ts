import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// SCRIPTS MUST BE ABLE TO REACH A DATABASE.
//
// Forty scripts opened with `import "dotenv/config"`, which reads only `.env` —
// a file this repo does not keep values in. The real values live in
// `.env.development.local` and `.env.local`. So DATABASE_URL arrived undefined,
// the Prisma adapter fell back to libpq defaults, and the script failed with
// "DatabaseDoesNotExist" or hung on a socket that was never there. Every one of
// them only worked if the caller happened to export DATABASE_URL by hand.
//
// scripts/load-env.ts already existed to fix exactly this. It was simply never
// adopted.
//
// TWO THINGS THE LOADER ITSELF HAD TO GAIN FIRST, or switching forty scripts to
// it would have traded one failure for a worse one:
//
//   1. REDACTION PLACEHOLDERS MUST NOT BE PROMOTED. `.env.local` is a redacted
//      `vercel env pull`: 27 of its 49 entries are bracketed placeholders, and
//      16 of those have no real value shadowing them. Promoting "[SENSITIVE]"
//      into process.env does not merely fail to configure a thing — it
//      MISCONFIGURES it. A script guarding with `if (!process.env.META_APP_ID)`
//      sees a non-empty string, sails past the check, and calls the Graph API
//      with the literal text. tests/setup-env.ts records the same trap costing
//      95 tests across 16 suites.
//
//   2. PATHS MUST RESOLVE AGAINST THE REPO ROOT. dotenv resolves a relative
//      `path` against process.cwd(), so the loader silently loaded nothing when
//      a script was run from a subdirectory.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = join(__dirname, "..");
const LOADER = readCode("scripts/load-env.ts");

/** Run a snippet through tsx and return its stdout. */
function runNode(code: string, cwd: string): string {
  return execFileSync("npx", ["tsx", "-e", code], {
    cwd,
    encoding: "utf8",
    // A real shell export must not leak in and mask what the files provide.
    env: { ...process.env, INSTAGRAM_APP_ID: undefined, DATABASE_URL: undefined } as NodeJS.ProcessEnv,
  }).trim();
}

describe("1. every script loads env through the shared loader", () => {
  const scripts = readdirSync(join(REPO_ROOT, "scripts"))
    .filter((f) => f.endsWith(".ts") && f !== "load-env.ts");

  test("there are scripts to check", () => {
    expect(scripts.length).toBeGreaterThan(30);
  });

  test('no script opens with `import "dotenv/config"`', () => {
    const offenders = scripts.filter((f) =>
      readFileSync(join(REPO_ROOT, "scripts", f), "utf8").includes('import "dotenv/config"'),
    );
    expect(offenders, `still on dotenv/config: ${offenders.join(", ")}`).toEqual([]);
  });

  test("every script that touches the database imports the loader FIRST", () => {
    // First, because lib/prisma.ts builds its adapter from DATABASE_URL at
    // module-load time — an import ordered after it reads an unset variable.
    const dbScripts = scripts.filter((f) =>
      readFileSync(join(REPO_ROOT, "scripts", f), "utf8").includes("lib/prisma"),
    );
    expect(dbScripts.length).toBeGreaterThan(20);

    for (const f of dbScripts) {
      const src = readFileSync(join(REPO_ROOT, "scripts", f), "utf8");
      const imports = [...src.matchAll(/^import\s.*$/gm)].map((m) => m[0]);
      expect(imports[0], f).toMatch(/load-env/);
    }
  });
});

describe("2. the loader does not promote redaction placeholders", () => {
  test("a bracketed placeholder is skipped; a real value is not", () => {
    const out = runNode(
      'import "./scripts/load-env";' +
        'console.log(JSON.stringify({' +
        '  placeholder: process.env.INSTAGRAM_APP_ID ?? null,' +
        '  real: (process.env.DATABASE_URL ?? "").slice(0, 11) || null,' +
        '}));',
      REPO_ROOT,
    );
    const got = JSON.parse(out.split("\n").at(-1)!);

    // INSTAGRAM_APP_ID is "[SENSITIVE]" in .env.local with nothing shadowing it.
    expect(got.placeholder).toBeNull();
    // DATABASE_URL is a real value in the same file and must still arrive.
    expect(got.real).toBe("postgresql:");
  });

  test("the loader carries the filter, and it matches the bracketed shape", () => {
    expect(LOADER).toMatch(/REDACTION_PLACEHOLDER/);
    const m = LOADER.match(/REDACTION_PLACEHOLDER = (\/.*\/)/);
    expect(m, "the placeholder pattern should be a literal regex").not.toBeNull();

    const pattern = new RegExp(m![1].slice(1, -1));
    for (const v of ["[SENSITIVE]", "[REDACTED]", "[NOT SET]"]) {
      expect(pattern.test(v), v).toBe(true);
    }
    // No real credential looks like this, and lower-case bracketed text is not
    // a placeholder shape this repo produces.
    for (const v of ["postgresql://x", "pk_live_abc", "[abc]", "sk_test_1", ""]) {
      expect(pattern.test(v), v).toBe(false);
    }
  });

  test("a real shell export still wins over anything in a file", () => {
    const out = execFileSync(
      "npx",
      ["tsx", "-e", 'import "./scripts/load-env"; console.log(process.env.INSTAGRAM_APP_ID ?? "unset");'],
      { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, INSTAGRAM_APP_ID: "real-from-shell" } },
    ).trim();
    expect(out.split("\n").at(-1)).toBe("real-from-shell");
  });
});

describe("3. the loader resolves against the repo root, not the caller's cwd", () => {
  test("it still loads when a script is run from a subdirectory", () => {
    // dotenv resolves a relative `path` against process.cwd(), so the previous
    // implementation silently loaded NOTHING from anywhere but the repo root.
    const out = runNode(
      'import "../scripts/load-env"; console.log((process.env.DATABASE_URL ?? "unset").slice(0, 11));',
      join(REPO_ROOT, "scripts"),
    );
    expect(out.split("\n").at(-1)).toBe("postgresql:");
  });

  test("it computes a root from its own module URL rather than trusting cwd", () => {
    expect(LOADER).toContain("fileURLToPath");
    expect(LOADER).toMatch(/REPO_ROOT/);
    expect(LOADER).toMatch(/path\.join\(REPO_ROOT, file\)/);
  });
});

describe("4. deliberately left alone", () => {
  test("prisma.config.ts is untouched — it is the path every migration has used", () => {
    expect(readCode("prisma.config.ts")).toContain('import "dotenv/config"');
  });

  test("prisma/seed.ts is untouched too, and still carries the same bug", () => {
    // Not fixed here on purpose: it was grouped with prisma.config.ts, and this
    // change is scoped to scripts/. It fails the same way — see the PR.
    expect(readCode("prisma/seed.ts")).toContain('import "dotenv/config"');
  });
});
