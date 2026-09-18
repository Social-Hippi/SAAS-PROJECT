// ─────────────────────────────────────────────────────────────────────────────
// The base URL a SERVER is told to POST to.
//
// Not the same as the app URL. On Vercel the bare domain answers with a 308
// redirect to www. A browser follows that, which is why the tracking snippet
// served from https://hoteltrack.in/t.js works. A provider's webhook client
// generally does not follow a redirect on a POST, so a push to the bare domain
// stops at the redirect and never reaches the route — no booking, no error, and
// no log line on our side. That is what happened to the first Simplotel test
// bookings, which reached the thank-you pages but never the Booking Push route.
//
// So any URL shown for a server to call is rewritten to the host that answers
// directly. The app URL itself is left alone: OAuth callbacks registered with
// Meta and Google must match it exactly.
// ─────────────────────────────────────────────────────────────────────────────

/** Bare hosts that redirect to their www form. */
const REDIRECTING_APEX = new Set(["hoteltrack.in"]);

export function webhookBaseUrl(appUrl: string): string {
  try {
    const u = new URL(appUrl);
    if (REDIRECTING_APEX.has(u.hostname)) u.hostname = `www.${u.hostname}`;
    return u.origin;
  } catch {
    return appUrl.replace(/\/$/, "");
  }
}
