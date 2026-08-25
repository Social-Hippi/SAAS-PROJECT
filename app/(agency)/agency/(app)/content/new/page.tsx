import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { ContentForm } from "./ContentForm";

export default async function NewContentPage() {
  const member = await getCurrentMember();
  if (!member) redirect("/agency/onboarding");

  // Multi-tenant: agencyScoped injects { agencyId } automatically.
  const hotels = await agencyScoped(prisma.hotelClient).findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  // Track A: the influencer picker submits a real Influencer id, so the tracked
  // link resolves back by FOREIGN KEY instead of by display name. Archived
  // influencers are excluded — same rule the rest of the app's pickers use.
  const influencers = await agencyScoped(prisma.influencer).findMany({
    where: { archivedAt: null },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      instagramHandle: true,
      hotelClientId: true,
      couponCodes: {
        where: { status: "ACTIVE" },
        orderBy: { code: "asc" },
        select: { code: true, hotelClientId: true },
      },
    },
  });

  return (
    <div className="max-w-xl">
      <Link href="/agency/content" className="text-sm text-ink-tertiary hover:underline">
        ← Content
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">New Content Piece</h1>
      <p className="mt-1 mb-6 text-sm text-ink-tertiary">
        We&apos;ll generate a UTM-tagged link so visits and bookings from this
        content are attributed back to it.
      </p>

      {hotels.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line p-12 text-center">
          <p className="text-ink-tertiary">
            Add a hotel client before creating content.
          </p>
          <Link
            href="/agency/hotels/new"
            className="mt-4 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover"
          >
            Add a hotel client
          </Link>
        </div>
      ) : (
        <ContentForm hotels={hotels} influencers={influencers} />
      )}
    </div>
  );
}
