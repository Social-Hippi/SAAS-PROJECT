import type { Metadata } from "next";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { rateLimit, clientIpFromHeaders } from "@/lib/ratelimit";
import { resolveShareLink } from "@/lib/share-link-access";
import { FullHotelDashboard } from "@/components/dashboard/FullHotelDashboard";
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

const RANGES = [
  { key: "7", label: "7d" },
  { key: "30", label: "30d" },
  { key: "90", label: "90d" },
] as const;

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
  const rangeKey = one(sp.range) ?? "30";

  const header = (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-ink-disabled">
          HotelTrack
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
          {link.hotelName}
        </h1>
        <p className="mt-0.5 text-sm text-ink-tertiary">
          Report shared by {link.agencyName} · {link.websiteUrl}
        </p>
      </div>
      {/* Range selector. Plain links rather than the agency's DateRangeSelector:
          a custom from/to picker is a control the report doesn't need, and these
          survive with JavaScript off. */}
      <div className="flex gap-2">
        {RANGES.map((r) => (
          <a
            key={r.key}
            href={`/share/${uuid}?range=${r.key}`}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
              r.key === rangeKey
                ? "border-brand bg-brand text-white"
                : "border-line-strong bg-elevated text-ink-secondary hover:bg-line-strong"
            }`}
          >
            Last {r.label}
          </a>
        ))}
      </div>
    </div>
  );

  return (
    <div className="min-h-full bg-page">
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <FullHotelDashboard
          hotelId={link.hotelClientId}
          agencyId={link.agencyId}
          agencyName={link.agencyName}
          agencyPlan={link.agencyPlan}
          // The agency that OWNS this hotel — read off the ShareLink row, so a
          // reader always gets the agency managing them.
          agencyContact={link.agencyContact}
          viewer="share"
          showAdSpend={link.showAdSpend}
          basePath={`/share/${uuid}`}
          apiBase="/api/hotel"
          shareToken={uuid}
          rangeParam={one(sp.range)}
          postTypeParam={one(sp.postType)}
          channelParam={one(sp.channel)}
          headerSlot={header}
        />
        <p className="pt-6 text-center text-xs text-ink-disabled">
          Powered by HotelTrack · This is a private, read-only report.
        </p>
      </main>
    </div>
  );
}
