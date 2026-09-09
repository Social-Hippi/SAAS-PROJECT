import { UNASSIGNED_SEGMENT } from "@/lib/segments";

// Which of the group's properties the report is describing.
//
// Aster Holidays is one HotelClient covering Coffeeberry Hills and Three Hills,
// so "the hotel's numbers" is an ambiguous phrase until this is set. Plain links
// rather than a client-side control, for the same reason the period selector is:
// the public report must work with JavaScript off, and the selection has to
// survive being bookmarked and forwarded.
//
// The default is ALL PROPERTIES, and it shows them side by side rather than
// blended, because a single group figure hides which property is performing —
// which is the question an owner of two properties actually has.
//
// Rendered only when a group HAS more than one property. A single-property hotel
// gets no control, because there is nothing to choose.

export type PropertyOption = { id: string; name: string };

export function PropertySelector({
  basePath,
  options,
  current,
  preserve = {},
}: {
  basePath: string;
  options: PropertyOption[];
  /** Segment id, or null for all properties. */
  current: string | null;
  preserve?: Record<string, string | undefined>;
}) {
  if (options.length < 2) return null;

  const kept = Object.entries(preserve).filter(([, v]) => Boolean(v)) as [string, string][];
  const hrefFor = (id: string | null) => {
    const params = new URLSearchParams();
    for (const [k, v] of kept) params.set(k, v);
    if (id) params.set("property", id);
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  const chip = (active: boolean) =>
    `rounded-lg border px-3 py-1.5 text-sm font-medium ${
      active
        ? "border-brand bg-brand text-white"
        : "border-line-strong bg-elevated text-ink-secondary hover:bg-line-strong"
    }`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
        Property
      </span>
      <a href={hrefFor(null)} className={chip(current == null)}>
        All properties
      </a>
      {options.map((o) => (
        <a key={o.id} href={hrefFor(o.id)} className={chip(current === o.id)}>
          {o.name}
        </a>
      ))}
    </div>
  );
}

/**
 * The label for a segment id, including the two values that are not segments:
 * null (the whole group) and the Unassigned bucket.
 */
export function propertyLabel(
  id: string | null,
  options: readonly PropertyOption[],
): string {
  if (id == null) return "All properties";
  if (id === UNASSIGNED_SEGMENT) return "Shared pages";
  return options.find((o) => o.id === id)?.name ?? "All properties";
}
