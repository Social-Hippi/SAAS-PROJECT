// ─────────────────────────────────────────────────────────────────────────────
// Campaign taxonomy.
//
// Two platforms, two genuinely different concepts, one column on screen.
//
//   META   campaign.objective — a real, declared goal (OUTCOME_SALES,
//          OUTCOME_LEADS, …). This is what the advertiser told Meta they wanted.
//
//   GOOGLE campaign.advertising_channel_type — SEARCH / PERFORMANCE_MAX /
//          DISPLAY / VIDEO. Google has NO objective field: a Search campaign
//          might chase bookings or brand terms depending on which conversion
//          actions it optimises for, and those live on a different resource
//          entirely. Channel type is the closest honest approximation.
//
// So each row carries a `basis` saying which of the two it came from, and the UI
// says so on hover. Presenting a Google channel as if it were a declared
// objective would be the kind of quiet mapping-by-name this taxonomy exists to
// avoid.
//
// SALES vs LEAD GENERATION. Both are kept as distinct labels — an owner running
// both wants to see which is which — but both answer true to
// isConversionOriented(), so the dashboard can group them wherever the useful
// question is "how did the campaigns meant to produce business perform?" That is
// the normalisation the brief asked for, without collapsing two objectives a
// hotel deliberately set up differently.
//
// An unrecognised or missing value becomes `unknown`, never `other`. "We have
// not classified this" and "this is a genuinely miscellaneous campaign" are
// different statements, and only the second one is a finding.
// ─────────────────────────────────────────────────────────────────────────────

export const CAMPAIGN_TYPES = [
  "lead_generation",
  "sales_conversion",
  "traffic",
  "awareness",
  "engagement",
  "other",
  "unknown",
] as const;

export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

export const CAMPAIGN_TYPE_LABEL: Record<CampaignType, string> = {
  lead_generation: "Lead generation",
  sales_conversion: "Sales / conversion",
  traffic: "Traffic",
  awareness: "Awareness",
  engagement: "Engagement",
  other: "Other",
  unknown: "Not available",
};

/**
 * Campaigns whose declared purpose is to produce business, as opposed to
 * attention. Lead generation and sales both qualify.
 */
export function isConversionOriented(type: CampaignType): boolean {
  return type === "lead_generation" || type === "sales_conversion";
}

/**
 * Meta objectives, current and legacy.
 *
 * Meta renamed every objective to the OUTCOME_* family in 2022 but still returns
 * the old names for campaigns created before then, so both are mapped. A hotel
 * account that has been running for years will contain a mix.
 */
const META_OBJECTIVES: Record<string, CampaignType> = {
  // Current (Outcome-Driven Ad Experiences)
  OUTCOME_LEADS: "lead_generation",
  OUTCOME_SALES: "sales_conversion",
  OUTCOME_TRAFFIC: "traffic",
  OUTCOME_AWARENESS: "awareness",
  OUTCOME_ENGAGEMENT: "engagement",
  OUTCOME_APP_PROMOTION: "other",
  // Legacy
  LEAD_GENERATION: "lead_generation",
  CONVERSIONS: "sales_conversion",
  PRODUCT_CATALOG_SALES: "sales_conversion",
  CATALOG_SALES: "sales_conversion",
  STORE_VISITS: "sales_conversion",
  LINK_CLICKS: "traffic",
  TRAFFIC: "traffic",
  BRAND_AWARENESS: "awareness",
  REACH: "awareness",
  AD_RECALL_LIFT: "awareness",
  VIDEO_VIEWS: "engagement",
  POST_ENGAGEMENT: "engagement",
  PAGE_LIKES: "engagement",
  EVENT_RESPONSES: "engagement",
  MESSAGES: "engagement",
  APP_INSTALLS: "other",
};

/**
 * Google advertising channel types.
 *
 * Search and Performance Max are where hotel bookings actually come from, and
 * both optimise towards conversions by default — hence sales_conversion. Display
 * and Video are bought for reach. This is an approximation of intent from
 * channel, which is exactly why the row's `basis` records that.
 */
const GOOGLE_CHANNEL_TYPES: Record<string, CampaignType> = {
  SEARCH: "sales_conversion",
  PERFORMANCE_MAX: "sales_conversion",
  SHOPPING: "sales_conversion",
  DISPLAY: "awareness",
  VIDEO: "awareness",
  DEMAND_GEN: "engagement",
  DISCOVERY: "engagement",
  LOCAL: "sales_conversion",
  LOCAL_SERVICES: "lead_generation",
  SMART: "sales_conversion",
  MULTI_CHANNEL: "other",
  HOTEL: "sales_conversion",
  TRAVEL: "sales_conversion",
};

/** Where a campaign type was derived from — surfaced to the reader on hover. */
export type CampaignTypeBasis = "objective" | "channel_type";

export type ClassifiedCampaignType = {
  type: CampaignType;
  basis: CampaignTypeBasis;
  /** The untouched platform value, for the tooltip and for debugging. */
  raw: string | null;
};

export function classifyMetaObjective(objective: string | null | undefined): ClassifiedCampaignType {
  const raw = objective?.trim() || null;
  if (!raw) return { type: "unknown", basis: "objective", raw: null };
  return {
    type: META_OBJECTIVES[raw.toUpperCase()] ?? "unknown",
    basis: "objective",
    raw,
  };
}

export function classifyGoogleChannelType(
  channelType: string | null | undefined,
): ClassifiedCampaignType {
  const raw = channelType?.trim() || null;
  if (!raw) return { type: "unknown", basis: "channel_type", raw: null };
  return {
    type: GOOGLE_CHANNEL_TYPES[raw.toUpperCase()] ?? "unknown",
    basis: "channel_type",
    raw,
  };
}

/** Hover copy explaining what the category is based on, in business language. */
export function campaignTypeTooltip(c: ClassifiedCampaignType): string {
  if (c.type === "unknown") {
    return c.raw
      ? `This platform reported "${c.raw}", which we haven't categorised yet.`
      : "This campaign's type wasn't recorded when the data was collected, so we can't categorise it. Newer data will show it.";
  }
  return c.basis === "objective"
    ? `Based on the campaign objective set in Meta ("${c.raw}").`
    : `Based on the Google campaign type ("${c.raw}"). Google doesn't publish a single campaign goal, so we categorise by campaign type.`;
}
