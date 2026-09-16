// ─────────────────────────────────────────────────────────────────────────────
// Kraya lead webhook — payload reader.
//
// PURE AND DATABASE-FREE, so every shape can be exercised without a connection.
//
// Kraya fires this on EVERY lead upsert — creates and stage changes alike — so
// most payloads are enquiries, not bookings. The reader's job is only to say
// what arrived; deciding whether a stage means "booked" belongs to the ingest,
// because that answer is per-hotel configuration.
//
// CUSTOM ATTRIBUTES ARRIVE AS TOP-LEVEL KEYS, not nested. That is how the
// click-to-WhatsApp referral reaches us: the hotel added wa_ref_* attributes in
// Kraya, and they appear beside `name` and `phone`. Anything else the hotel adds
// later flows through with no code change — which is why the referral is read by
// NAME rather than by position.
//
// STAGE NAMES ARE NEVER TRANSLATED. "Sold out for CBH" is stored and displayed
// exactly as Kraya spells it: it is the hotel's own vocabulary, it differs per
// pipeline, and the reservations team renames it. A mapping table here would
// need a deploy every time someone edited a dropdown.
// ─────────────────────────────────────────────────────────────────────────────

export type KrayaReferral = {
  ctwaClid: string | null;
  sourceId: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
  headline: string | null;
};

export type KrayaLead = {
  /** Kraya's own id. THE idempotency key — a lead is upserted on every change. */
  leadId: string;
  phone: string;
  email: string | null;
  /** Verbatim. Never mapped. */
  stage: string | null;
  pipeline: string | null;
  eventType: "create" | "update" | null;
  /** Null when the lead did not come from a click-to-WhatsApp ad. */
  referral: KrayaReferral | null;
};

const str = (v: unknown): string | null => {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

/**
 * The referral attribute names, as the hotel configured them in Kraya.
 *
 * `wa_ref_source_id` is the one that matters most: ctwa_clid identifies the
 * CLICK, but only source_id names the AD, and the ad is what joins to campaign
 * spend. A lead carrying a click id and no ad id is still recorded — it proves
 * the conversation came from an ad — but it cannot be credited to a campaign.
 */
const REF_KEYS = {
  ctwaClid: "wa_ref_ctwa_clid",
  sourceId: "wa_ref_source_id",
  sourceType: "wa_ref_source_type",
  sourceUrl: "wa_ref_source_url",
  headline: "wa_ref_headline",
} as const;

function readReferral(body: Record<string, unknown>): KrayaReferral | null {
  const referral: KrayaReferral = {
    ctwaClid: str(body[REF_KEYS.ctwaClid]),
    sourceId: str(body[REF_KEYS.sourceId]),
    sourceType: str(body[REF_KEYS.sourceType]),
    sourceUrl: str(body[REF_KEYS.sourceUrl]),
    headline: str(body[REF_KEYS.headline]),
  };
  // Neither identifier present means this lead did not arrive from an ad. A
  // referral carrying only a headline would claim an origin it cannot name.
  return referral.ctwaClid ?? referral.sourceId ? referral : null;
}

/**
 * Read one webhook body. Returns null when it is not a usable lead.
 *
 * Never throws: a 500 makes Kraya retry a payload that will never parse, and it
 * only retries twice before dropping it for good.
 */
export function parseKrayaLead(payload: unknown): KrayaLead | null {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;

  const leadId = str(body.lead_id);
  const phone = str(body.phone);
  // Without either, the lead can be neither identified nor matched to a booking.
  if (!leadId || !phone) return null;

  const rawEvent = str(body.event_type);
  const eventType = rawEvent === "create" || rawEvent === "update" ? rawEvent : null;

  return {
    leadId,
    phone,
    email: str(body.email),
    stage: str(body.stage),
    pipeline: str(body.pipeline),
    eventType,
    referral: readReferral(body),
  };
}

/**
 * Whether this lead's stage is the one the hotel nominated as "booked".
 *
 * Compared case-insensitively on trimmed text, because the name is typed into a
 * settings field by a human and Kraya's own spelling drifts ("Interested -
 * Follow-Up" on one pipeline, "Interested - Follow up" on another).
 *
 * An unset `confirmedStageName` means NO booking is ever created. That is the
 * safe failure: leads still flow, and nothing invents a booking from a guess.
 */
export function isConfirmedStage(
  stage: string | null,
  confirmedStageName: string | null | undefined,
): boolean {
  if (!stage || !confirmedStageName) return false;
  return stage.trim().toLowerCase() === confirmedStageName.trim().toLowerCase();
}
