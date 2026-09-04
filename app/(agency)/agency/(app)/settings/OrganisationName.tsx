"use client";

import { useActionState, useState } from "react";
import { AGENCY_NAME_MAX } from "@/lib/agency-validation";
import { saveAgencyName, type AgencyNameState } from "./actions";

// Rename the ORGANISATION.
//
// This is organisation-level state, not a per-user preference: the value shown
// here is the one every member of the agency sees in the app header, on
// generated reports, and in emails to hotels. There was previously no way to
// change it at all — the name was written once at onboarding and by nothing
// else — so an agency that accepted the pre-filled `<FirstName>'s Agency`
// default was identified by an individual, permanently.
//
// Controlled input (React 19 resets uncontrolled fields after a server action)
// and the same field styling as AgencyContactForm, so the two sections of the
// settings page look like one form system.

const initialState: AgencyNameState = { ok: false };

const inputCls =
  "w-full rounded-lg border border-line-strong bg-page px-3 py-2 text-sm text-ink placeholder:text-ink-disabled outline-none focus:border-brand focus:ring-1 focus:ring-brand";

export function OrganisationName({ initialName }: { initialName: string }) {
  const [state, formAction, pending] = useActionState(saveAgencyName, initialState);
  const [name, setName] = useState(initialName);

  // After a successful save the action echoes the normalized name; show that
  // rather than the raw input so the user sees exactly what was stored.
  const saved = state.ok && state.name ? state.name : null;
  const dirty = name.trim() !== (saved ?? initialName);

  return (
    <form action={formAction} className="mt-4 max-w-md space-y-3">
      <div>
        <label htmlFor="agencyName" className="block text-sm font-medium text-ink-secondary">
          Organisation name
        </label>
        <input
          id="agencyName"
          name="agencyName"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={AGENCY_NAME_MAX}
          required
          aria-describedby="agencyName-help"
          aria-invalid={state.error ? true : undefined}
          className={`mt-1 ${inputCls}`}
        />
        <p id="agencyName-help" className="mt-1 text-xs text-ink-tertiary">
          Shown to everyone in your organisation and on the reports you share with hotels.
        </p>
        {state.error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {state.error}
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || !dirty}
          className="rounded-button bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save name"}
        </button>
        {saved && !dirty && (
          <p role="status" className="text-xs text-success">
            Saved — everyone in your organisation sees this name.
          </p>
        )}
      </div>
    </form>
  );
}
