"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  DASHBOARD_SOURCES,
  type DashboardSource,
} from "@/lib/dashboard-sources";

// The dashboard's primary control: which part of the marketing picture the owner
// is looking at.
//
// It is a real <select> on every breakpoint, not a pill row that wraps to three
// lines on a phone. Five options is exactly the size where a dropdown beats
// tabs: enough to crowd a narrow screen, few enough that the native picker is
// instant. Desktop gets the same control with segmented styling beside it.
//
// Selection lives in ?source= so a view is bookmarkable and shareable, and
// switching preserves the date range — losing the period on every source change
// is the fastest way to make a dashboard feel broken.

export function SourceSelector({ current }: { current: DashboardSource }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function go(source: string) {
    const params = new URLSearchParams(searchParams.toString());
    // "summary" is the default view, so it stays out of the URL.
    if (source === "summary") params.delete("source");
    else params.set("source", source);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const active = DASHBOARD_SOURCES.find((s) => s.key === current) ?? DASHBOARD_SOURCES[0];

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2">
        <label
          htmlFor="dashboard-source"
          className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary"
        >
          Source
        </label>
        <select
          id="dashboard-source"
          value={current}
          onChange={(e) => go(e.target.value)}
          className="min-w-[11rem] rounded-lg border border-line-strong bg-card px-3 py-2 text-sm font-medium text-ink shadow-card focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
        >
          {DASHBOARD_SOURCES.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <p className="hidden text-sm text-ink-tertiary sm:block">{active.hint}</p>
    </div>
  );
}
