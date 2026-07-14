import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { rateLimit, clientIpFromHeaders } from "@/lib/ratelimit";
import { resolveRange } from "@/lib/attribution";
import { loadHotelReport } from "@/lib/report-data";
import { unlockCookieName, verifyUnlock } from "@/lib/share";
import { PasswordGate } from "./PasswordGate";
import { PublicReport } from "./PublicReport";

// Public, no-login view of a hotel's dashboard, addressed by an unguessable
// share token. Access is gated entirely inside this route (token validity,
// expiry, revocation, optional password) — never by a Clerk session.

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

  const link = await prisma.shareLink.findUnique({
    where: { token: uuid },
    select: {
      id: true,
      agencyId: true,
      hotelClientId: true,
      passwordHash: true,
      expiresAt: true,
      revokedAt: true,
      hotelClient: { select: { name: true, websiteUrl: true, deletedAt: true } },
      agency: { select: { name: true, suspendedAt: true } },
    },
  });

  // Unknown token or revoked → don't reveal which; show a neutral message.
  if (!link || link.revokedAt || link.agency.suspendedAt) {
    return (
      <ShareMessage
        title="Link unavailable"
        body="This report link is no longer active. Please ask the agency for a new one."
      />
    );
  }
  // Hotel soft-deleted → the data is intentionally inaccessible (akin to 410 Gone;
  // a Server Component can't set a custom status, so we render the message).
  if (link.hotelClient.deletedAt) {
    return (
      <ShareMessage
        title="No longer available"
        body="This hotel's data is no longer accessible."
      />
    );
  }
  if (link.expiresAt < new Date()) {
    return (
      <ShareMessage
        title="Link expired"
        body="This report link has expired. Please ask the agency to generate a fresh one."
      />
    );
  }

  // Optional password gate.
  if (link.passwordHash) {
    const jar = await cookies();
    const unlocked = verifyUnlock(uuid, jar.get(unlockCookieName(uuid))?.value);
    if (!unlocked) {
      return (
        <PasswordGate
          token={uuid}
          hotelName={link.hotelClient.name}
          agencyName={link.agency.name}
        />
      );
    }
  }

  // View tracking. Awaited so the write isn't dropped on a serverless runtime,
  // but never allowed to break the page if it fails.
  try {
    await prisma.shareLink.update({
      where: { id: link.id },
      data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
    });
  } catch {
    // ignore — a missed view count must never block the report
  }

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const range = resolveRange({ range: one(sp.range) });

  const report = await loadHotelReport({
    agencyId: link.agencyId,
    hotelId: link.hotelClientId,
    since: range.since,
    until: range.until,
    // Public share link: honour the hotel's showAdSpendToHotel flag. When it's
    // off, loadHotelReport strips spend + all spend-derived figures server-side.
    respectAdSpendFlag: true,
  });

  return (
    <PublicReport
      token={uuid}
      hotelName={link.hotelClient.name}
      websiteUrl={link.hotelClient.websiteUrl}
      agencyName={link.agency.name}
      rangeKey={range.key}
      rangeLabel={range.label}
      report={report}
    />
  );
}
