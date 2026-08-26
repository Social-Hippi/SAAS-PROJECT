import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { getCurrentMember } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { loadInfluencerPerformance } from "@/lib/influencer-performance";
import { loadInfluencerJourneys, loadJourneyDetail, CONFIDENCE_REASON, METHOD_LABEL } from "@/lib/influencer-journeys";
import { formatMoney, formatNumber, formatPercent } from "@/lib/format";
import { Panel, Stat, StatGrid, Table, td, tdName, ConfidenceBadge } from "@/components/dashboard/ui";
import { CopyButton } from "@/components/ui/CopyButton";

// Individual influencer — performance summary, the journeys attributed to them,
// and (when one is selected) that journey's timeline of PERSISTED events.

const DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

export default async function InfluencerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ influencerId: string }>;
  searchParams: Promise<{ range?: string; hotel?: string; journey?: string }>;
}) {
  const member = await getCurrentMember();
  if (!member) redirect("/agency/onboarding");
  const { influencerId } = await params;
  const sp = await searchParams;

  const days = DAYS[sp.range ?? "30d"] ?? 30;
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);

  const hotels = await agencyScoped(prisma.hotelClient).findMany({ select: { id: true, name: true } });
  const hotelIds = sp.hotel && hotels.some((h) => h.id === sp.hotel) ? [sp.hotel] : undefined;

  const [data, perf] = await Promise.all([
    loadInfluencerJourneys({ agencyId: member.agencyId, influencerId, hotelClientIds: hotelIds, since, until }),
    loadInfluencerPerformance({ agencyId: member.agencyId, influencerId, hotelClientIds: hotelIds, since, until }),
  ]);
  if (!data) notFound();

  const row = perf.rows.find((r) => r.influencerId === influencerId);
  const detail = sp.journey
    ? await loadJourneyDetail({ agencyId: member.agencyId, sessionId: sp.journey })
    : null;

  const back = `/agency/influencers/performance${sp.range ? `?range=${sp.range}` : ""}`;
  const money = (v: number | null, c: string | null) => (v == null ? "—" : formatMoney(v, c, { compact: true }));

  return (
    <div className="space-y-6">
      <div>
        <Link href={back} className="text-sm text-ink-tertiary hover:underline">← Influencer Performance</Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {data.influencer.name}
          {data.influencer.archived && <span className="ml-2 text-sm font-normal text-ink-tertiary">(archived)</span>}
        </h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          {data.influencer.platform ?? "—"}
          {data.influencer.instagramHandle ? ` · @${data.influencer.instagramHandle}` : ""}
          {data.influencer.campaigns.length ? ` · ${data.influencer.campaigns.join(", ")}` : ""}
        </p>
      </div>

      {/* Summary */}
      <StatGrid>
        <Stat label="Sessions" value={formatNumber(row?.sessions ?? 0)} />
        {perf.availability.bookingEngine.state === "available" ? (
          <Stat label="Booking engine visits" value={formatNumber(row?.bookingEngineVisits ?? 0)} />
        ) : (
          <Stat label="Booking engine visits" value="Not tracked" sub={perf.availability.bookingEngine.reason} muted />
        )}
        <Stat label="Confirmed bookings" value={formatNumber(row?.confirmedBookings ?? 0)} />
        {perf.availability.bookings.state === "available" ? (
          <Stat
            label="Attributed revenue"
            value={row?.mixedCurrency ? "Mixed currencies" : money(row?.attributedRevenue ?? null, row?.currency ?? null)}
            sub={row?.confirmedBookings ? `${formatPercent((row.confirmedBookings || 0) / Math.max(1, row.sessions))} of sessions` : undefined}
          />
        ) : (
          <Stat label="Attributed revenue" value="Not tracked" sub={perf.availability.bookings.reason} muted />
        )}
      </StatGrid>

      {/* Attribution evidence: tracked link and/or coupon */}
      <Panel title="Attribution evidence">
        <div className="space-y-3 p-4">
          {data.influencer.trackedUrls.map((u) => (
            <div key={u.contentPieceId} className="space-y-1">
              <p className="text-sm text-ink">Tracked link ✓ <span className="text-ink-tertiary">· {u.title}</span></p>
              <div className="flex items-start gap-2">
                <code className="block flex-1 overflow-x-auto break-all rounded-lg border border-line bg-code px-3 py-2 text-xs text-codeink">
                  {u.utmLink}
                </code>
                <CopyButton text={u.utmLink} />
              </div>
            </div>
          ))}
          {data.influencer.coupons.length > 0 ? (
            <p className="text-sm text-ink">
              {data.influencer.coupons.map((c) => (
                <span key={c.code} className="mr-3">
                  Coupon <span className="font-medium">{c.code}</span> ✓
                  <span className="ml-1 text-xs text-ink-tertiary">
                    {c.status}
                    {c.validFrom && c.validFrom > new Date() ? " · not valid yet" : ""}
                  </span>
                </span>
              ))}
            </p>
          ) : (
            <p className="text-sm text-ink-tertiary">No coupon code issued to this influencer.</p>
          )}
          <p className="text-xs text-ink-tertiary">
            A booking reached through both the link and the coupon is still one booking and one revenue
            record — coupon redemptions and booking revenue are reported as separate streams and never added together.
          </p>
        </div>
      </Panel>

      {/* Journeys */}
      <Panel title="Customer journeys">
        {data.journeys.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm font-medium text-ink">No journeys in this period</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-ink-tertiary">
              A journey appears here as soon as someone visits through this influencer&apos;s tracked link.
            </p>
          </div>
        ) : (
          <Table head={["Journey", "Started", "Landing", "Pages", "Booking engine", "Booking", "Revenue", "Attribution"]}>
            {data.journeys.map((j) => (
              <tr key={j.sessionId} className="border-t border-line hover:bg-page/50">
                <td className={tdName}>
                  <Link
                    href={`/agency/influencers/performance/${influencerId}?${new URLSearchParams({
                      ...(sp.range ? { range: sp.range } : {}),
                      ...(sp.hotel ? { hotel: sp.hotel } : {}),
                      journey: j.sessionId,
                    }).toString()}`}
                    className="font-medium hover:underline"
                  >
                    {j.ref}
                  </Link>
                  <div className="text-xs text-ink-tertiary">
                    {j.firstTouchSource ?? "—"} / {j.firstTouchMedium ?? "—"}
                  </div>
                </td>
                <td className={td}>{j.startedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                <td className={td}>{j.landingPath}</td>
                <td className={td}>{formatNumber(j.pageViews)}</td>
                <td className={td}>{j.reachedBookingEngine ? "Reached" : "Not captured"}</td>
                <td className={td}>{j.bookingStatus ?? "Not captured"}</td>
                <td className={td}>{j.revenue == null ? "—" : formatMoney(j.revenue, j.currency)}</td>
                <td className="px-4 py-2.5 text-right"><ConfidenceBadge confidence={j.confidence} /></td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      {/* Journey timeline */}
      {detail && (
        <Panel title={`Journey ${detail.journey.ref}`}>
          <div className="space-y-4 p-4">
            <ol className="space-y-0">
              {detail.stages.map((s, i) => (
                <li key={s.key} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${s.captured ? "bg-brand" : "bg-line-strong"}`} aria-hidden />
                    {i < detail.stages.length - 1 && <span className="w-px flex-1 bg-line" aria-hidden />}
                  </div>
                  <div className="pb-4">
                    <p className={`text-sm ${s.captured ? "text-ink" : "text-ink-tertiary"}`}>{s.label}</p>
                    <p className="text-xs text-ink-tertiary">
                      {s.captured ? (s.detail ?? "Recorded") : "Not captured"}
                      {s.at ? ` · ${s.at.toISOString().slice(0, 19).replace("T", " ")}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="rounded-card border border-line p-3">
              <p className="text-sm text-ink">
                <ConfidenceBadge confidence={detail.journey.confidence} />
              </p>
              <p className="mt-1 text-xs text-ink-tertiary">
                {detail.journey.confidence
                  ? CONFIDENCE_REASON[detail.journey.confidence]
                  : "This journey has no booking match yet."}
                {detail.journey.matchMethod
                  ? ` (${METHOD_LABEL[detail.journey.matchMethod] ?? detail.journey.matchMethod})`
                  : ""}
              </p>
              {detail.journey.confidence && !detail.journey.attributable && (
                <p className="mt-1 text-xs text-ink-tertiary">
                  Below the attribution confidence floor — shown as evidence, not counted as attributed revenue.
                </p>
              )}
            </div>

            {detail.pages.length > 0 && (
              <Table head={["Page", "Stage", "Viewed"]}>
                {detail.pages.map((p, i) => (
                  <tr key={`${p.path}-${i}`} className="border-t border-line">
                    <td className={tdName}>{p.path}</td>
                    <td className={td}>{p.stage ?? "—"}</td>
                    <td className={td}>{p.at.toISOString().slice(0, 19).replace("T", " ")}</td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}
