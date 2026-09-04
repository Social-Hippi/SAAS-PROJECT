import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { acceptHotelInvite } from "@/lib/hotel-team";
import { HOTEL_ROLE_LABEL } from "@/lib/hotel-capabilities";

// Accept a per-person hotel invitation.
//
// The token in the URL is the credential. It is single-use, expires in 14 days,
// and only its SHA-256 is stored — so this page can verify it while a leaked
// database cannot be used to accept an outstanding invitation.
//
// A signed-OUT visitor is sent to Clerk and returned here, because acceptance
// needs a Clerk identity to attach the grant to. That round-trip is why the
// token has to survive in the URL rather than being consumed on first view.
//
// Every failure is a NAMED outcome with its own message (lib/hotel-user-invite):
// "this was cancelled", "this was already used" and "this expired" need
// different things said, and a generic error would leave the recipient with
// nothing to act on.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Accept invitation · HotelTrack",
  robots: { index: false, follow: false },
};

function Shell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md text-center">
        <Link
          href="/"
          className="text-2xl font-semibold tracking-tight text-ink transition hover:text-brand"
        >
          HotelTrack
        </Link>
        <div className="mt-8 rounded-card border border-line bg-card p-6 shadow-card">
          <h1 className="text-lg font-semibold tracking-tight text-ink">{title}</h1>
          {children}
        </div>
      </div>
    </main>
  );
}

export default async function AcceptHotelInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const { userId } = await auth();

  // Not signed in → Clerk, then straight back here with the token intact.
  if (!userId) {
    const back = encodeURIComponent(`/hotel-invite/${token}`);
    redirect(`/sign-in?redirect_url=${back}`);
  }

  const user = await currentUser();
  const email =
    user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? "";
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || email || "Team member";

  const result = await acceptHotelInvite({
    token,
    clerkId: userId,
    userEmail: email,
    userName: name,
  });

  if (!result.ok) {
    return (
      <Shell title="This invitation can't be used">
        <p className="mt-2 text-sm text-ink-secondary">{result.message}</p>
        {/* "already_used" is the one failure with a genuinely useful next step:
            the person very likely already has access. */}
        {result.reason === "already_used" && (
          <Link
            href="/hotel"
            className="mt-5 inline-block rounded-button bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-hover"
          >
            Go to my dashboard
          </Link>
        )}
      </Shell>
    );
  }

  return (
    <Shell title={`You now have access to ${result.hotelName}`}>
      <p className="mt-2 text-sm text-ink-secondary">
        You&apos;re set up as <strong>{HOTEL_ROLE_LABEL[result.role]}</strong>. You can see how
        your marketing is performing and where your guests are coming from.
      </p>
      <Link
        href={`/hotel/${result.hotelClientId}/dashboard`}
        className="mt-5 inline-block rounded-button bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-hover"
      >
        Open {result.hotelName}
      </Link>
    </Shell>
  );
}
