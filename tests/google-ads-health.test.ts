import { describe, expect, test } from "vitest";

import {
  assessGoogleAdsHealth,
  googleAdsAttributionUsable,
  GOOGLE_ADS_DIAGNOSIS_CODES as C,
} from "@/lib/google-ads-health";
import { deriveLayers, deriveOverall, type Diagnosis } from "@/lib/integration-health-types";

// Google Ads Integration Health — Linked → Flowing → Usable.
//
// The bug this guards against: Google's metrics.conversions (every conversion
// ACTION) was displayed as HotelTrack bookings, so a report could read "no
// bookings tracked" beside "Google Ads bookings: 546". Layer 3 exists to name
// that condition instead of printing a number we can't stand behind.

const NOW = new Date("2026-07-20T12:00:00.000Z");
const WINDOW = { start: new Date("2026-06-20T00:00:00.000Z"), end: new Date("2026-07-20T00:00:00.000Z") };

const connection = (over: Partial<NonNullable<Parameters<typeof assessGoogleAdsHealth>[0]["connection"]>> = {}) => ({
  status: "ACTIVE",
  customerId: "1234567890",
  requiresReconnect: false,
  lastSyncedAt: new Date("2026-07-20T05:15:00.000Z"),
  lastSyncError: null,
  ...over,
});

const assess = (over: Partial<Parameters<typeof assessGoogleAdsHealth>[0]> = {}) =>
  assessGoogleAdsHealth({
    hotelClientId: "hotel_1",
    window: WINDOW,
    now: NOW,
    connection: connection(),
    platform: { rows: 30, clicks: 1240, conversions: 546, conversionValue: 537, campaignNames: ["Summer Sale"] },
    tracked: { sessions: 40, bookings: 6, campaignKeys: ["summer sale"] },
    ...over,
  });

const codes = (d: Diagnosis[]) => d.map((x) => x.code);

describe("layer derivation (provider-neutral)", () => {
  test("a negative layer cannot exist without a diagnosis", () => {
    // The invariant is structural: states are derived FROM diagnoses.
    const layers = deriveLayers([], {});
    expect(layers).toEqual({ linked: "ok", flowing: "ok", usable: "ok" });
    expect(deriveOverall(layers)).toBe("ok");
  });

  test("a failed layer gates later layers to unknown, never failed", () => {
    const d: Diagnosis[] = [{
      code: "AUTH_TOKEN_EXPIRED", layer: "linked", severity: "blocking", confidence: "confirmed",
      summary: "x", evidence: [], capabilitiesBlocked: [], audience: "agency",
    }];
    const layers = deriveLayers(d, {});
    expect(layers.linked).toBe("failed");
    expect(layers.flowing).toBe("unknown");
    expect(layers.usable).toBe("unknown");
    expect(deriveOverall(layers)).toBe("failed");
  });

  test("informational diagnoses do not degrade a layer", () => {
    const d: Diagnosis[] = [{
      code: "DATA_NO_ACTIVITY", layer: "flowing", severity: "informational", confidence: "confirmed",
      summary: "x", evidence: [], capabilitiesBlocked: [], audience: "agency",
    }];
    expect(deriveLayers(d, {}).flowing).toBe("ok");
  });
});

describe("Layer 1 — Linked", () => {
  test("never connected", () => {
    const h = assess({ connection: null });
    expect(h.layers.linked).toBe("failed");
    expect(h.layers.flowing).toBe("unknown");
    expect(h.layers.usable).toBe("unknown");
    expect(codes(h.diagnoses)).toContain(C.AUTH_NEVER_CONNECTED);
  });

  test("token expired", () => {
    const h = assess({ connection: connection({ status: "TOKEN_EXPIRED" }) });
    expect(codes(h.diagnoses)).toContain(C.AUTH_TOKEN_EXPIRED);
    expect(h.overall).toBe("failed");
  });

  test("requiresReconnect flags re-auth even while status is ACTIVE", () => {
    const h = assess({ connection: connection({ requiresReconnect: true }) });
    expect(codes(h.diagnoses)).toContain(C.AUTH_TOKEN_EXPIRED);
  });

  test("no ad account selected", () => {
    const h = assess({ connection: connection({ customerId: "" }) });
    expect(codes(h.diagnoses)).toContain(C.CONFIG_ACCOUNT_NOT_SELECTED);
  });
});

