"use client";

import { useActionState } from "react";

import { formatCurrency } from "@/lib/format";
import { saveBookingValue, type BookingValueState } from "./actions";

export type BookingRow = {
  id: string;
  bookedAtLabel: string;
  krayaLeadId: string | null;
  phoneLast4: string | null;
  stageName: string | null;
  pipelineName: string | null;
  traced: boolean;
  marked: boolean;
  amount: number | null;
};

const INITIAL: BookingValueState = { error: null, ok: false };

/**
 * One editable row per WhatsApp booking.
 *
 * Each row is its own form so a slow save never blocks the next entry and one
 * rejected amount cannot discard a screenful of typing.
 */
export function BookingValueList({
  hotelId,
  bookings,
  currency,
}: {
  hotelId: string;
  bookings: BookingRow[];
  currency: string;
}) {
  if (bookings.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-card p-6 text-sm text-ink-tertiary">
        No WhatsApp bookings were recorded in this period.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[46rem] text-sm">
        <thead>
          <tr className="border-b border-line bg-page text-left">
            <Th>Booked</Th>
            <Th>Kraya lead</Th>
            <Th>Came from an ad</Th>
            <Th>Booking value ({currency})</Th>
            <Th> </Th>
          </tr>
        </thead>
        <tbody>
          {bookings.map((b) => (
            <Row key={b.id} hotelId={hotelId} booking={b} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-disabled">
      {children}
    </th>
  );
}

function Row({ hotelId, booking }: { hotelId: string; booking: BookingRow }) {
  const [state, action, pending] = useActionState(saveBookingValue, INITIAL);

  return (
    <tr className="border-b border-line last:border-0 align-middle">
      <td className="whitespace-nowrap px-4 py-3 text-ink-secondary">{booking.bookedAtLabel}</td>
      {/* Kraya's own lead id, not a name or a number: the import stores neither,
          and this is what a person types into Kraya to find the reservation and
          read the amount off it. */}
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-ink">
          {booking.krayaLeadId ??
            (booking.phoneLast4 ? `Imported lead · ⋯${booking.phoneLast4}` : "Imported lead")}
        </span>
        <span className="block text-xs text-ink-disabled">
          {[booking.pipelineName, booking.stageName].filter(Boolean).join(" · ") || "—"}
        </span>
      </td>
      <td className="px-4 py-3">
        <form action={action} id={`f-${booking.id}`} className="contents">
          <input type="hidden" name="bookingId" value={booking.id} />
          <input type="hidden" name="hotelId" value={hotelId} />
          {booking.traced ? (
            <>
              {/* Traced bookings carry the record, and the report counts them
                  from it. The mark is sent as-is rather than forced on, so a
                  later untrace cannot leave a stale opinion behind. */}
              <input type="hidden" name="marked" value={booking.marked ? "1" : "0"} />
              <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
                Traced to an ad
              </span>
            </>
          ) : (
            <label className="inline-flex items-center gap-2 text-ink-secondary">
              <input
                type="checkbox"
                name="marked"
                value="1"
                defaultChecked={booking.marked}
                className="h-4 w-4 rounded border-line"
              />
              <span className="text-xs">We believe it did</span>
            </label>
          )}
        </form>
      </td>
      <td className="px-4 py-3">
        <input
          form={`f-${booking.id}`}
          name="amount"
          inputMode="decimal"
          defaultValue={booking.amount == null ? "" : String(booking.amount)}
          placeholder="Not entered"
          aria-label="Booking value"
          className="w-36 rounded-lg border border-line-strong bg-card px-2.5 py-1.5 text-right tabular-nums"
        />
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <button
          form={`f-${booking.id}`}
          type="submit"
          disabled={pending}
          className="rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink-secondary hover:bg-page disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {state.ok && <span className="ml-2 text-xs text-success">Saved ✓</span>}
        {state.error && <span className="ml-2 text-xs text-danger">{state.error}</span>}
      </td>
    </tr>
  );
}

/** Running total, so the agency sees what the hotel's report will say. */
export function ValueSummary({
  countable,
  valued,
  total,
}: {
  countable: number;
  valued: number;
  total: number;
}) {
  const missing = countable - valued;
  return (
    <div className="rounded-lg border border-line bg-card p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-disabled">
        Revenue from WhatsApp ad bookings
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">
        {valued === 0 ? "Not entered yet" : formatCurrency(total)}
      </p>
      <p className="mt-2 max-w-[60ch] text-sm text-ink-tertiary">
        {countable === 0
          ? "No booking here is counted as coming from an ad yet."
          : missing === 0
            ? `All ${countable} booking${countable === 1 ? "" : "s"} counted as coming from an ad ${countable === 1 ? "has" : "have"} a value. This is what the hotel's report shows.`
            : `${missing} of ${countable} booking${countable === 1 ? "" : "s"} counted as coming from an ad ${missing === 1 ? "has" : "have"} no value yet, so the hotel's report is showing less than the true total.`}
      </p>
    </div>
  );
}
