"use client";

import { useActionState } from "react";
import {
  syncGa4Now,
  selectGa4Property,
  disconnectGa4,
  type Ga4ActionState,
} from "./ga4-actions";

export type Ga4CardStatus = "none" | "needs_property" | "active" | "token_expired" | "error";

const initial: Ga4ActionState = { error: null, ok: false };

function ConnectButton({ hotelId, label }: { hotelId: string; label: string }) {
  return (
    <a
      href={`/api/auth/ga4/start?hotelClientId=${hotelId}`}
      className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover"
    >
      <span className="text-xs font-bold">GA</span>
      {label}
    </a>
  );
}

function SyncButton({ hotelId, label = "Sync now" }: { hotelId: string; label?: string }) {
  const [state, action, pending] = useActionState(syncGa4Now, initial);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="hotelId" value={hotelId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-line-strong bg-elevated px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-line-strong disabled:opacity-60"
      >
        {pending ? "Syncing…" : label}
      </button>
      {state.error && <span className="text-xs text-danger">{state.error}</span>}
      {state.notice && <span className="text-xs text-warning">{state.notice}</span>}
      {state.ok && <span className="text-xs text-success">Synced ✓</span>}
    </form>
  );
}

function PropertyPicker({
  hotelId,
  properties,
}: {
  hotelId: string;
  properties: { propertyId: string; displayName: string }[];
}) {
  const [state, action, pending] = useActionState(selectGa4Property, initial);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="hotelId" value={hotelId} />
      <p className="text-sm text-ink-secondary">
        Your Google account has access to several GA4 properties. Pick the one for
        this hotel:
      </p>
      <div className="space-y-2">
        {properties.map((p, i) => (
          <label key={p.propertyId} className="flex cursor-pointer items-center gap-3 rounded-lg border border-line bg-page p-3 text-sm">
            <input type="radio" name="propertyId" value={p.propertyId} defaultChecked={i === 0} className="accent-brand" />
            <span className="min-w-0">
              <span className="block font-medium text-ink">{p.displayName}</span>
              <span className="block text-xs text-ink-tertiary">ID: {p.propertyId}</span>
            </span>
            {/* carry the display name for the chosen radio via a hidden mirror */}
          </label>
        ))}
      </div>
      {/* The action re-derives the name from propertyId server-side if blank; we
          also pass the first as a hint. */}
      <input type="hidden" name="propertyName" value="" />
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.notice && <p className="text-sm text-warning">{state.notice}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60"
      >
        {pending ? "Saving…" : "Use this property"}
      </button>
    </form>
  );
}

function DisconnectButton({ hotelId }: { hotelId: string }) {
  return (
    <form action={disconnectGa4}>
      <input type="hidden" name="hotelId" value={hotelId} />
      <button
        type="submit"
        onClick={(e) => {
          if (!window.confirm("Disconnect GA4 for this hotel? Its stored tokens will be deleted; historical snapshots are kept.")) {
            e.preventDefault();
          }
        }}
        className="rounded-lg border border-danger/60 px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10"
      >
        Disconnect
      </button>
    </form>
  );
}

export function Ga4Card({
  hotelId,
  status,
  propertyName,
  propertyId,
  lastSyncedAt,
  lastSyncError,
  properties,
}: {
  hotelId: string;
  status: Ga4CardStatus;
  propertyName: string | null;
  propertyId: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  properties: { propertyId: string; displayName: string }[];
}) {
  if (status === "none") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">
          Bring website traffic sources, Google Ads, geography, and device
          breakdown into this hotel&apos;s dashboard.
        </p>
        <ConnectButton hotelId={hotelId} label="Connect GA4" />
        <p className="text-xs text-ink-tertiary">
          Required: a Google account with access to a GA4 property.
        </p>
      </div>
    );
  }

  if (status === "needs_property") {
    return <PropertyPicker hotelId={hotelId} properties={properties} />;
  }

  if (status === "token_expired") {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border-l-4 border-warning bg-warning/10 p-3 text-sm text-ink-secondary">
          Your Google authorization expired. Please reconnect to resume syncing.
        </div>
        <ConnectButton hotelId={hotelId} label="Reconnect" />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border-l-4 border-warning bg-warning/10 p-3 text-sm text-ink-secondary">
          Last sync hit an issue{lastSyncError ? `: ${lastSyncError}` : "."}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SyncButton hotelId={hotelId} label="Retry" />
          <ConnectButton hotelId={hotelId} label="Reconnect" />
        </div>
      </div>
    );
  }

  // active
  return (
    <div className="space-y-4">
      <div className="text-sm">
        <p className="font-medium text-ink">{propertyName ?? "GA4 property"}</p>
        <p className="text-ink-tertiary">
          Property ID: <code className="font-mono text-xs">{propertyId}</code>
          {lastSyncedAt ? ` · last synced ${new Date(lastSyncedAt).toLocaleString()}` : " · not synced yet"}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SyncButton hotelId={hotelId} />
        <DisconnectButton hotelId={hotelId} />
      </div>
    </div>
  );
}
