"use client";

import { useActionState } from "react";
import {
  selectGoogleAdsCustomer,
  syncGoogleAdsNow,
  disconnectGoogleAds,
  type GoogleAdsActionState,
} from "./google-ads-actions";
import { formatCurrency, formatCurrencyCents, formatNumber } from "@/lib/format";

export type GoogleAdsCardStatus = "none" | "needs_account" | "active" | "token_expired" | "error";

export type GoogleAdsAccount = {
  customerId: string;
  descriptiveName: string | null;
  currencyCode: string | null;
  manager: boolean;
};

/**
 * Headline metrics for the connected card (trailing 30 days). Sourced from the
 * SAME loader the dashboard uses (loadGoogleAds): `totalSpend` is in RUPEES
 * (cost_micros ÷ 1e6 at sync), and ctr/cpc are recomputed from summed
 * numerators/denominators — never averaged across rows.
 */
export type GoogleAdsCardMetrics = {
  totalSpend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
};

const initial: GoogleAdsActionState = { error: null, ok: false };

// Format a bare 10-digit customer id as Google's 3-3-4 (e.g. 123-456-7890).
function fmtCustomerId(id: string): string {
  const d = id.replace(/\D/g, "");
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : id;
}

// One headline-metric tile in the connected card's 30-day summary.
function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-page px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-tertiary">{label}</p>
      <p className="mt-0.5 text-base font-semibold tabular-nums text-ink">{value}</p>
    </div>
  );
}

function ConnectButton({ hotelId, label }: { hotelId: string; label: string }) {
  return (
    <a
      href={`/api/auth/google-ads/start?hotelClientId=${hotelId}`}
      className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover"
    >
      <span className="text-xs font-bold">Ads</span>
      {label}
    </a>
  );
}

function AccountPicker({
  hotelId,
  accounts,
}: {
  hotelId: string;
  accounts: GoogleAdsAccount[];
}) {
  const [state, action, pending] = useActionState(selectGoogleAdsCustomer, initial);
  // Prefer a non-manager account as the default selection.
  const firstPickable = accounts.findIndex((a) => !a.manager);
  const defaultIdx = firstPickable === -1 ? 0 : firstPickable;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="hotelId" value={hotelId} />
      <p className="text-sm text-ink-secondary">
        Your Google account can access several Ads accounts. Pick the one for this
        hotel:
      </p>
      <div className="space-y-2">
        {accounts.map((a, i) => (
          <label
            key={a.customerId}
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-line bg-page p-3 text-sm"
          >
            <input
              type="radio"
              name="customerId"
              value={a.customerId}
              defaultChecked={i === defaultIdx}
              className="accent-brand"
            />
            <span className="min-w-0">
              <span className="block font-medium text-ink">
                {a.descriptiveName ?? "Ads account"}
                {a.manager && (
                  <span className="ml-2 rounded bg-line px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-tertiary">
                    Manager
                  </span>
                )}
              </span>
              <span className="block text-xs text-ink-tertiary">
                {fmtCustomerId(a.customerId)}
                {a.currencyCode ? ` · ${a.currencyCode}` : ""}
              </span>
            </span>
          </label>
        ))}
      </div>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60"
      >
        {pending ? "Saving…" : "Use this account"}
      </button>
    </form>
  );
}

function SyncButton({ hotelId }: { hotelId: string }) {
  const [state, action, pending] = useActionState(syncGoogleAdsNow, initial);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="hotelId" value={hotelId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-line-strong bg-elevated px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-line-strong disabled:opacity-60"
      >
        {pending ? "Syncing…" : "Sync now"}
      </button>
      {state.error && <span className="text-xs text-danger">{state.error}</span>}
      {state.ok && <span className="text-xs text-success">Synced ✓</span>}
    </form>
  );
}

function DisconnectButton({ hotelId }: { hotelId: string }) {
  return (
    <form action={disconnectGoogleAds}>
      <input type="hidden" name="hotelId" value={hotelId} />
      <button
        type="submit"
        onClick={(e) => {
          if (!window.confirm("Disconnect Google Ads for this hotel? Its stored tokens will be deleted; historical data is kept.")) {
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

export function GoogleAdsCard({
  hotelId,
  status,
  customerName,
  customerId,
  currencyCode,
  lastSyncedAt,
  lastSyncError,
  accounts,
  metrics = null,
}: {
  hotelId: string;
  status: GoogleAdsCardStatus;
  customerName: string | null;
  customerId: string | null;
  currencyCode: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  accounts: GoogleAdsAccount[];
  /** Trailing-30-day headline metrics; null when there's no in-range data. */
  metrics?: GoogleAdsCardMetrics | null;
}) {
  if (status === "none") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">
          Connect this hotel&apos;s Google Ads account to bring campaign spend,
          clicks, conversions, and ROAS into the Google Ads channel. Each hotel has
          its own connection, so accounts stay independent.
        </p>
        <ConnectButton hotelId={hotelId} label="Connect Google Ads" />
        <p className="text-xs text-ink-tertiary">
          Required: a Google account with access to the hotel&apos;s Google Ads
          account.
        </p>
      </div>
    );
  }

  if (status === "needs_account") {
    return <AccountPicker hotelId={hotelId} accounts={accounts} />;
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
        <ConnectButton hotelId={hotelId} label="Reconnect" />
      </div>
    );
  }

  // active
  return (
    <div className="space-y-4">
      <div className="text-sm">
        <p className="font-medium text-ink">{customerName ?? "Google Ads account"}</p>
        <p className="text-ink-tertiary">
          Customer ID: <code className="font-mono text-xs">{fmtCustomerId(customerId ?? "")}</code>
          {currencyCode ? ` · ${currencyCode}` : ""}
          {lastSyncedAt ? ` · last synced ${new Date(lastSyncedAt).toLocaleString()}` : " · not synced yet"}
        </p>
      </div>

      {/* Headline metrics — same aggregation as the dashboard's Google Ads channel
          (spend in ₹, CTR/CPC recomputed from totals). Shown only when in-range
          data exists; a connected account with no recent activity omits this. */}
      {metrics && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">Last 30 days</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <MetricTile label="Spend" value={formatCurrency(metrics.totalSpend)} />
            <MetricTile label="Clicks" value={formatNumber(metrics.clicks)} />
            <MetricTile label="Impressions" value={formatNumber(metrics.impressions)} />
            <MetricTile label="CTR" value={`${metrics.ctr.toFixed(2)}%`} />
            <MetricTile label="CPC" value={formatCurrencyCents(metrics.cpc)} />
          </div>
        </div>
      )}

      <div className="rounded-lg border-l-4 border-info bg-info/10 p-3 text-xs text-ink-secondary">
        Campaign data syncs automatically every day and appears in the Google Ads
        channel on this hotel&apos;s dashboard. Use <strong>Sync now</strong> to pull
        the latest immediately.
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SyncButton hotelId={hotelId} />
        <DisconnectButton hotelId={hotelId} />
      </div>
    </div>
  );
}
