"use client";

import { useState } from "react";
import {
  ATTRIBUTION_MODELS,
  type AttributionModel,
  type ChannelRow,
} from "@/lib/attribution";
import { ChannelPerformanceTable } from "./ChannelPerformanceTable";

// The flagship attribution view. Holds the model toggle state; all three
// model result sets are precomputed server-side and passed in `byModel`, so
// switching is instant (no DB round-trip, no navigation). Default = First-Touch;
// never auto-switches.

export function AttributionPanel({
  byModel,
  showRoas = true,
}: {
  byModel: Record<AttributionModel, ChannelRow[]>;
  /** Passed through to the table; false when ad spend is withheld. */
  showRoas?: boolean;
}) {
  const [model, setModel] = useState<AttributionModel>("first");
  const active = ATTRIBUTION_MODELS.find((m) => m.id === model)!;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-tertiary">
            Channel performance
          </h2>
          <p className="mt-0.5 text-sm text-ink-tertiary">
            Bookings &amp; revenue credited per channel — recalculated live by the
            attribution model.
          </p>
        </div>

        {/* Segmented model toggle */}
        <div className="inline-flex rounded-lg border border-line bg-card p-0.5">
          {ATTRIBUTION_MODELS.map((m) => {
            const on = m.id === model;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setModel(m.id)}
                aria-pressed={on}
                title={m.question}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  on
                    ? "bg-elevated text-ink shadow-[0_1px_2px_rgba(0,0,0,0.3)]"
                    : "text-ink-tertiary hover:text-ink-secondary"
                }`}
              >
                {m.name}
                <span className="ml-1 hidden font-normal text-ink-disabled sm:inline">
                  · {m.lens}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-ink-tertiary">
        <span className="font-semibold text-ink-secondary">{active.name}</span>{" "}
        ({active.lens}) — {active.question}
      </p>

      <ChannelPerformanceTable rows={byModel[model]} showRoas={showRoas} />
    </section>
  );
}
