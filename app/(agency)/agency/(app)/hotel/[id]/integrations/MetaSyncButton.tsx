"use client";

import { useActionState } from "react";
import { syncMetaNow, type MetaSyncState } from "./meta-actions";

const initial: MetaSyncState = { error: null, ok: false };

/** "Sync now" for the Meta Ads card — the one integration that never had one. */
export function MetaSyncButton({ hotelId }: { hotelId: string }) {
  const [state, action, pending] = useActionState(syncMetaNow, initial);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="hotelId" value={hotelId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-line-strong bg-elevated px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-line-strong disabled:opacity-60"
      >
        {pending ? "Syncing…" : "Sync now"}
      </button>
      {state.error && <span className="text-xs text-danger">{state.error}</span>}
      {state.ok && (
        <span className="text-xs text-success">Synced ✓ {state.message}</span>
      )}
    </form>
  );
}
