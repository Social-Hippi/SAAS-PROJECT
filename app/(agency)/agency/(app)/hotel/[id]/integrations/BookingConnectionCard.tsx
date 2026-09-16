"use client";

import { useActionState } from "react";
import { CopyButton } from "@/components/ui/CopyButton";
import {
  connectBookingProvider,
  disconnectBookingProvider,
  type BookingConnectionState,
} from "./booking-actions";

const initial: BookingConnectionState = { error: null, ok: false };

export type BookingConnectionView = {
  provider: string;
  status: string;
  lastBookingReceivedAt: string | null;
  lastError: string | null;
} | null;

/**
 * Booking Push setup.
 *
 * The three things an operator has to hand the provider are shown together —
 * URL, header JSON, secret — because they are pasted into one form on the
 * provider's dashboard, and a screen that makes someone assemble them from
 * three places is a screen that produces typos.
 */
export function BookingConnectionCard({
  hotelId,
  appUrl,
  connection,
}: {
  hotelId: string;
  appUrl: string;
  connection: BookingConnectionView;
}) {
  const [state, action, pending] = useActionState(connectBookingProvider, initial);
  const provider = connection?.provider ?? "simplotel";
  const endpoint = `${appUrl}/api/integrations/booking/${provider}`;
  const secret = state.secret;

  return (
    <div className="space-y-4">
      {connection ? (
        <div className="space-y-1 text-sm text-ink-secondary">
          <p>
            Provider: <span className="font-medium text-ink">{connection.provider}</span>
          </p>
          <p>
            {connection.lastBookingReceivedAt ? (
              <>
                Last booking received:{" "}
                <span className="font-medium text-ink">
                  {new Date(connection.lastBookingReceivedAt).toLocaleString()}
                </span>
              </>
            ) : (
              /* The honest health signal is whether a booking has ARRIVED, not
                 whether a row exists. A connection configured on our side and
                 never enabled on theirs looks identical until one lands. */
              <span className="text-ink-tertiary">
                No booking received yet — the connection is live on our side, but
                nothing has been pushed to it.
              </span>
            )}
          </p>
          {connection.lastError && (
            <p className="text-danger">Last error: {connection.lastError}</p>
          )}
        </div>
      ) : (
        <p className="text-sm text-ink-secondary">
          Generate an endpoint and secret, then send both to the booking engine
          provider so they can push confirmed bookings here. Until this is set up,
          bookings and revenue on this hotel&apos;s report come only from the
          website snippet, which cannot see bookings completed on the booking
          engine.
        </p>
      )}

      {/* Shown once, on the response that minted it. */}
      {secret && (
        <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-4">
          <p className="text-sm font-medium text-ink">
            Copy these now — the secret is not shown again.
          </p>
          <Field label="API URL" value={endpoint} />
          <Field
            label="API Headers (JSON)"
            value={`{\n  "Content-Type": "application/json",\n  "Authorization": "Bearer ${secret}"\n}`}
            multiline
          />
          <p className="text-xs text-ink-tertiary">
            Stored encrypted, so it cannot be displayed again. If it is lost,
            generate a new one — the provider&apos;s configuration then has to be
            updated, and pushes fail until it is.
          </p>
        </div>
      )}

      {!secret && connection && (
        <Field label="API URL" value={endpoint} />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <form action={action} className="inline-flex items-center gap-2">
          <input type="hidden" name="hotelId" value={hotelId} />
          <input type="hidden" name="provider" value={provider} />
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60"
          >
            {pending
              ? "Generating…"
              : connection
                ? "Generate new secret"
                : "Set up Booking Push"}
          </button>
          {state.error && <span className="text-xs text-danger">{state.error}</span>}
        </form>

        {connection && (
          <form action={disconnectBookingProvider}>
            <input type="hidden" name="hotelId" value={hotelId} />
            <input type="hidden" name="provider" value={provider} />
            <button
              type="submit"
              className="rounded-lg border border-line-strong bg-elevated px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-line-strong"
            >
              Disconnect
            </button>
          </form>
        )}
      </div>

      {connection && !secret && (
        <p className="text-xs text-ink-tertiary">
          Generating a new secret immediately invalidates the current one.
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
        {label}
      </p>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-line-strong bg-card px-3 py-2 font-mono text-xs text-ink">
          {value}
        </pre>
        <CopyButton text={value} label="Copy" />
      </div>
      {multiline && null}
    </div>
  );
}
