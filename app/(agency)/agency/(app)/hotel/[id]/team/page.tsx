import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { loadHotelTeam } from "@/lib/hotel-team";
import { HOTEL_ROLES } from "@/lib/hotel-capabilities";
import { HotelTeamList } from "@/components/hotel/HotelTeamList";
import { InviteHotelUserForm } from "@/components/hotel/InviteHotelUserForm";
import {
  inviteHotelUserAction,
  removeHotelMemberAction,
  revokeHotelInviteAction,
} from "./actions";

// Who can see this hotel — the AGENCY's view of it.
//
// Admin-only, matching the other per-hotel configuration surfaces. A non-admin
// gets notFound() rather than a redirect, so the page's existence is not
// confirmed to someone who may not act on it.
//
// The list and the form are the same components the hotel's own People page
// renders. Only the bound actions differ, which is exactly the difference that
// matters: this one is gated on requireAdmin(), that one on the hotel-side
// manageTeam capability.

export const dynamic = "force-dynamic";

export default async function HotelTeamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const member = await requireAdmin();
  if (!member) notFound();

  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id },
    select: { id: true, name: true },
  });
  if (!hotel) notFound();

  const rows = await loadHotelTeam({ agencyId: member.agencyId, hotelClientId: hotel.id });
  const now = new Date();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href={`/agency/hotel/${hotel.id}`} className="text-sm text-ink-tertiary hover:underline">
          ← {hotel.name}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Hotel access</h1>
        <p className="text-sm text-ink-tertiary">
          People at {hotel.name} who can sign in and see their own performance. They see only
          this hotel — never your other clients, and never your agency settings.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="overflow-hidden rounded-card border border-line bg-card shadow-card">
          <div className="border-b border-line px-4 py-3">
            <h2 className="font-medium text-ink">People with access</h2>
          </div>
          <HotelTeamList
            rows={rows}
            hotelClientId={hotel.id}
            now={now}
            removeAction={removeHotelMemberAction}
            revokeAction={revokeHotelInviteAction}
            emptyHint="Invite them and they'll be able to see their own results."
          />
        </section>

        <section className="rounded-card border border-line bg-card p-4 shadow-card">
          <h2 className="font-medium text-ink">Invite someone</h2>
          <p className="mt-1 text-sm text-ink-tertiary">
            They&apos;ll get an email with a link that works once and expires in 14 days.
          </p>
          <div className="mt-4">
            <InviteHotelUserForm
              hotelClientId={hotel.id}
              action={inviteHotelUserAction}
              roles={HOTEL_ROLES}
              defaultRole="hotel_owner"
            />
          </div>
        </section>
      </div>
    </div>
  );
}
