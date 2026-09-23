import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptToken } from "@/lib/encryption";
import { agencyScopedFor } from "@/lib/tenant-scope";
import { getBookingProvider } from "@/lib/booking-provider";
import { ingestBookingEvents } from "@/lib/booking-ingest";
import "@/lib/booking-providers/simplotel";

// ─────────────────────────────────────────────────────────────────────────────
// Recording the pushes that were held while a provider had no field mapping.
//
// This is the half that makes holding worth anything: the receiver kept every
// authenticated body it could not map, and once the mapping exists those bodies
// become the bookings they always were.
//
// SAFE TO RUN TWICE, for two independent reasons. A capture is marked
// `replayedAt` once it has been recorded and is skipped afterwards; and even if
// that mark were lost, ingestion is keyed on the provider's own reservation id,
// so the same body updates the same booking rather than adding a second one.
//
// A BODY THAT STILL CANNOT BE MAPPED IS LEFT HELD. Its reason is rewritten to
// whatever the parser says now — an unknown booking status names the value —
// so a failed replay explains itself and can be retried after the mapping is
// extended. Nothing is deleted, ever, by this path.
// ─────────────────────────────────────────────────────────────────────────────

export type ReplayOutcome = {
  /** Bodies that became bookings. */
  recorded: number;
  /** Bodies still held, with the reason now recorded against each. */
  stillHeld: number;
  /** Bodies skipped because they were recorded already. */
  alreadyRecorded: number;
  /** One line per body that could not be recorded, for the screen. */
  problems: string[];
};

type Capture = {
  id: string;
  provider: string;
  bodyEncrypted: string;
  replayedAt: Date | null;
};

/**
 * Replays every held push for one hotel's booking connection.
 *
 * `connection` is the caller's already-verified connection: the tenant comes
 * from it, never from a body, exactly as it does for a live push.
 */
export async function replayHeldPushes(connection: {
  id: string;
  agencyId: string;
  hotelClientId: string;
  provider: string;
}): Promise<ReplayOutcome> {
  const scoped = agencyScopedFor(connection.agencyId, prisma.bookingPushCapture);
  const captures: Capture[] = await scoped.findMany({
    where: { connectionId: connection.id, hotelClientId: connection.hotelClientId },
    orderBy: { receivedAt: "asc" }, // oldest first: lifecycle order is the true order
    select: { id: true, provider: true, bodyEncrypted: true, replayedAt: true },
  });

  const out: ReplayOutcome = { recorded: 0, stillHeld: 0, alreadyRecorded: 0, problems: [] };

  for (const cap of captures) {
    if (cap.replayedAt) {
      out.alreadyRecorded += 1;
      continue;
    }

    const fail = async (reason: string) => {
      out.stillHeld += 1;
      out.problems.push(reason);
      // Record WHY it is still held, so the panel explains itself.
      await scoped.update({ where: { id: cap.id }, data: { reason: reason.slice(0, 500) } });
    };

    const adapter = getBookingProvider(cap.provider);
    if (!adapter?.parseWebhook) {
      await fail(`No mapping exists for ${cap.provider} yet.`);
      continue;
    }

    let raw: string;
    try {
      raw = decryptToken(cap.bodyEncrypted).reveal();
    } catch {
      await fail("This body could not be decrypted, so it cannot be recorded.");
      continue;
    }

    const parsed = adapter.parseWebhook(raw, new Headers());
    if (!parsed.ok) {
      await fail(parsed.error);
      continue;
    }
    if (parsed.value.length === 0) {
      await fail("The body contained no booking.");
      continue;
    }

    const batch = await ingestBookingEvents(connection, parsed.value);
    if (batch.succeeded === 0) {
      await fail(
        batch.results.flatMap((r) => (r.ok ? [] : r.errors)).join("; ") ||
          "The booking could not be recorded.",
      );
      continue;
    }

    out.recorded += 1;
    await scoped.update({ where: { id: cap.id }, data: { replayedAt: new Date() } });
  }

  return out;
}
