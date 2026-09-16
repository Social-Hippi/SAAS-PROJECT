import type { Metadata } from "next";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { rateLimit, clientIpFromHeaders } from "@/lib/ratelimit";
import { resolveShareLink } from "@/lib/share-link-access";
import { runWithAgencyScope, agencyScoped } from "@/lib/tenant";
import { resolveRange } from "@/lib/attribution";
import { loadClientReport } from "@/lib/metrics/client-report";
import { ClientReport } from "@/components/dashboard/ClientReport";
import { WhatsAppAttribution } from "@/components/dashboard/WhatsAppAttribution";
import { loadWhatsAppAttribution } from "@/lib/metrics/whatsapp-attribution-report";
import { PeriodSelector } from "@/components/dashboard/PeriodSelector";
import { PasswordGate } from "./PasswordGate";

// Public, no-login view of a hotel's dashboard, addressed by an unguessable
// share token. Access is gated entirely inside this route (token validity,
// expiry, revocation, optional password) — never by a Clerk session.
//
// This renders the SAME <FullHotelDashboard> as /agency/hotel/[id]. It used to
// render a much smaller bespoke report, which meant the hotel saw five panels
// while its agency looked at twenty, and the two drifted apart with every change
// to either. Sharing the component makes the two views the same view.
//
// HOW A SESSION-LESS PAGE READS SESSION-SCOPED DATA. We hand the dashboard the
// agencyId read OFF THE ShareLink ROW — never from the URL — and it installs that
// as the request-scoped tenant override around its own body. agencyScoped()
// prefers the override over its Clerk lookup, so every query stays filtered by
// agencyId AND hotelClientId exactly as it is for the agency. The client
// components inside authenticate separately, by sending this token to
// /api/hotel/[id]/*, where requireShareLinkAccess re-checks the very same link.
//
// AD SPEND. `showAdSpend` carries the hotel's showAdSpendToHotel flag, so the
// agency's per-hotel choice still governs what a link-holder sees. The matching
// gate on the data routes is in lib/share-spend-gate.ts.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Hotel performance report · HotelTrack",
  robots: { index: false, follow: false }, // shared privately; keep out of search
};

function ShareMessage({ title, body }: { title: string; body: string }) {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center px-6 py-16 text-center">
      <p className="text-xs font-semibold uppercase tracking-widest text-ink-disabled">
        HotelTrack
      </p>
      <h1 className="mt-3 text-xl font-semibold tracking-tight text-ink">{title}</h1>
      <p className="mt-2 text-sm text-ink-tertiary">{body}</p>
    </main>
  );
}

export default async function SharePage({
  params,
  searchParams,
}: {
  params: Promise<{ uuid: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { uuid } = await params;

  // Per-IP throttle BEFORE any DB work, to blunt share-token enumeration. Fails
  // CLOSED (blocks on a store outage) — the safe choice for an unguessable link.
  const rl = await rateLimit("sharePage", clientIpFromHeaders(await headers()));
  if (!rl.ok) {
    return (
      <ShareMessage
        title="Too many requests"
        body="Please wait a moment and try again."
      />
    );
  }

  // ONE resolution of "is this link live", shared with the data routes the
  // dashboard's client components call — so the page and its data can never
  // disagree about whether the link still works.
  const resolution = await resolveShareLink(uuid);

  if (!resolution.ok) {
    switch (resolution.reason) {
      case "locked":
        return (
          <PasswordGate
            token={uuid}
            hotelName={resolution.link.hotelName}
            agencyName={resolution.link.agencyName}
          />
        );
      case "gone":
        // Hotel soft-deleted → the data is intentionally inaccessible (akin to
        // 410 Gone; a Server Component can't set a custom status).
        return (
          <ShareMessage
            title="No longer available"
            body="This hotel's data is no longer accessible."
          />
        );
      case "expired":
        return (
          <ShareMessage
            title="Link expired"
            body="This report link has expired. Please ask the agency to generate a fresh one."
          />
        );
      default:
        // Unknown token or revoked → don't reveal which; show a neutral message.
        return (
          <ShareMessage
            title="Link unavailable"
            body="This report link is no longer active. Please ask the agency for a new one."
          />
        );
    }
  }

  const { link } = resolution;

  // View tracking. Awaited so the write isn't dropped on a serverless runtime,
  // but never allowed to break the page if it fails.
  try {
    await prisma.shareLink.update({
      where: { id: link.linkId },
      data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
    });
  } catch {
    // ignore — a missed view count must never block the report
  }

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  // HOW A SESSION-LESS PAGE READS SESSION-SCOPED DATA. The agencyId comes off
  // the ShareLink ROW — never from the URL — and is installed as the
  // request-scoped tenant override. agencyScoped() prefers that override over
  // its Clerk lookup, so every query below stays filtered by agencyId AND
  // hotelClientId exactly as it is for the agency.
  const { range, report, whatsapp } = await runWithAgencyScope(link.agencyId, async () => {
    // The property's own timezone decides where a day starts. A report that cuts
    // days in UTC shows a hotelier figures that disagree with their own diary.
    const hotel = await agencyScoped(prisma.hotelClient).findFirst({
      where: { id: link.hotelClientId },
      select: { timezone: true },
    });
    const resolved = resolveRange(
      { range: one(sp.range), from: one(sp.from), to: one(sp.to) },
      { timezone: hotel?.timezone },
    );
    const [report, whatsapp] = await Promise.all([
      loadClientReport({
        hotelClientId: link.hotelClientId,
        range: resolved,
        showAdSpend: link.showAdSpend,
      }),
      // Renders nothing when the hotel has no Kraya connection, so a property
      // without WhatsApp reporting simply does not see the section.
      loadWhatsAppAttribution({
        agencyId: link.agencyId,
        hotelClientId: link.hotelClientId,
        range: resolved,
      }),
    ]);
    return { range: resolved, report, whatsapp };
  });

  return (
    <div className="min-h-full bg-page">
      <main className="mx-auto w-full max-w-6xl space-y-8 px-4 py-6 sm:px-6 lg:px-8">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-ink-disabled">
            HotelTrack
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
            {link.hotelName}
          </h1>
          {/* The agency attribution line is gone: this is the HOTEL's report about
              the hotel's own performance, and leading with who sent it framed it
              as the agency's document. The property and its domain identify it. */}
          <p className="mt-0.5 text-sm text-ink-tertiary">{link.websiteUrl}</p>
        </div>

        {/* PeriodSelector renders the chips, the literal date window ("Showing
            18 Aug – 16 Sep 2026 · times shown in Asia/Kolkata") and any clamp
            adjustments itself. This page adds none of them — doing so is how
            two controls end up disagreeing, and the first cut printed the
            window twice. */}
        <PeriodSelector basePath={`/share/${uuid}`} range={range} />

        <ClientReport data={report} showAdSpend={link.showAdSpend} />

        <WhatsAppAttribution
          data={whatsapp}
          periodLabel={range.dateLabel}
          timezone={range.timezone}
        />

        <p className="pt-2 text-center text-xs text-ink-disabled">
          Powered by HotelTrack · This is a private, read-only report.
        </p>
      </main>
    </div>
  );
}
