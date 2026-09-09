// "Can I trust this number?" — PURE. No DB, no session, no "server-only", so the
// server components that render a metric, the components that render an empty
// state, and the tests all reach the same verdict from the same inputs.
//
// THE PROBLEM THIS EXISTS FOR
//
// A hotel dashboard showing "Bookings: 0" gives the reader no way to tell which
// of these is true:
//
//   • there genuinely were no bookings in this period
//   • the tracking snippet was never installed
//   • the snippet was installed but the hotel changed its thank-you page, so
//     conversions stopped being detected while page views kept flowing
//   • no ad account is connected, so there is no spend to divide by
//   • the nightly sync failed and the data is stale
//
// Those need five different things said, and four of them are not "0". Rendering
// them identically is the single fastest way to lose a client's trust, because
// the one case they will check is the one where the number was wrong.
//
// This module does NOT invent new signals. It composes the ones the app already
// records — snippet status, last event time, integration state, last sync — into
// a single verdict, so every surface answers the question the same way.
//
// It deliberately does NOT decide what to RENDER. It returns a state and the
// reason for it; presentation belongs to the component.

import type { SnippetState } from "@/lib/integration-status";

/**
 * How much a metric on screen can be relied on.
 *
 * Ordered from "safe to act on" to "do not act on this". The ordering is
 * meaningful — `worstOf` uses it to roll several signals into one verdict.
 */
export const DATA_HEALTH_STATES = [
  /** Tracking is live and recent. A zero here is a real zero. */
  "healthy",
  /** Live, but the newest data predates the window being viewed. */
  "stale",
  /** Live and recent, but nothing has happened yet in this window. */
  "no_activity",
  /** The source this metric needs is not connected at all. */
  "not_connected",
  /** Installed, but nothing has ever arrived — it may never have worked. */
  "never_received",
  /** It worked, then stopped. The most urgent state: something broke. */
  "broken",
  /** Not installed. Nothing downstream of it can mean anything. */
  "not_installed",
] as const;

export type DataHealthState = (typeof DATA_HEALTH_STATES)[number];

/** Rank for `worstOf`. Higher = more strongly "do not trust this number". */
const SEVERITY: Record<DataHealthState, number> = {
  healthy: 0,
  no_activity: 1,
  stale: 2,
  not_connected: 3,
  never_received: 4,
  broken: 5,
  not_installed: 6,
};

export type DataHealth = {
  state: DataHealthState;
  /** True only when a figure derived from this source is safe to show as a fact. */
  trustworthy: boolean;
  /** One short sentence for the reader. Plain language, no jargon, no ids. */
  message: string;
  /** What the reader (or their agency) should do. Null when nothing is needed. */
  action: string | null;
};

/** How long without an event before a LIVE snippet is treated as broken. */
export const SNIPPET_SILENCE_BROKEN_HOURS = 48;

/** How old the newest synced day may be before a platform metric reads stale. */
export const SYNC_STALE_HOURS = 48;

const HOUR_MS = 3_600_000;

function hoursSince(d: Date | null, now: Date): number | null {
  if (!d) return null;
  return (now.getTime() - d.getTime()) / HOUR_MS;
}

/**
 * Health of the TRACKING signal — the source of every visit, conversion and
 * revenue figure.
 *
 * `hasEventsInWindow` is what separates "nothing happened" from "something
 * broke": a hotel that is still sending page views but has recorded no
 * conversions is a very different situation from one that has gone silent, and
 * only the caller knows which window is on screen.
 */
