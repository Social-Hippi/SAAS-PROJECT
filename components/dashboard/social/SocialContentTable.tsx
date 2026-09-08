import { presentMetric } from "@/lib/metrics/present";
import type { SocialContentRow, SocialPerformance } from "@/lib/metrics/social-performance";

// Instagram formats side by side, so "make more reels" becomes an evidenced
// decision rather than a hunch.
//
// The impressions column disappears entirely when the account's Graph version
// stopped returning it — a column of "Not traceable" costs the reader attention
// to discover it is empty. Stories get their own row rather than their own
// table, because the comparison IS the point, but their unavailable measures
// stay explicitly unavailable: Instagram reports no likes, saves or shares on a
// story, and showing 0 would suggest nobody engaged.

function Cell({ metric, format }: { metric: SocialContentRow["reach"]; format?: "percent" }) {
  const p = presentMetric(metric, format ?? "number");
  return (
    <td
      className={`px-3 py-2.5 text-right tabular-nums ${p.known ? "text-ink" : "text-ink-disabled text-xs"}`}
      title={p.title}
    >
      {p.text}
    </td>
  );
}

export function SocialContentTable({ data }: { data: SocialPerformance }) {
  const rows = data.stories ? [...data.rows, data.stories] : data.rows;

  if (!data.connected) {
    return (
      <section className="overflow-hidden rounded-card border border-line bg-card shadow-card">
        <div className="border-b border-line px-4 py-3 sm:px-5">
          <h2 className="font-medium text-ink">Content performance by format</h2>
        </div>
        <p className="px-4 py-10 text-center text-sm text-ink-tertiary sm:px-5">
          Instagram isn&apos;t connected for this hotel yet.
        </p>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-card border border-line bg-card shadow-card">
      <div className="border-b border-line px-4 py-3 sm:px-5">
        <h2 className="font-medium text-ink">Content performance by format</h2>
        <p className="mt-0.5 text-sm text-ink-tertiary">
          Which kinds of post earn their place, ranked by reach.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-ink-tertiary sm:px-5">
          Nothing was published in this period.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="ht-table w-full text-left text-sm">
            <thead className="bg-elevated text-xs uppercase tracking-wide text-ink-tertiary">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Format</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Published</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Reach</th>
                {data.hasImpressions && (
                  <th scope="col" className="px-3 py-2 text-right font-medium">Impressions</th>
                )}
                <th scope="col" className="px-3 py-2 text-right font-medium">Likes</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Comments</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Saves</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Shares</th>
                <th
                  scope="col"
                  className="cursor-help px-3 py-2 text-right font-medium"
                  title="Total interactions ÷ reach."
                >
                  Engagement
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.type} className="border-t border-line">
                  <td className="px-3 py-2.5 font-medium text-ink">{r.label}</td>
                  <Cell metric={r.posts} />
                  <Cell metric={r.reach} />
                  {data.hasImpressions && <Cell metric={r.impressions} />}
                  <Cell metric={r.likes} />
                  <Cell metric={r.comments} />
                  <Cell metric={r.saves} />
                  <Cell metric={r.shares} />
                  <Cell metric={r.engagementRate} format="percent" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="border-t border-line bg-elevated/40 px-4 py-3 text-xs text-ink-tertiary sm:px-5">
        Profile visits and link clicks are reported by Instagram for the account as a whole, not
        per post, so they appear in the account figures rather than this table.
      </p>
    </section>
  );
}
