// Client-safe source constants + guard. NO "use client", no React — so the
// server component that resolves ?source= and the client component that renders
// the dropdown can share one definition.
//
// This split is not stylistic. Marking the whole module "use client" and calling
// the guard from a server component throws at runtime ("Attempted to call
// isDashboardSource() from the server"), and TypeScript cannot see it. Same
// arrangement as lib/channel-view-types.ts and its ChannelSelector.

export const DASHBOARD_SOURCES = [
  { key: "summary", label: "Summary", hint: "Everything, at a glance" },
  { key: "website", label: "Website", hint: "Traffic and on-site behaviour" },
  { key: "meta_ads", label: "Meta Ads", hint: "Facebook and Instagram advertising" },
  { key: "google_ads", label: "Google Ads", hint: "Search and Performance Max" },
  { key: "socials", label: "Socials", hint: "Organic Instagram" },
] as const;

export type DashboardSource = (typeof DASHBOARD_SOURCES)[number]["key"];

export function isDashboardSource(v: unknown): v is DashboardSource {
  return typeof v === "string" && DASHBOARD_SOURCES.some((s) => s.key === v);
}
