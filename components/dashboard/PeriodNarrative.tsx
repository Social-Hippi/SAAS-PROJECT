import type { RecommendedAction } from "@/lib/summary-templates";

// The period in words, and what to do about it.
//
// Both are built from templates with computed values and threshold conditions —
// no model call at render time. A generated sentence can assert something the
// data does not support, and this page is read by an owner deciding where to
// spend money.
//
// The actions are ranked by the SIZE of the thing behind them, not by the order
// they are written, so the biggest number is the first thing read. Fewer than
// three is a correct outcome when fewer than three conditions fire; nothing is
// padded to fill the box.

export function PeriodNarrative({
  sentences,
  actions,
  periodLabel,
  scopeLabel,
}: {
  sentences: string[];
  actions: RecommendedAction[];
  periodLabel: string;
  scopeLabel: string;
}) {
  if (sentences.length === 0 && actions.length === 0) return null;

  return (
    <section className="rounded-card border border-line bg-card p-4 shadow-card sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-medium text-ink">This period</h2>
        <p className="text-xs text-ink-tertiary">
          {scopeLabel} · {periodLabel}
        </p>
      </div>

      {sentences.length > 0 && (
        <div className="mt-3 space-y-2">
          {sentences.map((s) => (
            <p key={s} className="text-sm leading-relaxed text-ink-secondary">
              {s}
            </p>
          ))}
        </div>
      )}

      {actions.length > 0 && (
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary">
            What to do next
          </h3>
          <ol className="mt-2 space-y-2">
            {actions.map((a, i) => (
              <li key={a.id} className="flex gap-3 text-sm">
                <span className="mt-0.5 shrink-0 tabular-nums text-ink-disabled">{i + 1}.</span>
                <span className="min-w-0">
                  <span className="text-ink-secondary">{a.text}</span>{" "}
                  <span className="whitespace-nowrap rounded-full bg-elevated px-2 py-0.5 text-[11px] font-medium text-ink-tertiary">
                    {a.owner === "agency" ? "agency" : "property"}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
