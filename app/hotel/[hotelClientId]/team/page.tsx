import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireHotelCapability } from "@/lib/hotel-access";
import { HOTEL_ROLES } from "@/lib/hotel-capabilities";
import { loadHotelTeam, REMOVE_REFUSAL_MESSAGE, type RemoveRefusal } from "@/lib/hotel-team";
import { HotelTeamList } from "@/components/hotel/HotelTeamList";
import { InviteHotelUserForm } from "@/components/hotel/InviteHotelUserForm";
import {
  inviteToMyHotelAction,
  removeMyHotelMemberAction,
  revokeMyHotelInviteAction,
} from "./actions";

// The hotel's own people page.
//
// This exists because HOTEL_ROLE_DESCRIPTION promises an owner "editing hotel
// details and inviting other people to this hotel", and that promise is made to
// the agency admin at the moment they choose someone's access level. Editing
// details was real; inviting was not — manageTeam was granted to hotel_owner and
// the only surface that used it was the agency's, behind requireAdmin(). The
// owner was told they could do something the product gave them nowhere to do.
//
// notFound() rather than a redirect for a caller without manageTeam: a manager
// or marketing user should not learn that a page exists which they cannot use,
// and 404 is what every other hotel-side denial returns.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "People · HotelTrack",
  robots: { index: false, follow: false },
};

function refusalMessage(v: string | undefined): string | null {
  // Only a value from the closed set renders. Anything else is a crafted link.
  return v && v in REMOVE_REFUSAL_MESSAGE ? REMOVE_REFUSAL_MESSAGE[v as RemoveRefusal] : null;
}

export default async function MyHotelTeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ hotelClientId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { hotelClientId } = await params;
  const access = await requireHotelCapability(hotelClientId, "manageTeam");
  if (!access) notFound();

  const sp = await searchParams;
  const raw = sp.refused;
  const refused = refusalMessage(Array.isArray(raw) ? raw[0] : raw);

  const rows = await loadHotelTeam({
    agencyId: access.agencyId,
    hotelClientId: access.hotelClientId,
  });
  const now = new Date();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link
          href={`/hotel/${access.hotelClientId}/dashboard`}
          className="text-sm text-ink-tertiary hover:underline"
        >
          ← My dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">People</h1>
        <p className="text-sm text-ink-tertiary">
          Who at {access.hotelName} can sign in and see your results. Everyone here sees this
          hotel only.
        </p>
      </div>

      {refused && (
        <p role="alert" className="rounded-card border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-ink-secondary">
          {refused}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="overflow-hidden rounded-card border border-line bg-card shadow-card">
          <div className="border-b border-line px-4 py-3">
            <h2 className="font-medium text-ink">People with access</h2>
          </div>
          <HotelTeamList
            rows={rows}
            hotelClientId={access.hotelClientId}
            now={now}
            removeAction={removeMyHotelMemberAction}
            revokeAction={revokeMyHotelInviteAction}
            emptyHint="Invite your team and they'll see the same results you do."
          />
        </section>

        <section className="rounded-card border border-line bg-card p-4 shadow-card">
          <h2 className="font-medium text-ink">Invite someone</h2>
          <p className="mt-1 text-sm text-ink-tertiary">
            They&apos;ll get an email with a link that works once and expires in 14 days.
          </p>
          <div className="mt-4">
            {/* All three levels, including a second Owner. Co-owners are ordinary
                at a hotel — a proprietor and a general manager — and an owner who
                cannot appoint another is one lost password away from a property
                nobody can administer. */}
            <InviteHotelUserForm
              hotelClientId={access.hotelClientId}
              action={inviteToMyHotelAction}
              roles={HOTEL_ROLES}
              defaultRole="hotel_manager"
            />
          </div>
        </section>
      </div>
    </div>
  );
}
