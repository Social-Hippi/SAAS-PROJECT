import "server-only";

import { prisma } from "@/lib/prisma";
import { encryptToken } from "@/lib/encryption";
import { agencyScopedFor } from "@/lib/tenant-scope";

// ─────────────────────────────────────────────────────────────────────────────
// Holding Booking Push bodies we could not turn into bookings.
//
// A provider's parser is written from its real payload, and the first real
// payload is also the first real booking. Answering it with a 4xx and dropping
// the body loses both — the booking, and the sample needed to stop losing the
// next one — and providers rarely retry a 4xx. So an AUTHENTICATED body that
// fails mapping is encrypted and held, to be replayed once the parser exists.
//
// Separately, every authenticated push stamps the connection with when it
// arrived and what happened to it. Vercel keeps about an hour of logs, so
// without this the question "did the provider reach us at all?" stops having an
// answer an hour after they try — which is exactly how the first Simplotel test
// pushes went unexplained.
// ─────────────────────────────────────────────────────────────────────────────

export type PushOutcome =
  | "accepted"
  | "partial"
  | "unmapped_payload"
  | "rejected"
  | "no_events"
  | "bad_content_type"
  | "malformed_json"
  | "body_too_large";

/** Outcomes whose body is held for replay. Every other outcome is only stamped. */
export const HELD_OUTCOMES: ReadonlySet<PushOutcome> = new Set([
  "unmapped_payload",
  "rejected",
  "partial",
]);

type Tenant = { id: string; agencyId: string; hotelClientId: string };

/**
 * Stamps the connection with this push. Never throws: a failed health stamp must
 * not turn an accepted booking into an error the provider retries.
 */
export async function stampPush(connection: Tenant, outcome: PushOutcome): Promise<void> {
  try {
    await agencyScopedFor(connection.agencyId, prisma.bookingConnection).update({
      where: { id: connection.id },
      data: { lastPushAt: new Date(), lastPushOutcome: outcome },
    });
  } catch {
    // Health metadata only. The push itself has already been handled.
  }
}

/**
 * Encrypts and holds one body, and stamps the connection.
 *
 * THROWS if the body cannot be held. That is deliberate: the caller must then
 * answer 5xx, so a provider that retries sends it again. Answering as if it had
 * been kept would lose a booking silently — the one thing this exists to stop.
 */
export async function holdPush(
  connection: Tenant,
  provider: string,
  outcome: PushOutcome,
  reason: string | null,
  rawBody: string,
): Promise<void> {
  await agencyScopedFor(connection.agencyId, prisma.bookingPushCapture).create({
    data: {
      agencyId: connection.agencyId,
      hotelClientId: connection.hotelClientId,
      connectionId: connection.id,
      provider,
      outcome,
      // The parser's or ingester's reason only — never anything from the body.
      reason: reason ? reason.slice(0, 500) : null,
      bodyEncrypted: encryptToken(rawBody),
      bodyBytes: Buffer.byteLength(rawBody, "utf8"),
    },
  });
  await stampPush(connection, outcome);
}

/** Held bodies not yet replayed, for the agency card. Agency-scoped. */
export async function countHeldPushes(agencyId: string, connectionId: string): Promise<number> {
  return agencyScopedFor(agencyId, prisma.bookingPushCapture).count({
    where: { connectionId, replayedAt: null },
  });
}
