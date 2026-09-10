import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { isRedactionPlaceholder } from "@/scripts/env-redaction";
import { readCode } from "./helpers/read-code";

// ─────────────────────────────────────────────────────────────────────────────
// SCRIPTS MUST BE ABLE TO REACH A DATABASE.
//
// Thirty-nine scripts opened with `import "dotenv/config"`, which reads only
// `.env` — a file this repo does not keep values in. The real values live in
// `.env.development.local` and `.env.local`. So DATABASE_URL arrived undefined,
// the Prisma adapter fell back to libpq defaults, and the script died on
// "DatabaseDoesNotExist". Each one only worked if the caller happened to export
// DATABASE_URL by hand first.
//
// scripts/load-env.ts already existed to fix this. It was never adopted, and it
// needed two fixes before adopting it was safe.
//
// ── WHY THE ASSERTIONS ARE SPLIT THE WAY THEY ARE ────────────────────────────
//
// The env files this loader reads are gitignored developer files. CI has none of
// them, so a test that asserts on their CONTENT passes locally and fails in CI —
// which is exactly what the first version of this file did.
//
// So the RULE is tested purely, through scripts/env-redaction.ts, and runs
// everywhere. The STRUCTURE is tested by reading source, and runs everywhere.
// Only the end-to-end behaviour needs real files, and it skips explicitly rather
// than silently passing on a machine that cannot exercise it.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = join(__dirname, "..");
const LOADER = readCode("scripts/load-env.ts");
const HAS_LOCAL_ENV = existsSync(join(REPO_ROOT, ".env.local"));

describe("1. every script loads env through the shared loader", () => {
  const scripts = readdirSync(join(REPO_ROOT, "scripts"))
    .filter((f) => f.endsWith(".ts") && f !== "load-env.ts" && f !== "env-redaction.ts");

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

describe("2. redaction placeholders are recognised — the rule, tested purely", () => {
  test("bracketed placeholder shapes are placeholders", () => {
    for (const v of ["[SENSITIVE]", "[REDACTED]", "[NOT SET]", "  [SENSITIVE]  "]) {
      expect(isRedactionPlaceholder(v), v).toBe(true);
    }
  });

  test("real credentials are not", () => {
    for (const v of [
      "postgresql://user:pw@host/db",
      "pk_live_abc123",
      "sk_test_abc123",
      "[abc]", // lower case is not the shape Vercel emits
      "SENSITIVE",
      "",
      "a".repeat(64),
    ]) {
      expect(isRedactionPlaceholder(v), JSON.stringify(v)).toBe(false);
    }
  });

  test("the loader applies the rule, and a shell export still wins", () => {
    expect(LOADER).toContain("isRedactionPlaceholder(value)");
    // Order matters: the shell check comes first, so an exported placeholder set
    // deliberately by a developer is still honoured.
    const shellCheck = LOADER.indexOf("process.env[name] !== undefined");
    const filter = LOADER.indexOf("isRedactionPlaceholder(value)");
    expect(shellCheck).toBeGreaterThan(-1);
    expect(filter).toBeGreaterThan(shellCheck);
  });
});

describe("3. the loader resolves against the repo root, not the caller's cwd", () => {
  test("it computes a root from its own module URL rather than trusting cwd", () => {
    // dotenv resolves a relative `path` against process.cwd(), so the previous
    // implementation silently loaded NOTHING from anywhere but the repo root.
    expect(LOADER).toContain("fileURLToPath");
    expect(LOADER).toMatch(/REPO_ROOT/);
    expect(LOADER).toMatch(/path\.join\(REPO_ROOT, file\)/);
  });

  test("it stages before writing, so values can be inspected first", () => {
    expect(LOADER).toMatch(/processEnv: staged/);
  });
});

// End-to-end. Needs the gitignored developer env files, so it is SKIPPED rather
// than silently vacuous where they do not exist — CI, a fresh clone, a container.
describe.skipIf(!HAS_LOCAL_ENV)("4. end-to-end, where developer env files exist", () => {
  const run = (code: string, cwd: string) =>
    execFileSync("npx", ["tsx", "-e", code], { cwd, encoding: "utf8" }).trim().split("\n").at(-1);

  test("a real value loads and a placeholder does not", () => {
    const out = run(
      'import "./scripts/load-env";' +
        'console.log(JSON.stringify({' +
        '  placeholder: process.env.INSTAGRAM_APP_ID ?? null,' +
        '  real: (process.env.DATABASE_URL ?? "").slice(0, 11) || null }));',
      REPO_ROOT,
    );
    const got = JSON.parse(out!);
    expect(got.placeholder).toBeNull();
    expect(got.real).toBe("postgresql:");
  });

  test("it still loads when a script is run from a subdirectory", () => {
    expect(
      run('import "../scripts/load-env"; console.log((process.env.DATABASE_URL ?? "unset").slice(0,11));',
        join(REPO_ROOT, "scripts")),
    ).toBe("postgresql:");
  });
});

describe("5. deliberately left alone", () => {
  test("prisma.config.ts is untouched — it is the path every migration has used", () => {
    expect(readCode("prisma.config.ts")).toContain('import "dotenv/config"');
  });

  test("prisma/seed.ts is untouched too, and still carries the same bug", () => {
    // Not fixed here on purpose: it was grouped with prisma.config.ts, and this
    // change is scoped to scripts/. It fails the same way — see the PR.
    expect(readCode("prisma/seed.ts")).toContain('import "dotenv/config"');
  });
});
