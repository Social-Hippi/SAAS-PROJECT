"use client";

import { useActionState } from "react";
import { setConversionDetection, type ConversionState } from "./conversion-actions";

const initial: ConversionState = { error: null, ok: false };

/**
 * Which URLs mean "a booking was completed".
 *
 * The copy leads with what goes missing. An operator reading "thank-you URL
 * pattern" cannot tell what a wrong value costs; one reading "bookings that
 * finish anywhere else are not recorded" can.
 */
export function ConversionDetectionCard({
  hotelId,
  patterns,
  conversionsSeen,
}: {
  hotelId: string;
  patterns: string[];
  /** Distinct confirmation URLs we have actually recorded a booking on. */
  conversionsSeen: number;
}) {
  const [state, action, pending] = useActionState(setConversionDetection, initial);

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div>
        <p className="text-sm font-medium text-ink">Booking confirmation pages</p>
        <p className="mt-0.5 text-xs text-ink-tertiary">
          A booking is recorded when a guest reaches one of these pages. A booking
          that finishes anywhere else — a different payment method, pay at hotel,
          another gateway — is not recorded at all, and the visit still looks
          tracked.
        </p>
      </div>

      {patterns.length === 1 && (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-snug text-ink-secondary">
          Only one path is listed. If this hotel takes bookings any other way,
          those are currently invisible — worth checking with the booking engine
          which URLs a completed booking can land on.
        </p>
      )}

      <form action={action} className="space-y-2">
        <input type="hidden" name="hotelId" value={hotelId} />
        <textarea
          name="patterns"
          rows={3}
          defaultValue={patterns.join("\n")}
          placeholder={"/payment/razorpay-callback/*\n/booking/confirmed/*"}
          className="w-full rounded-lg border border-line-strong bg-page px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-disabled focus:border-brand focus:outline-none"
        />
        <p className="text-xs text-ink-tertiary">
          One per line. <code>*</code> matches anything, so{" "}
          <code>/booking/confirmed/*</code> covers every booking reference. Pasting
          a full confirmation URL is fine — we keep just the path.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg border border-line-strong bg-elevated px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-line-strong disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save paths"}
          </button>
          {state.ok && <span className="text-xs text-success">Saved ✓</span>}
          {state.error && <span className="text-xs text-danger">{state.error}</span>}
        </div>
      </form>

      <p className="text-xs text-ink-tertiary">
        {conversionsSeen > 0
          ? `${conversionsSeen} booking${conversionsSeen === 1 ? "" : "s"} recorded so far.`
          : "No booking recorded yet. If this hotel is taking bookings, the paths above are probably wrong."}
      </p>
    </div>
  );
}
