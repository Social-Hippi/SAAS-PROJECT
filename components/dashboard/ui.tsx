import React from "react";

// Shared dashboard primitives. Extracted so new analytics surfaces inherit the
// existing visual language exactly instead of re-deriving it — same markup and
// same classes the channel view already uses.

export function Panel({ title, actions, children }: { title?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-card border border-line bg-card">
      {title && (
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="text-sm font-medium text-ink">{title}</h3>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, muted }: { label: string; value: string; sub?: string; muted?: boolean }) {
  return (
    <div className="rounded-card border border-line bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${muted ? "text-ink-tertiary" : "text-ink"}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-tertiary">{sub}</p>}
    </div>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <Panel>
      <div className="px-4 py-12 text-center">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-ink-tertiary">{body}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </Panel>
  );
}

export function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="ht-table w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-ink-tertiary">
          <tr>
            {head.map((h, i) => (
              <th key={h} className={`px-4 py-2 font-medium ${i === 0 ? "" : "text-right"}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const td = "px-4 py-2.5 text-right tabular-nums text-ink-secondary";
export const tdName = "px-4 py-2.5 text-ink";

/** Confidence chip using the backend's own MatchConfidence vocabulary. */
export function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  const map: Record<string, { dot: string; label: string }> = {
    DETERMINISTIC: { dot: "bg-success", label: "Deterministic" },
    STRONG: { dot: "bg-success", label: "Strong" },
    PARTIAL: { dot: "bg-warning", label: "Partial" },
    UNKNOWN: { dot: "bg-danger", label: "Unknown" },
  };
  const m = confidence ? map[confidence] : null;
  if (!m) return <span className="text-xs text-ink-tertiary">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-secondary">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${m.dot}`} aria-hidden />
      {m.label}
    </span>
  );
}

/**
 * Renders an unavailable metric honestly. "Not tracked" and "0" mean completely
 * different things and this is the component that keeps them apart.
 */
export function NotTracked({ reason }: { reason: string }) {
  return (
    <span className="text-sm text-ink-tertiary" title={reason}>
      Not tracked
    </span>
  );
}