describe("Layer 2 — Flowing", () => {
  test("never synced", () => {
    const h = assess({ connection: connection({ lastSyncedAt: null }) });
    expect(h.layers.linked).toBe("ok");
    expect(h.layers.flowing).toBe("failed");
    expect(codes(h.diagnoses)).toContain(C.SYNC_NEVER_RAN);
  });

  test("stale sync is caught (the daily cron stopped running)", () => {
    const h = assess({ connection: connection({ lastSyncedAt: new Date("2026-07-15T05:15:00.000Z") }) });
    expect(h.layers.flowing).toBe("failed");
    expect(codes(h.diagnoses)).toContain(C.SYNC_STALE);
  });

  test("a sync inside the window is not stale", () => {
    expect(assess().layers.flowing).toBe("ok");
  });

  test("last sync error", () => {
    const h = assess({ connection: connection({ lastSyncError: "USER_PERMISSION_DENIED" }) });
    expect(codes(h.diagnoses)).toContain(C.SYNC_FAILING);
  });

  test("no campaign activity is informational, not a failure", () => {
    const h = assess({
      platform: { rows: 0, clicks: 0, conversions: 0, conversionValue: 0, campaignNames: [] },
    });
    expect(h.layers.flowing).toBe("ok");
    expect(h.layers.usable).toBe("not_applicable");
    expect(codes(h.diagnoses)).toContain(C.DATA_NO_ACTIVITY);
    expect(googleAdsAttributionUsable(h)).toBe(true);
  });
});

describe("Layer 3 — Usable", () => {
  test("clicks with zero tagged sessions ⇒ untagged (the reported bug)", () => {
    const h = assess({ tracked: { sessions: 0, bookings: 0, campaignKeys: [] } });
    expect(h.layers.linked).toBe("ok");
    expect(h.layers.flowing).toBe("ok");
    expect(h.layers.usable).toBe("failed");

    const d = h.diagnoses.find((x) => x.code === C.ATTRIBUTION_PAID_CLICKS_UNTAGGED)!;
    expect(d).toBeDefined();
    // An inference must be labelled as one, and must carry its evidence.
    expect(d.confidence).toBe("inferred");
    expect(d.evidence.length).toBeGreaterThan(0);
    expect(d.capabilitiesBlocked).toContain("paid.attribution");
    expect(d.remedy?.copyText).toContain("utm_source=google");
    expect(googleAdsAttributionUsable(h)).toBe(false);
  });

  test("low click volume yields unknown, not an accusation", () => {
    const h = assess({
      platform: { rows: 3, clicks: 12, conversions: 2, conversionValue: 2, campaignNames: ["Small"] },
      tracked: { sessions: 0, bookings: 0, campaignKeys: [] },
    });
    expect(h.layers.usable).toBe("unknown");
    expect(codes(h.diagnoses)).not.toContain(C.ATTRIBUTION_PAID_CLICKS_UNTAGGED);
    expect(googleAdsAttributionUsable(h)).toBe(true);
  });

  test("no clicks ⇒ nothing to attribute", () => {
    const h = assess({
      platform: { rows: 30, clicks: 0, conversions: 0, conversionValue: 0, campaignNames: ["Paused"] },
      tracked: { sessions: 0, bookings: 0, campaignKeys: [] },
    });
    expect(h.layers.usable).toBe("not_applicable");
    expect(h.overall).toBe("ok");
  });

  test("properly tagged account is healthy", () => {
    const h = assess();
    expect(h.overall).toBe("ok");
    expect(h.diagnoses).toHaveLength(0);
    expect(googleAdsAttributionUsable(h)).toBe(true);
  });

  test("campaign names that don't line up degrade campaign-level only", () => {
    const h = assess({ tracked: { sessions: 40, bookings: 6, campaignKeys: ["21451234"] } });
    expect(h.layers.usable).toBe("degraded");
    const d = h.diagnoses.find((x) => x.code === C.ATTRIBUTION_CAMPAIGN_KEY_UNJOINABLE)!;
    expect(d.capabilitiesBlocked).toEqual(["paid.campaign_attribution"]);
    // Channel-level attribution still works, so bookings/revenue stay visible.
    expect(googleAdsAttributionUsable(h)).toBe(true);
  });
});

describe("health record shape", () => {
  test("diagnoses are ordered blocking first and the window is echoed", () => {
    const h = assess({
      connection: connection({ lastSyncedAt: null }),
    });
    expect(h.integrationId).toBe("google_ads");
    expect(h.window).toEqual({ start: "2026-06-20", end: "2026-07-20" });
    expect(h.diagnoses[0].severity).toBe("blocking");
    expect(h.observedAt).toBe(NOW.toISOString());
  });
});
