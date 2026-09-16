"use client";

import { useActionState } from "react";
import { CopyButton } from "@/components/ui/CopyButton";
import {
  connectKraya,
  setKrayaConfirmedStage,
  disconnectKraya,
  type KrayaState,
} from "./kraya-actions";

const initial: KrayaState = { error: null, ok: false };

export type KrayaView = {
  status: string;
  lastLeadReceivedAt: string | null;
  confirmedStageName: string | null;
  lastError: string | null;
  /** Stage names actually seen in this hotel's leads, with counts. */
  observedStages: { name: string; count: number }[];
  leadCount: number;
  bookingCount: number;
} | null;

export function KrayaCard({
  hotelId,
  appUrl,
  connection,
}: {
  hotelId: string;
  appUrl: string;
  connection: KrayaView;
}) {
  const [state, connectAction, connecting] = useActionState(connectKraya, initial);
  const [stageState, stageAction, savingStage] = useActionState(
    setKrayaConfirmedStage,
    initial,
  );
  const webhookUrl = `${appUrl}/api/integrations/kraya`;
  const secret = state.secret;

  return (
    <div className="space-y-4">
      {connection ? (
        <div className="space-y-1 text-sm text-ink-secondary">
          <p>
            {connection.leadCount} enquir{connection.leadCount === 1 ? "y" : "ies"} ·{" "}
            {connection.bookingCount} booking{connection.bookingCount === 1 ? "" : "s"}
          </p>
          <p>
            {connection.lastLeadReceivedAt ? (
              <>
                Last lead received:{" "}
                <span className="font-medium text-ink">
                  {new Date(connection.lastLeadReceivedAt).toLocaleString()}
                </span>
              </>
            ) : (
              /* A connection made here and never enabled in Kraya looks identical
                 to a working one until the first lead lands. */
              <span className="text-ink-tertiary">
                No lead received yet — this side is ready, but nothing has been
                sent to it.
              </span>
            )}
          </p>
          {connection.lastError && (
            <p className="text-danger">Last error: {connection.lastError}</p>
          )}
        </div>
      ) : (
        <p className="text-sm text-ink-secondary">
          Kraya holds this hotel&apos;s reservations WhatsApp number. Connecting it
          brings in every enquiry, which ad it came from, and which ones the
          reservations team turned into bookings — including bookings taken by
          phone, which the website never sees.
        </p>
      )}

      {/* Shown once, on the response that minted it. */}
      {secret && (
        <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-4">
          <p className="text-sm font-medium text-ink">
            Paste these into Kraya → Webhook. The secret is not shown again.
          </p>
          <Field label="Webhook URL" value={webhookUrl} />
          <Field label="Webhook Secret" value={secret} />
          <p className="text-xs text-ink-tertiary">
            Then switch the webhook from <strong>Disabled</strong> to enabled and
            press Save in Kraya.
          </p>
        </div>
      )}

      {!secret && connection && <Field label="Webhook URL" value={webhookUrl} />}

      {/* Which stage means booked — the one setting that carries a consequence. */}
      {connection && (
        <form action={stageAction} className="space-y-2 border-t border-line pt-4">
          <input type="hidden" name="hotelId" value={hotelId} />
          <label
            className="block text-sm font-medium text-ink"
            htmlFor="kraya-confirmed-stage"
          >
            Which stage means the booking is confirmed?
          </label>
          <p className="text-xs text-ink-tertiary">
            Every other stage is shown on the report exactly as Kraya names it.
            Only this one creates a booking, so it is the only one we need told.
          </p>
          {connection.observedStages.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <select
                id="kraya-confirmed-stage"
                name="stage"
                defaultValue={connection.confirmedStageName ?? ""}
                className="rounded-lg border border-line-strong bg-page px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
              >
                <option value="">— none: create no bookings —</option>
                {connection.observedStages.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name} ({s.count})
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={savingStage}
                className="rounded-lg border border-line-strong bg-elevated px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-line-strong disabled:opacity-60"
              >
                {savingStage ? "Saving…" : "Save"}
              </button>
              {stageState.ok && <span className="text-xs text-success">Saved ✓</span>}
              {stageState.error && (
                <span className="text-xs text-danger">{stageState.error}</span>
              )}
            </div>
          ) : (
            /* The list is learned from the leads themselves, so it is empty until
               the first one arrives. Offering a free-text box here would invite a
               typo that silently creates no bookings forever. */
            <p className="rounded-lg border border-line bg-elevated px-3 py-2 text-xs text-ink-tertiary">
              Stage names appear here once the first lead arrives from Kraya.
            </p>
          )}
        </form>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <form action={connectAction} className="inline-flex items-center gap-2">
          <input type="hidden" name="hotelId" value={hotelId} />
          <button
            type="submit"
            disabled={connecting}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60"
          >
            {connecting
              ? "Generating…"
              : connection
                ? "Generate new secret"
                : "Connect Kraya"}
          </button>
          {state.error && <span className="text-xs text-danger">{state.error}</span>}
        </form>

        {connection && (
          <form action={disconnectKraya}>
            <input type="hidden" name="hotelId" value={hotelId} />
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
          Generating a new secret stops Kraya&apos;s webhook until the new value is
          pasted back into it.
        </p>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
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
    </div>
  );
}
