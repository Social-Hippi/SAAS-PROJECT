import type { DataHealth } from "@/lib/data-health";

// Renders a data-health verdict. Presentation only — the verdict itself comes
// from lib/data-health.ts, so this component never decides whether a number can
// be trusted, only how to say it.
//
// Deliberately silent when everything is fine. A green "tracking is working"
// badge on every load trains people to stop reading the strip, which is exactly
// when the one that matters appears.

const TONE: Record<string, { border: string; bg: string; dot: string; label: string }> = {
  broken:        { border: "border-danger/40",  bg: "bg-danger/10",  dot: "bg-danger",  label: "Needs attention" },
  not_installed: { border: "border-warning/40", bg: "bg-warning/10", dot: "bg-warning", label: "Setup incomplete" },
  never_received:{ border: "border-warning/40", bg: "bg-warning/10", dot: "bg-warning", label: "Not confirmed" },
  not_connected: { border: "border-info/40",    bg: "bg-info/10",    dot: "bg-info",    label: "Not connected" },
  stale:         { border: "border-warning/40", bg: "bg-warning/10", dot: "bg-warning", label: "Out of date" },
};

export function DataHealthBanner({
  health,
  /** Who should act. Hotel users are told to ask; agency users are told to fix. */
  audience,
  agencyName,
}: {
  health: DataHealth;
  audience: "hotel" | "agency";
  agencyName?: string;
}) {
  // healthy and no_activity are both trustworthy: the second one means the zeros
  // on screen are real zeros, which is worth nothing as a banner.
  if (health.trustworthy) return null;

  const tone = TONE[health.state] ?? TONE.broken;

  // The action text is written for whoever can carry it out. Telling a hotel
  // owner to "check the snippet is still installed" sends them to a developer;
  // telling them who manages it for them is actionable.
  const action =
    audience === "agency" || !health.action
      ? health.action
      : agencyName
        ? `${agencyName} manages this — let them know so your numbers start updating again.`
        : "Your agency manages this — let them know so your numbers start updating again.";

  return (
    <section
      role="status"
      className={`rounded-card border ${tone.border} ${tone.bg} px-4 py-3 sm:px-5`}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">
            <span className="sr-only">{tone.label}: </span>
            {health.message}
          </p>
          {action && <p className="mt-0.5 text-sm text-ink-secondary">{action}</p>}
          <p className="mt-1.5 text-xs text-ink-tertiary">
            Figures below that depend on this are shown as — rather than 0, so a
            measurement gap is never mistaken for a real result.
          </p>
        </div>
      </div>
    </section>
  );
}
