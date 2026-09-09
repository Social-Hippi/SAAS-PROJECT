import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { listHotelMembershipsForCurrentUser } from "@/lib/hotel-access";
import { HOTEL_ROLE_LABEL } from "@/lib/hotel-capabilities";

// Landing route for a hotel-side user.
//
// A person may hold more than one property (a group owner with three hotels),
// which is why HotelMember does not make clerkId globally unique. So this route
// resolves what they actually have rather than assuming one:
//
//   0 hotels → an explanation, not a 404. Reaching here signed-in with no grant
//              is a real situation (an agency removed access, or the invitation
//              was never accepted), and a bare 404 leaves the person with
//              nothing to do about it.
//   1 hotel  → straight through. The overwhelmingly common case should not cost
//              a click.
//   2+       → pick one.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your hotels · HotelTrack",
  robots: { index: false, follow: false },
};

export default async function HotelIndexPage() {
  const memberships = await listHotelMembershipsForCurrentUser();

  if (memberships.length === 1) {
    redirect(`/hotel/${memberships[0].hotelClientId}/dashboard`);
  }

  if (memberships.length === 0) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-lg font-semibold tracking-tight text-ink">
          You don&apos;t have access to a hotel yet
        </h1>
        <p className="mt-2 text-sm text-ink-secondary">
          Your agency gives you access to a hotel by sending an invitation to your email
          address. If you were expecting access, check for that email — or ask them to
          send it again.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block text-sm font-medium text-brand hover:underline"
        >
          Back to HotelTrack
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl py-8">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Your hotels</h1>
      <p className="mt-1 text-sm text-ink-tertiary">Choose a hotel to see how it&apos;s performing.</p>
      <ul className="mt-6 space-y-2">
        {memberships.map((m) => (
          <li key={m.hotelClientId}>
            <Link
              href={`/hotel/${m.hotelClientId}/dashboard`}
              className="flex items-center justify-between rounded-card border border-line bg-card px-4 py-3 shadow-card transition hover:border-line-strong hover:shadow-card-hover"
            >
              <span className="font-medium text-ink">{m.hotelName}</span>
              <span className="text-xs text-ink-tertiary">
                {m.role.kind === "hotel" ? HOTEL_ROLE_LABEL[m.role.role] : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
