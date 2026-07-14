import type { NextConfig } from "next";

// ─────────────────────────────────────────────────────────────────────────────
// Security headers (audit finding M-1).
//
// The Content-Security-Policy is tailored to what HotelTrack actually loads:
//   • Clerk      — auth UI + API (script/connect/frame) and Cloudflare Turnstile
//                  bot-protection (challenges.cloudflare.com); avatars (img.clerk).
//   • Razorpay   — Checkout script (checkout.razorpay.com/v1/checkout.js, see
//                  app/(agency)/agency/billing/BillingPanel.tsx) which opens its
//                  payment UI in an iframe (api.razorpay.com) and posts telemetry.
//   • next/font  — Geist fonts are SELF-HOSTED by Next at build time, so no
//                  external font origin is needed ('self' covers them).
//   • Recharts   — pure client-side SVG, no external resources.
//
// 'unsafe-inline' in script-src is required because the Next.js App Router injects
// inline bootstrap scripts and we don't yet emit a per-request nonce. Tightening
// to a nonce-based policy is a future hardening step (tracked separately).
//
// frame-ancestors 'none' (+ X-Frame-Options: DENY) blocks clickjacking. HotelTrack
// embeds no iframes of its own and is not meant to be embedded — the public
// /h/<token> and /share/<uuid> dashboards are visited directly, not framed. If a
// hotel ever needs to embed its dashboard, relax frame-ancestors for those paths.
// ─────────────────────────────────────────────────────────────────────────────

const CLERK = "https://*.clerk.accounts.dev https://*.clerk.com";
const RAZORPAY_FRAME = "https://api.razorpay.com https://*.razorpay.com";

// 'unsafe-eval' is required in DEVELOPMENT only: Next.js dev (React Refresh / HMR)
// and Clerk's clerk-js both evaluate code at runtime, and without it clerk-js
// fails to initialize and the <SignIn/> widget renders blank. Per Clerk's CSP
// guidance (https://clerk.com/docs/guides/secure/best-practices/csp-headers),
// it must be REMOVED in production, so this is gated on NODE_ENV.
const isDev = process.env.NODE_ENV !== "production";
const SCRIPT_DEV_EVAL = isDev ? " 'unsafe-eval'" : "";

const ContentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${SCRIPT_DEV_EVAL} ${CLERK} https://challenges.cloudflare.com https://checkout.razorpay.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${CLERK} https://*.razorpay.com https://lumberjack.razorpay.com https://graph.facebook.com https://graph.instagram.com https://analyticsdata.googleapis.com https://oauth2.googleapis.com`,
  `frame-src 'self' ${CLERK} https://challenges.cloudflare.com ${RAZORPAY_FRAME}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy", value: ContentSecurityPolicy },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Every route gets the baseline security headers.
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        // The tracking snippet is a small, cacheable static asset.
        source: "/t.js",
        headers: [{ key: "Cache-Control", value: "public, max-age=300" }],
      },
      // NOTE: CORS for /api/track/* is set by the route handlers themselves
      // (app/api/track/event + /config), which also handle the OPTIONS preflight.
      // We deliberately do NOT duplicate Access-Control-Allow-Origin here — two
      // copies of that header make browsers reject the response. See the route
      // handlers for the cross-origin contract.
    ];
  },
};

export default nextConfig;
