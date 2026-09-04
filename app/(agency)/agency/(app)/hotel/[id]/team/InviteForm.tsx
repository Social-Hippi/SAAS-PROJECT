"use client";

import { useActionState, useState } from "react";
import {
  HOTEL_ROLES,
  HOTEL_ROLE_DESCRIPTION,
  HOTEL_ROLE_LABEL,
  type HotelRole,
} from "@/lib/hotel-capabilities";
import { inviteHotelUserAction, type TeamActionState } from "./actions";

const initialState: TeamActionState = { ok: false };

const inputCls =
  "w-full rounded-lg border border-line-strong bg-page px-3 py-2 text-sm text-ink placeholder:text-ink-disabled outline-none focus:border-brand focus:ring-1 focus:ring-brand";

export function InviteForm({ hotelClientId }: { hotelClientId: string }) {
  const [state, formAction, pending] = useActionState(inviteHotelUserAction, initialState);
  const [role, setRole] = useState<HotelRole>("hotel_owner");

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="hotelClientId" value={hotelClientId} />

      <div>
        <label htmlFor="invite-email" className="block text-sm font-medium text-ink-secondary">
          Email address
        </label>
        <input
          id="invite-email"
          name="email"
          type="email"
          required
          placeholder="owner@hotel.com"
          autoComplete="off"
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "invite-error" : undefined}
          className={`mt-1 ${inputCls}`}
        />
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-ink-secondary">Access level</legend>
        {/* Radios rather than a select: there are only three, and each needs a
            line of explanation. A dropdown would hide the difference at exactly
            the moment the person is deciding. */}
        <div className="mt-2 space-y-2">
          {HOTEL_ROLES.map((r) => (
            <label
              key={r}
              className={`flex cursor-pointer gap-3 rounded-button border p-3 transition ${
                role === r ? "border-brand bg-brand/5" : "border-line hover:border-line-strong"
              }`}
            >
              <input
                type="radio"
                name="role"
                value={r}
                checked={role === r}
                onChange={() => setRole(r)}
                className="mt-0.5 accent-[var(--brand)]"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{HOTEL_ROLE_LABEL[r]}</span>
                <span className="block text-xs text-ink-tertiary">{HOTEL_ROLE_DESCRIPTION[r]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {state.error && (
        <p id="invite-error" role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && state.notice && (
        <p role="status" className="text-sm text-success">
          {state.notice}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-button bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Sending…" : "Send invitation"}
      </button>
    </form>
  );
}
