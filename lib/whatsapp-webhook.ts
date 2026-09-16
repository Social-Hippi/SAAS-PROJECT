// ─────────────────────────────────────────────────────────────────────────────
// Meta WhatsApp Cloud API — webhook payload reader.
//
// PURE AND DATABASE-FREE, so the parsing can be exercised exhaustively without a
// database or a live Meta connection. The route handles transport, signature and
// persistence; this file only decides what a payload MEANS.
//
// WHAT WE TAKE, AND WHY SO LITTLE. Exactly two facts per conversation: who
// messaged (as a hash, computed later) and which ad sent them. Message bodies,
// profile names and media are deliberately not read — the product claim is
// attribution, not messaging, and data we never hold cannot leak.
//
// THE REFERRAL ARRIVES ONCE. Meta attaches `referral` to the FIRST inbound
// message of a conversation that began from a click-to-WhatsApp ad. Later
// messages in the same conversation carry none. So a caller must treat a missing
// referral as "no new evidence", never as "this conversation had no ad" — the
// difference decides whether a second message erases the attribution.
//
// DEFENSIVE BY DEFAULT. This shape comes from Meta's documented webhook, and
// Meta adds fields without warning. Every field is read optionally, unknown
// shapes are skipped rather than guessed at, and a payload that yields nothing
// recognisable returns an empty list — never a throw, because a 500 makes Meta
// retry a payload that will never parse.
// ─────────────────────────────────────────────────────────────────────────────

/** One inbound message, reduced to what attribution needs. */
export type InboundMessage = {
  /** Meta's id for the number that RECEIVED this — the tenant routing key. */
  phoneNumberId: string;
  wabaId: string | null;
  displayPhoneNumber: string | null;
  /** The sender's number as WhatsApp reports it: digits, country code, no "+". */
  fromPhone: string;
  /** Provider message id, for idempotency. */
  messageId: string;
  sentAt: Date;
  /** Present only on the first message of an ad-originated conversation. */
  referral: Referral | null;
};

export type Referral = {
  ctwaClid: string | null;
  sourceId: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
  headline: string | null;
};

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/**
 * Meta sends timestamps as SECONDS, in a string. Multiplying a millisecond value
 * by 1000 would place the message in the year 57000 and quietly poison every
 * "first message" comparison, so an implausible result is rejected rather than
 * stored.
 */
function parseTimestamp(v: unknown, now: Date): Date {
  const n = Number(str(v) ?? "");
  if (!Number.isFinite(n) || n <= 0) return now;
  const d = new Date(n * 1000);
  const year = d.getUTCFullYear();
  return year >= 2000 && year <= 2200 ? d : now;
}

function readReferral(raw: unknown): Referral | null {
  const r = obj(raw);
  const referral: Referral = {
    ctwaClid: str(r.ctwa_clid),
    sourceId: str(r.source_id),
    sourceType: str(r.source_type),
    sourceUrl: str(r.source_url),
    headline: str(r.headline),
  };
  // A referral with no identifying field is not evidence of anything. Storing it
  // would mark the conversation "from an ad" while naming no ad.
  const identifies = referral.ctwaClid ?? referral.sourceId;
  return identifies ? referral : null;
}

/**
 * Every inbound message in one webhook delivery.
 *
 * Meta batches: one POST can carry several entries, each with several changes,
 * each with several messages — and mixes in statuses (delivered/read) and
 * errors, which are not inbound messages and are skipped.
 */
export function parseInboundMessages(payload: unknown, now = new Date()): InboundMessage[] {
  const root = obj(payload);
  // Anything other than a WhatsApp account event is not ours to read.
  if (str(root.object) !== "whatsapp_business_account") return [];

  const out: InboundMessage[] = [];

  for (const entryRaw of arr(root.entry)) {
    const entry = obj(entryRaw);
    const wabaId = str(entry.id);

    for (const changeRaw of arr(entry.changes)) {
      const change = obj(changeRaw);
      // "messages" is the only field carrying inbound traffic. Others exist
      // (account_update, phone_number_quality_update) and are not errors.
      if (str(change.field) !== "messages") continue;

      const value = obj(change.value);
      const metadata = obj(value.metadata);
      const phoneNumberId = str(metadata.phone_number_id);
      // Without it there is no way to know WHICH hotel was messaged, and a
      // message we cannot attribute to a tenant must never be stored.
      if (!phoneNumberId) continue;

      const displayPhoneNumber = str(metadata.display_phone_number);

      for (const messageRaw of arr(value.messages)) {
        const message = obj(messageRaw);
        const fromPhone = str(message.from);
        const messageId = str(message.id);
        if (!fromPhone || !messageId) continue;

        out.push({
          phoneNumberId,
          wabaId,
          displayPhoneNumber,
          fromPhone,
          messageId,
          sentAt: parseTimestamp(message.timestamp, now),
          referral: readReferral(message.referral),
        });
      }
    }
  }

  return out;
}

/**
 * The GET handshake Meta performs when a webhook URL is saved.
 *
 * Returns the challenge to echo, or null to refuse. The token is compared with
 * the configured one; a mismatch answers exactly as a missing token does, so a
 * caller learns nothing about which half they got wrong.
 */
export function verifySubscription(
  params: URLSearchParams,
  expectedToken: string | undefined,
): string | null {
  if (!expectedToken) return null;
  if (params.get("hub.mode") !== "subscribe") return null;
  if (params.get("hub.verify_token") !== expectedToken) return null;
  return params.get("hub.challenge");
}
