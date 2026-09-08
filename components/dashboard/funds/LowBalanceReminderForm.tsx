"use client";

import { useState, useTransition } from "react";
import { saveLowBalanceReminder } from "./actions";

// "Set low balance reminder" — a disclosure, not a modal.
//
// A modal would trap focus and demand a decision for a setting nobody opens the
// dashboard to change. Inline disclosure keeps the funds figure visible while
// the form is open, which matters: the threshold you want depends on the balance
// you are looking at.

export function LowBalanceReminderForm({
  hotelId,
  shareToken,
  initialEmail,
  initialThresholdMinor,
  configured,
}: {
  hotelId: string;
  shareToken?: string;
  initialEmail: string | null;
  initialThresholdMinor: number | null;
  configured: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(initialEmail ?? "");
  const [threshold, setThreshold] = useState(
    initialThresholdMinor != null ? String(initialThresholdMinor / 100) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await saveLowBalanceReminder({ hotelId, shareToken, email, threshold });
      if (res.ok) {
        setSaved(true);
        setOpen(false);
      } else {
        setError(res.error);
      }
    });
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-button border border-line-strong bg-elevated px-3 py-2 text-sm font-medium text-ink-secondary transition hover:bg-line-strong"
        >
          {configured ? "Edit low balance reminder" : "Set low balance reminder"}
        </button>
        {saved && (
          <span className="text-sm font-medium text-success" role="status">
            Reminder saved.
          </span>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-line bg-elevated/50 p-4">
      <p className="text-sm font-medium text-ink">Email me when funds run low</p>
      <p className="mt-0.5 text-xs text-ink-tertiary">
        We check once a day and email you the first time funds drop below your threshold. You
        won&apos;t be emailed again until they go back up and fall again.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-medium text-ink-secondary">Email address</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@yourhotel.com"
            className="mt-1 w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink-secondary">Notify me below (₹)</span>
          <input
            type="text"
            inputMode="decimal"
            required
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            placeholder="5000"
            className="mt-1 w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink tabular-nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </label>
      </div>

      {error && (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-button bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-hover disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save reminder"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="rounded-button border border-line-strong px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-elevated"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
