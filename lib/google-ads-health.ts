// Google Ads Integration Health — the first (and for now ONLY) producer of the
// provider-neutral health model in lib/integration-health-types.ts.
//
// PURE: no prisma, no "server-only". The caller (lib/channel-view.ts) has already
// loaded everything this needs, so the rules stay unit-testable in isolation —
// the same convention as lib/funnel.ts, lib/coupon.ts and lib/source-classifier.ts.
//
// SCOPE (deliberate): Google Ads only. No registry, no probe interface, no shared
// infrastructure — those get designed once a second integration has real Layer-3
// checks to generalise from. Everything Google-specific lives HERE; everything
// reusable lives in integration-health-types.ts.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// A Google Ads connection can be authenticated, syncing on schedule, writing rows
// — and still be unable to answer "what revenue did paid search drive?". That
// happens when the ad account uses auto-tagging only (gclid), because HotelTrack
// attributes by UTM (lib/source-classifier.ts): a gclid-only landing carries no
// utm_source, so normalizeSource() returns "direct" and the booking is filed
// under Direct, never google_ads.
//
// Reporting that as "0 bookings" states a measured zero we did not measure. This
// module produces the diagnosis instead.

import {
  buildHealth,
  type Diagnosis,
  type HealthLayer,
  type IntegrationHealth,
  type LayerHint,
} from "@/lib/integration-health-types";

export const GOOGLE_ADS_INTEGRATION_ID = "google_ads";
const LABEL = "Google Ads";

// ── Thresholds ───────────────────────────────────────────────────────────────

/** The sync is daily (vercel.json `15 5 * * *`), so >48h means ≥2 missed runs. */
const SYNC_STALE_HOURS = 48;

/**
 * Minimum Google-reported clicks before "no tagged sessions" is treated as
 * evidence of missing tagging rather than a small sample. Below this we report
 * `unknown` and say nothing — an inference we cannot stand behind is worse than
 * silence.
 */
const MIN_CLICKS_FOR_TAGGING_INFERENCE = 50;

/** The account-level Final URL suffix that satisfies lib/source-classifier.ts. */
export const GOOGLE_ADS_UTM_SUFFIX =
  "utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={creative}&utm_term={keyword}";

const HOUR_MS = 3_600_000;

// ── Input ────────────────────────────────────────────────────────────────────

export type GoogleAdsHealthInput = {
  hotelClientId: string;
  window: { start: Date; end: Date };
  now?: Date;
  /** Null when the hotel has never connected Google Ads. */
  connection: {
    status: string; // GoogleAdsStatus
    customerId: string; // "" until an account is picked
    requiresReconnect: boolean;
    lastSyncedAt: Date | null;
    lastSyncError: string | null;
  } | null;
  /** Google-REPORTED figures for the window (GoogleAdsCampaignSnapshot). */
  platform: {
    rows: number;
    clicks: number;
    conversions: number;
    conversionValue: number;
    /** Distinct campaign names seen in the window. */
    campaignNames: string[];
  };
  /** HotelTrack-TRACKED figures for the window (TrackingEvent / Session). */
  tracked: {
    /** Sessions classified google_ads — the tagging signal. */
    sessions: number;
    bookings: number;
    /** Campaign names on tracked google_ads bookings (lower-cased). */
    campaignKeys: string[];
  };
};

// ── Diagnosis codes (Google Ads only — reused codes stay provider-neutral) ───

export const GOOGLE_ADS_DIAGNOSIS_CODES = {
  AUTH_NEVER_CONNECTED: "AUTH_NEVER_CONNECTED",
  AUTH_TOKEN_EXPIRED: "AUTH_TOKEN_EXPIRED",
  AUTH_REVOKED: "AUTH_REVOKED",
  CONFIG_ACCOUNT_NOT_SELECTED: "CONFIG_ACCOUNT_NOT_SELECTED",
  SYNC_NEVER_RAN: "SYNC_NEVER_RAN",
  SYNC_STALE: "SYNC_STALE",
  SYNC_FAILING: "SYNC_FAILING",
  DATA_NO_ACTIVITY: "DATA_NO_ACTIVITY",
  ATTRIBUTION_PAID_CLICKS_UNTAGGED: "ATTRIBUTION_PAID_CLICKS_UNTAGGED",
  ATTRIBUTION_CAMPAIGN_KEY_UNJOINABLE: "ATTRIBUTION_CAMPAIGN_KEY_UNJOINABLE",
} as const;

