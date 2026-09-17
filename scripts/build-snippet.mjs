import { build } from "esbuild";

// ─────────────────────────────────────────────────────────────────────────────
// Builds public/t.js from scripts/snippet.src.js.
//
// A script rather than an inline esbuild command because of ONE substitution:
// __HT_BASE__ is replaced with the canonical app origin at build time, and
// quoting a JSON string through npm-script → shell → esbuild is the kind of
// thing that silently produces `"__HT_BASE__"` instead of a URL. It did.
//
// WHY THE SNIPPET CANNOT JUST USE ITS OWN SCRIPT ORIGIN. A hotel that pastes the
// apex form of the tag sends every API call to the apex, and an apex that
// redirects to www breaks the CONFIG fetch while leaving everything else working
// — sendBeacon follows the redirect, a CORS fetch does not. Visits keep
// arriving, so nothing looks broken, while conversion detection and booking-link
// decoration are never configured at all.
// ─────────────────────────────────────────────────────────────────────────────

const canonical = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");

// An explicit destination lets a test build without overwriting the shipped
// public/t.js, which several other suites read.
const outfile = process.argv[2] ?? "public/t.js";

if (!canonical) {
  // Not fatal: the snippet falls back to its own script origin, which is correct
  // for a preview deployment talking to itself. Loud, because shipping the
  // fallback to production reintroduces the apex/www bug.
  console.warn(
    "[build:snippet] NEXT_PUBLIC_APP_URL is not set — the snippet will call " +
      "whichever origin its <script> tag was loaded from. Correct for a preview; " +
      "wrong for production if the tag uses a host that redirects.",
  );
}

await build({
  entryPoints: ["scripts/snippet.src.js"],
  outfile,
  minify: true,
  legalComments: "none",
  banner: { js: "/* HotelTrack tracking snippet — generated from scripts/snippet.src.js */" },
  define: { __HT_BASE__: JSON.stringify(canonical) },
});

console.log(`[build:snippet] ${outfile} — API origin: ${canonical || "(script origin at runtime)"}`);
