import type { Metadata } from "next";

// ACCESS LOCKDOWN: hotel self-signup is disabled. Hotels no longer get logins —
// they receive a read-only share link instead. This page now always shows a
// "signups closed" message; the completeHotelSignup action also hard-refuses.
// The original invite-code resolution + <JoinSignupForm> were removed here so no
// account-creating UI remains (the flow lives in git history if it must return).

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Signups closed · HotelTrack",
  robots: { index: false, follow: false },
};

export default async function JoinPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-16 text-center">
      <p className="text-xs font-semibold uppercase tracking-widest text-ink-disabled">HotelTrack</p>
      <h1 className="mt-3 text-xl font-semibold tracking-tight text-ink">Hotel signups are closed</h1>
      <p className="mt-2 text-sm text-ink-tertiary">
        HotelTrack no longer offers hotel logins. Your marketing agency will share a private,
        read-only dashboard link with you — please contact them for access.
      </p>
    </main>
  );
}
