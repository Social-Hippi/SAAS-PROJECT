import Link from "next/link";

// Small connection-status indicators for the top of the hotel dashboard, plus a
// shared "not connected" empty state for the data sections.
//
// Both take an optional `manageHref`. With one, the badge/CTA navigates to that
// hotel's integrations page — the agency behaviour. With `null` the STATUS still
// renders but the control does not, which is what the public /share report needs:
// the reader should see that Meta is connected, but must not be handed a link
// into an agency-only page they'd only be bounced from.

export type BadgeState = "connected" | "warning" | "disconnected";

const ICON: Record<BadgeState, string> = { connected: "✓", warning: "⚠", disconnected: "✗" };
const CLS: Record<BadgeState, string> = {
  connected: "bg-success/15 text-success ring-success/30",
  warning: "bg-warning/15 text-warning ring-warning/30",
  disconnected: "bg-danger/15 text-danger ring-danger/30",
};
const LABEL: Record<BadgeState, string> = {
  connected: "connected",
  warning: "needs attention",
  disconnected: "not connected",
};

const BADGE_BASE = "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1";

export function IntegrationBadges({
  items,
  manageHref,
}: {
  items: { name: string; state: BadgeState }[];
  /** Integrations-page href, or null for a read-only (public) surface. */
  manageHref: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((it) => {
        const title = manageHref
          ? `${it.name} — ${LABEL[it.state]}. Manage on the integrations page.`
          : `${it.name} — ${LABEL[it.state]}.`;
        const body = (
          <>
            <span aria-hidden>{ICON[it.state]}</span>
            {it.name}
          </>
        );
        return manageHref ? (
          <Link
            key={it.name}
            href={manageHref}
            title={title}
            className={`${BADGE_BASE} transition hover:opacity-80 ${CLS[it.state]}`}
          >
            {body}
          </Link>
        ) : (
          <span key={it.name} title={title} className={`${BADGE_BASE} ${CLS[it.state]}`}>
            {body}
          </span>
        );
      })}
    </div>
  );
}

export function IntegrationEmptyState({
  title,
  body,
  cta,
  manageHref,
}: {
  title: string;
  body: string;
  cta: string;
  /** Integrations-page href, or null to render the explanation with no CTA. */
  manageHref: string | null;
}) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-tertiary">{body}</p>
      {manageHref && (
        <Link
          href={manageHref}
          className="mt-4 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover"
        >
          {cta}
        </Link>
      )}
    </div>
  );
}
