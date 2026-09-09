"use client";

import { useActionState, useState } from "react";
import { adminReconcileOpsTrackers, type SyncNowState } from "./actions";

const initialState: SyncNowState = { error: null, ok: false, message: null };

const fieldCls =
  "rounded-lg border border-line-strong bg-page px-3 py-2 text-sm text-ink placeholder:text-ink-disabled outline-none focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-60";

// Manual operations-tracker import. The webhook is the primary path and the
// daily cron is the backstop; this is for when someone has just corrected a
// sheet and does not want to wait for either. Controlled field for the same
// React 19 reset reason as SyncNowForm.
export function OpsTrackerForm() {
  const [state, action, pending] = useActionState(adminReconcileOpsTrackers, initialState);
  const [password, setPassword] = useState("");

  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-ink-tertiary">
          Admin password
          <input
            type="password"
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={fieldCls}
            autoComplete="off"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {pending ? "Importing…" : "Import trackers now"}
        </button>
      </div>

      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.ok && state.message && <p className="text-sm text-success">{state.message}</p>}
    </form>
  );
}