export function trackingHealth(input: {
  snippet: SnippetState;
  /** Newest event of ANY kind, ever. Null = nothing has ever arrived. */
  lastEventAt: Date | null;
  /** Did the period being viewed contain any tracked activity at all? */
  hasEventsInWindow: boolean;
  now?: Date;
}): DataHealth {
  const now = input.now ?? new Date();
  const silentHours = hoursSince(input.lastEventAt, now);

  if (input.snippet === "not_installed" && !input.lastEventAt) {
    return {
      state: "not_installed",
      trustworthy: false,
      message: "Tracking isn't installed on this website yet.",
      action: "Add the tracking snippet to start measuring visits and bookings.",
    };
  }

  if (!input.lastEventAt) {
    return {
      state: "never_received",
      trustworthy: false,
      message: "We haven't received any activity from this website yet.",
      action: "Check the snippet is on the live site and that the ID matches.",
    };
  }

  // It worked, then stopped. This is the case that silently destroys trust: page
  // views can keep flowing while a changed thank-you page stops conversions, so
  // "0 bookings" reads as a business outcome instead of a measurement failure.
  if (silentHours !== null && silentHours >= SNIPPET_SILENCE_BROKEN_HOURS) {
    return {
      state: "broken",
      trustworthy: false,
      message: `No activity received for ${Math.floor(silentHours / 24)} days — tracking may have stopped working.`,
      action: "Check the snippet is still installed on the website.",
    };
  }

  if (input.snippet !== "live") {
    return {
      state: "never_received",
      trustworthy: false,
      message: "Tracking is set up but hasn't confirmed it's working yet.",
      action: "Visit the website once to confirm tracking is live.",
    };
  }

  if (!input.hasEventsInWindow) {
    return {
      state: "no_activity",
      // A real zero IS trustworthy — that is the whole point of separating it.
      trustworthy: true,
      message: "Tracking is working. There was no activity in this period.",
      action: null,
    };
  }

  return { state: "healthy", trustworthy: true, message: "Tracking is working.", action: null };
}

/**
 * Health of a PLATFORM metric (ad spend, analytics) — data HotelTrack pulls on a
 * schedule rather than observes directly.
 *
 * `connected: false` is reported as not_connected rather than as a zero, because
 * "we spent nothing" and "we don't know what you spent" are different claims and
 * only one of them belongs in a ROAS denominator.
 */
export function platformHealth(input: {
  label: string;
  connected: boolean;
  /** Provider says the credential needs attention (expired / requiresReconnect). */
  needsReconnect?: boolean;
  lastSyncedAt: Date | null;
  now?: Date;
}): DataHealth {
  const now = input.now ?? new Date();

  if (!input.connected) {
    return {
      state: "not_connected",
      trustworthy: false,
      message: `${input.label} isn't connected.`,
      action: `Connect ${input.label} to include its spend and results.`,
    };
  }

  if (input.needsReconnect) {
    return {
      state: "broken",
      trustworthy: false,
      message: `${input.label} needs to be reconnected — its data has stopped updating.`,
      action: `Reconnect ${input.label}.`,
    };
  }

  if (!input.lastSyncedAt) {
    return {
      state: "never_received",
      trustworthy: false,
      message: `${input.label} is connected but hasn't sent any data yet.`,
      action: "The first sync runs overnight.",
    };
  }

  const age = hoursSince(input.lastSyncedAt, now);
  if (age !== null && age >= SYNC_STALE_HOURS) {
    return {
      state: "stale",
      trustworthy: false,
      message: `${input.label} last updated ${Math.floor(age / 24)} days ago.`,
      action: "Check the connection — recent days may be missing.",
    };
  }

  return { state: "healthy", trustworthy: true, message: `${input.label} is up to date.`, action: null };
}

/**
 * Roll several signals into the one verdict a composite metric deserves.
 *
 * A ROAS needs BOTH tracking (its numerator) and an ad platform (its
 * denominator), so it is only as trustworthy as its weakest input. Returning the
 * worst — rather than an average or the first — is what stops a figure being
 * presented confidently because one of its two sources happened to be fine.
 */
export function worstOf(...healths: DataHealth[]): DataHealth {
  if (healths.length === 0) {
    return { state: "healthy", trustworthy: true, message: "", action: null };
  }
  return healths.reduce((worst, h) =>
    SEVERITY[h.state] > SEVERITY[worst.state] ? h : worst,
  );
}

/**
 * What to display in place of a figure that cannot be trusted.
 *
 * Always an em dash — never 0, and never a blank. The app already applies this
 * discipline on the hotel KPI strip and in ChannelView's empty states; this
 * makes it available to every surface from one place.
 */
export const UNAVAILABLE = "—";

/** The value to render for a metric, given its health. */
export function displayValue(health: DataHealth, formatted: string): string {
  return health.trustworthy ? formatted : UNAVAILABLE;
}
