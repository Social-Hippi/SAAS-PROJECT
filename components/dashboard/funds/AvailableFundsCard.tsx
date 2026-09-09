import { presentMetric } from "@/lib/metrics/present";
import { isOk } from "@/lib/metrics/metric-value";
import { formatCurrency } from "@/lib/format";
import type { AdFunds } from "@/lib/metrics/funds";
import { LowBalanceReminderForm } from "./LowBalanceReminderForm";

// Current available advertising funds, and the reminder that watches them.
//
// "Balance unavailable" is the expected state for most accounts, not an error:
// Meta publishes no spendable-balance field, so we can only report headroom when
// an account has a spend cap. The card says which situation it is in and what
// would change it, rather than showing a zero that would read as "you have run
// out" — the single most alarming wrong number this dashboard could display.
//
// The reminder is offered either way. Configuring it before a balance exists is
// harmless and the job simply never fires; hiding the control would make the
// feature undiscoverable for exactly the accounts that later gain a cap.
//
// EXCEPT on the public /share/<uuid> report, which carries no session. Changing
// WHO receives this hotel's balance figures is a write, and that write now
// requires a session — so a link-holder is pointed at their agency rather than
// shown a form the server would refuse. The guard itself lives in
// funds/actions.ts; this gate only keeps the UI honest about it.

function relTime(d: Date | null): string {
  if (!d) return "not checked yet";
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 60) return `${Math.max(0, mins)} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function AvailableFundsCard({
  funds,
  hotelId,
  viewer,
  agencyName,
}: {
  funds: AdFunds;
  hotelId: string;
  /** "share" is the public, session-less report — it gets no write control. */
  viewer: "agency" | "share";
  agencyName: string;
}) {
  const available = presentMetric(funds.available, "currency");
  const threshold = funds.reminder.thresholdMinor;

  // isOk() inline rather than a boolean flag: MetricValue is a discriminated
  // union, so only the guard narrows it. A `const known = isOk(...)` does not,
  // which is the type refusing to let a value be read without proving it exists.
  const known = isOk(funds.available);
  const belowThreshold =
    isOk(funds.available) && threshold != null && funds.available.value * 100 < threshold;

  return (
    <section className="overflow-hidden rounded-card border border-line bg-card shadow-card">
      <div className="border-b border-line px-4 py-3 sm:px-5">
        <h2 className="font-medium text-ink">Current available funds</h2>
        <p className="mt-0.5 text-sm text-ink-tertiary">
          What&apos;s left to spend on advertising, and a reminder before it runs out.
        </p>
      </div>

      <div className="px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p
              className={`text-3xl font-bold tabular-nums ${
                !known ? "text-ink-tertiary" : belowThreshold ? "text-warning" : "text-ink"
              }`}
              title={available.title}
            >
              {known ? available.text : "Balance unavailable"}
            </p>
            <p className="mt-1 text-xs text-ink-tertiary">
              {funds.platformLabel}
              {funds.accountId ? ` · account ${funds.accountId}` : ""} · checked{" "}
              {relTime(funds.checkedAt)}
            </p>
          </div>
          {belowThreshold && (
            <span className="rounded-full bg-warning/15 px-3 py-1 text-xs font-semibold text-warning">
              Below your reminder threshold
            </span>
          )}
        </div>

        {!known && (
          <p className="mt-3 rounded-lg border border-line bg-elevated/50 px-3 py-2 text-xs text-ink-tertiary">
            {funds.available.state === "unavailable" ? funds.available.reason : ""}
          </p>
        )}

        {funds.lastError && (
          <p className="mt-2 text-xs text-warning">
            We couldn&apos;t read the advertising account on the last check. Your agency can
            reconnect it.
          </p>
        )}
      </div>

      <div className="border-t border-line px-4 py-4 sm:px-5">
        {viewer === "share" ? (
          <p className="text-sm text-ink-tertiary">
            To set or change the low-balance reminder, contact {agencyName}.
          </p>
        ) : (
          <LowBalanceReminderForm
            hotelId={hotelId}
            initialEmail={funds.reminder.email}
            initialThresholdMinor={funds.reminder.thresholdMinor}
            configured={funds.reminder.configured}
          />
        )}

        {funds.reminder.configured && (
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <div className="flex justify-between gap-3 sm:justify-start">
              <dt className="text-ink-tertiary">Status</dt>
              <dd className={funds.reminder.enabled ? "text-success" : "text-ink-tertiary"}>
                {funds.reminder.enabled ? "Active" : "Paused"}
              </dd>
            </div>
            <div className="flex justify-between gap-3 sm:justify-start">
              <dt className="text-ink-tertiary">Threshold</dt>
              <dd className="tabular-nums text-ink-secondary">
                {threshold != null ? formatCurrency(threshold / 100) : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-3 sm:justify-start">
              <dt className="text-ink-tertiary">Sends to</dt>
              <dd className="truncate text-ink-secondary">{funds.reminder.email}</dd>
            </div>
            <div className="flex justify-between gap-3 sm:justify-start">
              <dt className="text-ink-tertiary">Last checked</dt>
              <dd className="text-ink-secondary">{relTime(funds.reminder.lastCheckedAt)}</dd>
            </div>
            <div className="flex justify-between gap-3 sm:justify-start">
              <dt className="text-ink-tertiary">Last sent</dt>
              <dd className="text-ink-secondary">
                {funds.reminder.lastTriggeredAt
                  ? relTime(funds.reminder.lastTriggeredAt)
                  : "never"}
              </dd>
            </div>
            {funds.reminder.currentlyTriggered && (
              <div className="flex justify-between gap-3 sm:justify-start">
                <dt className="text-ink-tertiary">Waiting</dt>
                <dd className="text-ink-secondary">
                  until funds go back above your threshold
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </section>
  );
}
