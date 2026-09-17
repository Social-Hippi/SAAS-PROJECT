"use client";

import { useActionState } from "react";
import { setBookingDomains, type BookingDomainState } from "./booking-domain-actions";

const initial: BookingDomainState = { error: null, ok: false };

/**
 * Booking domains — the setting that decides whether ad attribution works.
 *
 * The copy leads with the consequence rather than the mechanism. An operator
 * reading "cross-domain link decoration" cannot tell whether it matters; one
 * reading "without this, bookings from your ads are not counted" can.
 */
export function BookingDomainsCard({
  hotelId,
  domains,
  bookingHostsSeen,
}: {
  hotelId: string;
  domains: string[];
  /** Hosts we have actually received tracking from — the likely answers. */
  bookingHostsSeen: string[];
}) {
  const [state, action, pending] = useActionState(setBookingDomains, initial);
  const configured = domains.length > 0;
  const suggestions = bookingHostsSeen.filter((h) => !domains.includes(h));

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div>
        <p className="text-sm font-medium text-ink">Booking engine domains</p>
        <p className="mt-0.5 text-xs text-ink-tertiary">
          If your booking engine is on a different domain from the website, list
          it here. Without it, a guest who arrives from a Google or Meta ad
          arrives at the booking engine as a stranger, and the booking they make
          cannot be credited to the ad that produced it.
        </p>
      </div>

      {!configured && (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-snug text-ink-secondary">
          Nothing is listed, so ad clicks stop at the website. Bookings completed
          on another domain are currently counted as if nobody sent them.
        </p>
      )}

      <form action={action} className="space-y-2">
        <input type="hidden" name="hotelId" value={hotelId} />
        <textarea
          name="domains"
          rows={2}
          defaultValue={domains.join("\n")}
          placeholder={"bookings.example.com\nreservations.example.com"}
          className="w-full rounded-lg border border-line-strong bg-page px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-disabled focus:border-brand focus:outline-none"
        />
        <p className="text-xs text-ink-tertiary">
          One per line. A full URL is fine — we keep just the hostname.
        </p>

        {suggestions.length > 0 && (
          /* Taken from hosts that have actually sent us tracking, so the operator
             is choosing from reality rather than recalling a hostname. */
          <p className="text-xs text-ink-tertiary">
            Seen sending data:{" "}
            {suggestions.map((h, i) => (
              <span key={h}>
                {i > 0 && ", "}
                <span className="font-mono text-ink-secondary">{h}</span>
              </span>
            ))}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg border border-line-strong bg-elevated px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-line-strong disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save domains"}
          </button>
          {state.ok && <span className="text-xs text-success">Saved ✓</span>}
          {state.error && <span className="text-xs text-danger">{state.error}</span>}
        </div>
      </form>

      {configured && (
        <p className="text-xs text-ink-tertiary">
          Applies to bookings made from now on. Clicks that already happened
          cannot be linked retrospectively.
        </p>
      )}
    </div>
  );
}
