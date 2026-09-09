import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");

/**
 * Read a source file with comments stripped, for source-level assertions.
 *
 * Several suites assert on source text because the thing that regressed is a
 * Prisma projection, a JSX binding, or a piece of user-facing copy — none of
 * which a unit test can reach without a database and a renderer. Those files
 * also DOCUMENT the defect they fixed, often quoting the old broken string, so a
 * naive substring check matches the explanation and fails on a correct file.
 * Stripping comments keeps the assertions honest in both directions: they can
 * be satisfied by neither prose nor a comment.
 *
 * ORDER MATTERS, and getting it wrong silently weakens every assertion that
 * uses it. Line comments MUST be removed before block comments: this codebase
 * writes route globs in prose (`every /api/hotel/[id]/* data route`), and that
 * `/*` opens a block-comment match which then runs to the next `*&#47;`
 * ANYWHERE in the file — swallowing real code in between. That is not
 * hypothetical: it ate `function hotelAccessNeutralized()` out of
 * lib/hotel-auth.ts, and the assertion failed rather than silently passing only
 * because the test happened to look for something inside the swallowed region.
 */
export function readCode(relativePath: string): string {
  return (
    readFileSync(join(root, relativePath), "utf8")
      // 1. Whole-line `//` comments — FIRST, so a `/*` written inside one can
      //    never open a block match over real code.
      .replace(/^[ \t]*\/\/.*$/gm, "")
      // 2. Trailing `//` comments on a line of code.
      .replace(/\s\/\/[^\n]*$/gm, "")
      // 3. Block comments, including JSDoc.
      .replace(/\/\*[\s\S]*?\*\//g, " ")
  );
}
