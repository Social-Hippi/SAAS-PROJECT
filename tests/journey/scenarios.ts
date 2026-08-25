import { buildUtmLink } from "@/lib/utm";
import type { SourceType } from "@/lib/source-classifier";

// ─────────────────────────────────────────────────────────────────────────────
// GENERAL customer-journey scenarios (Track C).
//
// A source-agnostic table describing how a visitor ARRIVES and what HotelTrack
// should conclude. The runners in tests/customer-journey*.test.ts iterate this
// list; adding Email, Referral, OTA or any future channel means appending one
// entry here — no runner changes.
//
// NOTHING influencer-specific lives in the harness. Influencer is one row in the
// table, exactly like Google Ads or Direct.
//
// `expected` records what the REPOSITORY ACTUALLY DOES today, not what we might
// wish it did. Where current behaviour is a known limitation (organic search
// being indistinguishable from direct), that is encoded and called out in
// `note`, so the harness documents reality rather than hiding it.
// ─────────────────────────────────────────────────────────────────────────────

/** A synthetic ContentPiece id standing in for a real influencer campaign. */
export const TEST_CONTENT_PIECE_ID = "ck9testinfluencercontent01";

/** The real production URL builder — not a hand-written UTM string. */
export const INFLUENCER_LANDING_URL = buildUtmLink({
  destinationUrl: "https://hotel.example/rooms",
  source: "instagram", // ContentPiece.platform
  medium: "influencer", // ContentPiece.contentType
  title: "TEST_INFLUENCER_CAMPAIGN",
  contentPieceId: TEST_CONTENT_PIECE_ID,
  agencyId: "TEST_AGENCY_ID",
});

export type JourneyScenario = {
  /** Stable key used in test names and in the DB-backed runner. */
  key: string;
  label: string;
  /** The landing URL path+query exactly as the ad/link would deliver it. */
  landing: string;
  /** Simulated document.referrer, when the channel implies one. */
  referrer?: string;
  expected: {
    sourceType: SourceType;
    utmSource: string | null;
    utmMedium: string | null;
    /** Click identifiers the payload must carry (absent keys must be absent). */
    clickIds: Partial<Record<"gclid" | "gbraid" | "wbraid" | "fbclid", string>>;
  };
  /** Known limitation or behavioural note this scenario documents. */
  note?: string;
};

export const SYNTHETIC = {
  gclid: "TEST_GCLID_JOURNEY_1",
  fbclid: "TEST_FBCLID_JOURNEY_1",
} as const;

export const JOURNEY_SCENARIOS: JourneyScenario[] = [
  {
    key: "google_ads",
    label: "TEST 1 — Google Ads (auto-tagged)",
    // Auto-tagging is Google's DEFAULT and sends no UTM parameters at all.
    landing: `/?gclid=${SYNTHETIC.gclid}`,
    referrer: "https://www.google.com/",
    expected: {
      sourceType: "google_ads",
      utmSource: null,
      utmMedium: null,
      clickIds: { gclid: SYNTHETIC.gclid },
    },
    note: "Classified google_ads by the click id alone — no UTM required.",
  },
  {
    key: "google_ads_tagged",
    label: "TEST 1b — Google Ads (manually tagged)",
    landing: `/?gclid=${SYNTHETIC.gclid}&utm_source=google&utm_medium=cpc&utm_campaign=brand`,
    referrer: "https://www.google.com/",
    expected: {
      sourceType: "google_ads",
      utmSource: "google",
      utmMedium: "cpc",
      clickIds: { gclid: SYNTHETIC.gclid },
    },
  },
  {
    key: "meta_ads",
    label: "TEST 2 — Meta Ads (fbclid + repo's paid convention)",
    // The repository's Meta convention: campaign attribution joins on
    // utm_campaign = the Meta campaign NAME (see scripts/fix-ad-url-tags.ts).
    landing: `/?fbclid=${SYNTHETIC.fbclid}&utm_source=facebook&utm_medium=paid_social&utm_campaign=Summer%20Sale`,
    referrer: "https://l.facebook.com/",
    expected: {
      sourceType: "meta_ads",
      utmSource: "facebook",
      utmMedium: "paid_social",
      clickIds: { fbclid: SYNTHETIC.fbclid },
    },
    note: "meta_ads comes from the PAID UTM medium, not from fbclid — fbclid is Meta-origin evidence only.",
  },
  {
    key: "meta_organic",
    label: "TEST 2b — Meta organic (fbclid only, no paid UTM)",
    landing: `/?fbclid=${SYNTHETIC.fbclid}`,
    referrer: "https://l.instagram.com/",
    expected: {
      sourceType: "direct",
      utmSource: null,
      utmMedium: null,
      clickIds: { fbclid: SYNTHETIC.fbclid },
    },
    note: "LIMITATION: fbclid alone is deliberately NOT promoted to meta_ads, and referrer is not classified — so this lands in `direct`.",
  },
  {
    key: "organic_search",
    label: "TEST 3 — Organic search",
    landing: "/",
    referrer: "https://www.google.com/search?q=beach+resort",
    expected: {
      sourceType: "direct",
      utmSource: null,
      utmMedium: null,
      clickIds: {},
    },
    note: "LIMITATION: classifySourceType never reads the referrer, so organic search is indistinguishable from direct today.",
  },
  {
    key: "direct",
    label: "TEST 4 — Direct",
    landing: "/",
    expected: { sourceType: "direct", utmSource: null, utmMedium: null, clickIds: {} },
  },
  {
    key: "influencer",
    label: "TEST 5 — Influencer (URL generated by buildUtmLink)",
    landing: INFLUENCER_LANDING_URL.replace("https://hotel.example", ""),
    referrer: "https://l.instagram.com/",
    expected: {
      sourceType: "influencer",
      utmSource: "instagram",
      utmMedium: "influencer",
      clickIds: {},
    },
    note: "One source case inside the general framework — the harness has no influencer-specific logic.",
  },
];

/** Every click-identifier key the harness knows about. */
export const CLICK_ID_KEYS = ["gclid", "gbraid", "wbraid", "fbclid"] as const;
