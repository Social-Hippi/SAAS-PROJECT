import Link from "next/link";

import {
  CLICK_TYPE_MEANING,
  type CallSetup,
} from "@/lib/google-ads-call-setup";
import {
  readConversionSetup,
  type ConversionSetup,
} from "@/lib/google-ads-conversion-setup";

/**
 * Why Google reports taps on a call button but no connected calls.
 *
 * Read-only. Shown only when asked for, because it costs live Google Ads calls.
 */
export function CallSetupPanel({
  setup,
  conversions,
  closeHref,
}: {
  setup: CallSetup;
  conversions: ConversionSetup | null;
  closeHref: string;
}) {
  const accountOn = setup.accountCallReporting;

  return (
    <div className="mt-6 space-y-4 border-t border-line pt-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-ink">
            Google Ads tracking check
          </p>
          <p className="mt-1 max-w-[70ch] text-sm text-ink-tertiary">
            Read from Google Ads just now, for the last 30 days. Nothing here
            changes your account.
          </p>
        </div>
        <Link
          href={closeHref}
          className="rounded-lg border border-line-strong bg-elevated px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-line-strong"
        >
          Close
        </Link>
      </div>

      {/* The account switch decides whether Google can see a call at all: without
          a forwarding number it counts the tap and nothing after it. */}
      <div
        className={`rounded-lg border-l-4 p-3 text-sm ${
          accountOn === false
            ? "border-warning bg-warning/10 text-ink-secondary"
            : "border-info bg-info/10 text-ink-secondary"
        }`}
      >
        <p>
          <span className="font-medium text-ink">
            Call reporting for this account:
          </span>{" "}
          {accountOn == null ? (
            "could not be read"
          ) : accountOn ? (
            <span className="text-success">on</span>
          ) : (
            <span className="text-danger">off</span>
          )}
          {accountOn === false && (
            <>
              {" "}
              — with it off, Google records a tap but never the call that
              follows.
            </>
          )}
        </p>
        <p className="mt-1 text-xs text-ink-tertiary">
          Call conversion reporting:{" "}
          {setup.accountCallConversionReporting == null
            ? "could not be read"
            : setup.accountCallConversionReporting
              ? "on"
              : "off"}
          {setup.accountCallAssets.length > 0 && (
            <>
              {" "}
              · {setup.accountCallAssets.length} call asset(s) set on the
              account, applying to every campaign
            </>
          )}
        </p>
      </div>

      {setup.problems.length > 0 && (
        <ul className="rounded-lg border-l-4 border-warning bg-warning/10 p-3 text-xs text-ink-secondary">
          {setup.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {setup.campaigns.length === 0 ? (
        <p className="rounded-lg border border-line bg-card p-4 text-sm text-ink-tertiary">
          No campaign reported a call asset or a call-type click in the last 30
          days.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b border-line bg-page text-left">
                <Th>Campaign</Th>
                <Th>Call asset</Th>
                <Th>Taps, last 30 days</Th>
                <Th right>Connected</Th>
              </tr>
            </thead>
            <tbody>
              {setup.campaigns.map((c) => {
                const taps = c.tapsByType.reduce((n, t) => n + t.clicks, 0);
                // The case worth spotting: taps arriving, nothing connecting.
                const suspicious = taps > 0 && (c.connectedCalls ?? 0) === 0;
                return (
                  <tr
                    key={c.campaignId}
                    className="border-b border-line align-top last:border-0"
                  >
                    <td className="px-3 py-2 text-ink">{c.campaignName}</td>
                    <td className="px-3 py-2 text-ink-secondary">
                      {c.callAssets.length === 0 ? (
                        <span className="text-ink-disabled">
                          none on this campaign
                        </span>
                      ) : (
                        c.callAssets.map((a, i) => (
                          <span key={i} className="block">
                            {a.phoneNumber ?? "number hidden"}{" "}
                            <span className="text-ink-disabled">
                              · {a.status ?? "status unknown"}
                            </span>
                          </span>
                        ))
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-secondary">
                      {c.tapsByType.length === 0 ? (
                        <span className="text-ink-disabled">none</span>
                      ) : (
                        c.tapsByType.map((t) => (
                          <span key={t.type} className="block">
                            <span className="tabular-nums text-ink">
                              {t.clicks}
                            </span>{" "}
                            <span className="text-xs text-ink-tertiary">
                              {CLICK_TYPE_MEANING[t.type] ?? t.type}
                            </span>
                          </span>
                        ))
                      )}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        suspicious ? "text-danger" : "text-ink"
                      }`}
                    >
                      {c.connectedCalls ?? 0}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="max-w-[70ch] text-xs text-ink-tertiary">
        A campaign with taps but no connected calls is worth a look — unless its
        taps are all &quot;call from a location asset&quot;, which Google never
        reports as a connected call.
      </p>

      {conversions && <ConversionSection setup={conversions} />}
    </div>
  );
}

function Th({
  children,
  right = false,
}: {
  children: React.ReactNode;
  right?: boolean;
}) {
  return (
    <th
      className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-disabled ${
        right ? "text-right" : ""
      }`}
    >
      {children}
    </th>
  );
}

/** What Google is recording as a conversion, and for how much. */
function ConversionSection({ setup }: { setup: ConversionSetup }) {
  const findings = readConversionSetup(setup);
  const live = setup.actions.filter((a) => a.status === "ENABLED");

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <p className="text-sm font-medium text-ink">
        What Google counts as a conversion
      </p>

      {/* The reading first: the tables below are the evidence for it. */}
      {findings.length > 0 && (
        <ul className="list-disc space-y-1 rounded-lg border-l-4 border-warning bg-warning/10 p-3 pl-6 text-sm text-ink-secondary">
          {findings.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}

      {setup.problems.length > 0 && (
        <ul className="rounded-lg border-l-4 border-warning bg-warning/10 p-3 text-xs text-ink-secondary">
          {setup.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {live.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="border-b border-line bg-page text-left">
                <Th>Conversion action</Th>
                <Th>What it is</Th>
                <Th>Bid towards it</Th>
                <Th>Value recorded</Th>
              </tr>
            </thead>
            <tbody>
              {live.map((a, i) => (
                <tr
                  key={`${a.name ?? "unnamed"}-${i}`}
                  className="border-b border-line last:border-0"
                >
                  <td className="px-3 py-2 text-ink">
                    {a.name ?? "(unnamed)"}
                  </td>
                  <td className="px-3 py-2 text-ink-tertiary">
                    {[a.category, a.origin].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td className="px-3 py-2">
                    {a.primaryForGoal ? (
                      <span className="font-medium text-ink">Primary</span>
                    ) : (
                      <span className="text-ink-disabled">Secondary</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-ink-secondary">
                    {a.alwaysUseDefaultValue ? (
                      <span className="text-danger">
                        always {a.defaultValue ?? "?"} {a.defaultCurrency ?? ""}
                      </span>
                    ) : a.defaultValue != null ? (
                      <>the real amount, or {a.defaultValue} when missing</>
                    ) : (
                      "the real amount"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {setup.performance.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-line bg-page text-left">
                <Th>Fired in the last 30 days</Th>
                <Th right>Conversions</Th>
                <Th right>Value</Th>
              </tr>
            </thead>
            <tbody>
              {setup.performance.map((p, i) => (
                <tr
                  key={`${p.name ?? "unnamed"}-${i}`}
                  className="border-b border-line last:border-0"
                >
                  <td className="px-3 py-2 text-ink">
                    {p.name ?? "(unnamed)"}
                    {p.category && (
                      <span className="text-ink-disabled"> · {p.category}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink">
                    {p.conversions.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink-secondary">
                    {p.value.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="max-w-[70ch] text-xs text-ink-tertiary">
        A value that matches the conversion count almost exactly means every
        conversion was recorded at the same fixed amount — not what the guest
        paid.
      </p>
    </div>
  );
}
