import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { resolveRange } from "@/lib/attribution";
import { shareBaseUrl } from "@/lib/hotel-share";
import { shouldShowContactBanner } from "@/lib/agency-contact";
import { ContactInfoBanner } from "@/components/agency/ContactInfoBanner";
import { FullHotelDashboard } from "@/components/dashboard/FullHotelDashboard";
import { DateRangeSelector } from "./DateRangeSelector";
import { ReportMenu } from "./ReportMenu";
import { ShareLinkManager } from "./ShareLinkManager";
import { DeleteHotelDangerZone } from "./DeleteHotelDangerZone";

// The agency's view of ONE hotel.
//
// Every metric, chart, table and panel now lives in <FullHotelDashboard>, which
// the public /share/<uuid> report renders too. That is the point: the hotel's
// link and the agency's page are the same component, so a panel cannot be added
// to one and quietly missing from the other. Only this file's chrome is
// agency-specific — the header, the share-link manager, and the danger zone.
//
// What stays HERE, and why none of it belongs on a public link:
//   • navigation into agency-only pages (team, integrations, exports)
//   • ShareLinkManager — mints and revokes the very credential the reader holds
//   • DeleteHotelDangerZone — a destructive write, admin-only
//   • ContactInfoBanner — a nudge about the AGENCY's own missing profile fields
//
// Multi-tenancy is unchanged: the hotel is resolved through agencyScoped, so one
// agency still cannot open another's hotel, and every query inside the shared
// component is scoped by agencyId AND hotelClientId.

export default async function HotelDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const member = await getCurrentMember();
  if (!member) redirect("/agency/onboarding");

  // Multi-tenant: scope by id AND agencyId so one agency can't open another's
  // hotel. The shared component re-resolves the full row for its own queries;
  // this lookup is what decides whether the page exists AT ALL for this member.
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id },
    select: { id: true, name: true, websiteUrl: true, lastSyncedAt: true },
  });
  if (!hotel) notFound();

  // The hotel's ONLY access path: a public /share/<token> report link. At most
  // one live link per hotel (createShareLink revokes the previous one), so take
  // the newest non-revoked row. Agency-scoped like every other read here.
  const activeShareLink = await agencyScoped(prisma.shareLink).findFirst({
    where: { hotelClientId: hotel.id, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      token: true,
      passwordHash: true,
      expiresAt: true,
      viewCount: true,
      lastViewedAt: true,
    },
  });
  const shareLink = activeShareLink
    ? {
        id: activeShareLink.id,
        token: activeShareLink.token,
        hasPassword: activeShareLink.passwordHash !== null,
        expiresAt: activeShareLink.expiresAt.toISOString(),
        expired: activeShareLink.expiresAt.getTime() < Date.now(),
        viewCount: activeShareLink.viewCount,
        lastViewedAt: activeShareLink.lastViewedAt?.toISOString() ?? null,
      }
    : null;

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  // Resolved here only to drive DateRangeSelector's current selection; the
  // dashboard resolves the same params itself from the same helper.
  const range = resolveRange({
    range: one(sp.range),
    from: one(sp.from),
    to: one(sp.to),
  });

  // Header strip — hotel + last sync (left), period selector + actions (right).
  const header = (
    <div className="space-y-4">
      <Link href="/agency/hotels" className="text-sm text-ink-tertiary hover:underline">
        ← Hotel Clients
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{hotel.name}</h1>
          <p className="mt-0.5 text-sm text-ink-tertiary">
            {hotel.websiteUrl}
            {hotel.lastSyncedAt && (
              <span className="ml-2 text-ink-disabled">
                · Last synced{" "}
                {new Date(hotel.lastSyncedAt).toLocaleString("en-IN", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-col items-end">
            <DateRangeSelector
              current={range.key}
              fromInput={range.fromInput}
              toInput={range.toInput}
            />
            <span className="mt-1 text-xs text-ink-disabled">vs previous period</span>
          </div>
          <Link
            href={`/agency/hotel/${hotel.id}/team`}
            className="rounded-button border border-line-strong bg-elevated px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-line-strong"
          >
            Hotel access
          </Link>
          <Link
            href={`/agency/hotel/${hotel.id}/integrations`}
            className="rounded-button border border-line-strong bg-elevated px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-line-strong"
          >
            Manage Integrations
          </Link>
          <ReportMenu
            hotelId={hotel.id}
            from={range.fromInput}
            to={range.toInput}
          />
        </div>
      </div>

      {/* Non-blocking nudge for existing (pre-deploy) agencies missing contact
          info. New signups never see it (their signup required the info). */}
      {shouldShowContactBanner(member.agency) && <ContactInfoBanner />}
    </div>
  );

  const footer = (
    <>
      {/* Shareable read-only dashboard link for the hotel owner. This is the
          credential factory for the /share view — it never appears on it. */}
      <section className="overflow-hidden rounded-card border border-line bg-card shadow-card">
        <div className="border-b border-line px-4 py-3">
          <h2 className="font-medium">Share with hotel</h2>
          <p className="mt-0.5 text-sm text-ink-tertiary">
            A private, read-only dashboard the hotel owner can open on any browser — no
            login required. They see this hotel&apos;s full performance picture, and only
            this hotel&apos;s data.
          </p>
        </div>
        <ShareLinkManager
          hotelId={hotel.id}
          shareBaseUrl={shareBaseUrl()}
          link={shareLink}
        />
      </section>

      {/* Danger Zone — admins only. Analysts never see it (UX); the action
          re-checks the role server-side regardless. */}
      {member.role === "admin" && (
        <DeleteHotelDangerZone hotelId={hotel.id} hotelName={hotel.name} />
      )}
    </>
  );

  return (
    <FullHotelDashboard
      hotelId={hotel.id}
      agencyId={member.agencyId}
      agencyName={member.agency.name}
      agencyPlan={member.agency.plan}
      agencyContact={member.agency}
      viewer="agency"
      // The agency always sees its own spend; showAdSpendToHotel governs the
      // hotel-facing share link, never this page.
      showAdSpend
      basePath={`/agency/hotel/${hotel.id}`}
      channelBackHref="/agency/hotels"
      channelBackLabel="← Hotel Clients"
      apiBase="/api/agency/hotels"
      rangeParam={one(sp.range)}
      fromParam={one(sp.from)}
      toParam={one(sp.to)}
      postTypeParam={one(sp.postType)}
      channelParam={one(sp.channel)}
      sourceParam={one(sp.source)}
      canEditAgencyContact={member.role === "admin"}
      headerSlot={header}
      footerSlot={footer}
    />
  );
}