const C = GOOGLE_ADS_DIAGNOSIS_CODES;

/** Capability keys this integration can block. Informal strings for now. */
export const GOOGLE_ADS_CAPABILITIES = {
  spend: "paid.spend",
  attribution: "paid.attribution",
  campaignAttribution: "paid.campaign_attribution",
} as const;

const integrationsHref = (hotelClientId: string) => `/agency/hotel/${hotelClientId}/integrations`;

const n = (v: number) => v.toLocaleString("en-IN");

// ── Probe ────────────────────────────────────────────────────────────────────

/**
 * Assesses Linked → Flowing → Usable for one hotel's Google Ads integration.
 *
 * Layer states are DERIVED from the diagnoses by buildHealth(), so a negative
 * state can never exist without its explanation. Hints only ever assert the
 * non-negative states (unknown / not_applicable), which claim nothing.
 */
export function assessGoogleAdsHealth(input: GoogleAdsHealthInput): IntegrationHealth {
  const now = input.now ?? new Date();
  const { connection, platform, tracked, hotelClientId } = input;
  const diagnoses: Diagnosis[] = [];
  const hints: Partial<Record<HealthLayer, LayerHint>> = {};

  // ── LAYER 1 — LINKED ───────────────────────────────────────────────────────
  if (!connection) {
    diagnoses.push({
      code: C.AUTH_NEVER_CONNECTED,
      layer: "linked",
      severity: "blocking",
      confidence: "confirmed",
      summary: "Google Ads has not been connected for this hotel.",
      evidence: [{ label: "Connection", value: "None" }],
      capabilitiesBlocked: [
        GOOGLE_ADS_CAPABILITIES.spend,
        GOOGLE_ADS_CAPABILITIES.attribution,
        GOOGLE_ADS_CAPABILITIES.campaignAttribution,
      ],
      audience: "agency",
      remedy: {
        instruction: "Connect this hotel's Google Ads account on its Integrations page.",
        href: integrationsHref(hotelClientId),
      },
    });
    return finish(diagnoses, hints, input, now);
  }

  const status = connection.status;
  if (status === "REVOKED") {
    diagnoses.push({
      code: C.AUTH_REVOKED,
      layer: "linked",
      severity: "blocking",
      confidence: "confirmed",
      summary: "Access to the Google Ads account was revoked.",
      evidence: [{ label: "Connection status", value: status }],
      capabilitiesBlocked: [
        GOOGLE_ADS_CAPABILITIES.spend,
        GOOGLE_ADS_CAPABILITIES.attribution,
        GOOGLE_ADS_CAPABILITIES.campaignAttribution,
      ],
      audience: "agency",
      remedy: {
        instruction: "Reconnect Google Ads to restore access.",
        href: integrationsHref(hotelClientId),
      },
    });
  } else if (status === "TOKEN_EXPIRED" || connection.requiresReconnect) {
    diagnoses.push({
      code: C.AUTH_TOKEN_EXPIRED,
      layer: "linked",
      severity: "blocking",
      confidence: "confirmed",
      summary: "The Google Ads connection needs to be re-authorised.",
      evidence: [
        { label: "Connection status", value: status },
        { label: "Reconnect required", value: connection.requiresReconnect ? "Yes" : "No" },
      ],
      capabilitiesBlocked: [
        GOOGLE_ADS_CAPABILITIES.spend,
        GOOGLE_ADS_CAPABILITIES.attribution,
        GOOGLE_ADS_CAPABILITIES.campaignAttribution,
      ],
      audience: "agency",
      remedy: {
        instruction: "Reconnect Google Ads on the Integrations page.",
        href: integrationsHref(hotelClientId),
      },
    });
  } else if (connection.customerId === "") {
    diagnoses.push({
      code: C.CONFIG_ACCOUNT_NOT_SELECTED,
      layer: "linked",
      severity: "blocking",
      confidence: "confirmed",
      summary: "Google Ads is connected, but no ad account has been selected yet.",
      evidence: [{ label: "Selected account", value: "None" }],
      capabilitiesBlocked: [
        GOOGLE_ADS_CAPABILITIES.spend,
        GOOGLE_ADS_CAPABILITIES.attribution,
        GOOGLE_ADS_CAPABILITIES.campaignAttribution,
      ],
      audience: "agency",
      remedy: {
        instruction: "Choose which Google Ads account belongs to this hotel.",
        href: integrationsHref(hotelClientId),
      },
    });
  }

  if (diagnoses.some((d) => d.layer === "linked" && d.severity === "blocking")) {
    return finish(diagnoses, hints, input, now);
  }

  // ── LAYER 2 — FLOWING ──────────────────────────────────────────────────────
  if (!connection.lastSyncedAt) {
    diagnoses.push({
      code: C.SYNC_NEVER_RAN,
      layer: "flowing",
      severity: "blocking",
      confidence: "confirmed",
      summary: "Google Ads data has never synced for this hotel.",
      evidence: [{ label: "Last successful sync", value: "Never" }],
      capabilitiesBlocked: [
        GOOGLE_ADS_CAPABILITIES.spend,
        GOOGLE_ADS_CAPABILITIES.attribution,
        GOOGLE_ADS_CAPABILITIES.campaignAttribution,
      ],
      audience: "platform",
      remedy: { instruction: "The first sync runs shortly after an account is selected." },
    });
  } else {
    const ageHours = (now.getTime() - connection.lastSyncedAt.getTime()) / HOUR_MS;
    if (ageHours > SYNC_STALE_HOURS) {
      diagnoses.push({
        code: C.SYNC_STALE,
        layer: "flowing",
        severity: "blocking",
        confidence: "confirmed",
        summary: "Google Ads data has stopped updating.",
        evidence: [
          { label: "Last successful sync", value: connection.lastSyncedAt.toISOString().slice(0, 10) },
          { label: "Age", value: `${Math.floor(ageHours)}h (expected under ${SYNC_STALE_HOURS}h)` },
        ],
        capabilitiesBlocked: [
          GOOGLE_ADS_CAPABILITIES.spend,
          GOOGLE_ADS_CAPABILITIES.attribution,
          GOOGLE_ADS_CAPABILITIES.campaignAttribution,
        ],
        audience: "platform",
        remedy: {
          instruction:
            "The scheduled Google Ads sync has not completed recently — figures below may be out of date.",
        },
      });
    }
    if (connection.lastSyncError) {
      diagnoses.push({
        code: C.SYNC_FAILING,
        layer: "flowing",
        severity: "blocking",
        confidence: "confirmed",
        summary: "The last Google Ads sync failed.",
        evidence: [{ label: "Error", value: connection.lastSyncError.slice(0, 200) }],
        capabilitiesBlocked: [
          GOOGLE_ADS_CAPABILITIES.spend,
          GOOGLE_ADS_CAPABILITIES.attribution,
          GOOGLE_ADS_CAPABILITIES.campaignAttribution,
        ],
        audience: "platform",
        remedy: { instruction: "This is being retried automatically on the next scheduled sync." },
      });
    }
  }

  if (diagnoses.some((d) => d.layer === "flowing" && d.severity === "blocking")) {
    return finish(diagnoses, hints, input, now);
  }

  // Connected and syncing, but the account simply had no activity in the window.
  // Informational: nothing is broken, so `flowing` stays ok.
  if (platform.rows === 0) {
    diagnoses.push({
      code: C.DATA_NO_ACTIVITY,
      layer: "flowing",
      severity: "informational",
      confidence: "confirmed",
      summary: "No Google Ads campaign activity in this period.",
      evidence: [{ label: "Campaign-days synced", value: "0" }],
      capabilitiesBlocked: [],
      audience: "agency",
    });
    hints.usable = "not_applicable";
    return finish(diagnoses, hints, input, now);
  }

  // ── LAYER 3 — USABLE ───────────────────────────────────────────────────────
  // Can these figures answer "what bookings/revenue did Google Ads drive?".
  //
  // HotelTrack attributes by UTM. Auto-tagging (gclid) alone is invisible to
  // classifySourceType, so paid clicks land in Direct. The signal is Google
  // reporting clicks while we see no session tagged google_ads.
  if (platform.clicks === 0) {
    // No paid traffic in the window — nothing to attribute, not a fault.
    hints.usable = "not_applicable";
  } else if (tracked.sessions === 0) {
    if (platform.clicks >= MIN_CLICKS_FOR_TAGGING_INFERENCE) {
      diagnoses.push({
        code: C.ATTRIBUTION_PAID_CLICKS_UNTAGGED,
        layer: "usable",
        severity: "blocking",
        confidence: "inferred",
        summary: "Bookings from Google Ads cannot be attributed.",
        evidence: [
          { label: "Clicks reported by Google", value: n(platform.clicks) },
          { label: "Conversions reported by Google", value: n(Math.round(platform.conversions)) },
          { label: "Visits tagged as Google Ads", value: "0" },
        ],
        capabilitiesBlocked: [
          GOOGLE_ADS_CAPABILITIES.attribution,
          GOOGLE_ADS_CAPABILITIES.campaignAttribution,
        ],
        audience: "agency",
        remedy: {
          instruction:
            "This account's ads are not adding campaign tags to landing-page URLs, so visitors " +
            "arrive indistinguishable from direct traffic — their bookings are currently counted " +
            "under Direct. Add a Final URL suffix in Google Ads → Settings (keep auto-tagging on).",
          href: integrationsHref(hotelClientId),
          copyText: GOOGLE_ADS_UTM_SUFFIX,
        },
      });
    } else {
      // Too little traffic to stand behind an inference. Say nothing.
      hints.usable = "unknown";
    }
  } else if (tracked.bookings > 0 && platform.campaignNames.length > 0) {
    // Tagged and attributing, but campaign names may not line up (e.g. a suffix
    // using {campaignid} yields numeric ids that never match campaign NAMES).
    const platformKeys = new Set(platform.campaignNames.map((c) => c.trim().toLowerCase()).filter(Boolean));
    const matched = tracked.campaignKeys.filter((k) => platformKeys.has(k));
    if (matched.length === 0) {
      diagnoses.push({
        code: C.ATTRIBUTION_CAMPAIGN_KEY_UNJOINABLE,
        layer: "usable",
        severity: "degrading",
        confidence: "inferred",
        summary: "Bookings are attributed to Google Ads, but not to individual campaigns.",
        evidence: [
          { label: "Campaigns reported by Google", value: n(platformKeys.size) },
          { label: "Tracked bookings matched to a campaign", value: "0" },
        ],
        capabilitiesBlocked: [GOOGLE_ADS_CAPABILITIES.campaignAttribution],
        audience: "agency",
        remedy: {
          instruction:
            "The utm_campaign value on landing URLs does not match any Google campaign name — " +
            "channel totals are correct, but the per-campaign table cannot be filled in.",
          href: integrationsHref(hotelClientId),
        },
      });
    }
  }

  return finish(diagnoses, hints, input, now);
}

function finish(
  diagnoses: Diagnosis[],
  hints: Partial<Record<HealthLayer, LayerHint>>,
  input: GoogleAdsHealthInput,
  now: Date,
): IntegrationHealth {
  return buildHealth({
    integrationId: GOOGLE_ADS_INTEGRATION_ID,
    label: LABEL,
    diagnoses,
    hints,
    window: input.window,
    now,
  });
}

/**
 * Convenience for consumers: is channel-level booking/revenue attribution
 * trustworthy right now? False means the UI must show the diagnosis instead of
 * a number — never a bare zero.
 */
export function googleAdsAttributionUsable(health: IntegrationHealth | undefined): boolean {
  if (!health) return true;
  return !health.diagnoses.some(
    (d) =>
      d.severity === "blocking" &&
      d.capabilitiesBlocked.includes(GOOGLE_ADS_CAPABILITIES.attribution),
  );
}
