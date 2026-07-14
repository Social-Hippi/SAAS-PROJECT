import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { isAllowedStaffEmail } from "@/lib/access";
import { OnboardingClient } from "./OnboardingClient";

export default async function OnboardingPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const member = await prisma.agencyMember.findUnique({
    where: { clerkId: userId },
  });
  const user = await currentUser();

  // Defense-in-depth for the authoritative gate in createAgencyForCurrentUser:
  // a non-staff email that somehow reaches onboarding never even sees the form.
  // Already-provisioned members pass through (OnboardingClient forwards them on),
  // so an existing staff admin is never blocked here.
  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress ??
    "";
  if (!member && !isAllowedStaffEmail(email)) {
    return (
      <main className="flex flex-1 items-center justify-center py-12">
        <div className="mx-auto max-w-md rounded-2xl border border-line bg-card p-8 text-center">
          <h1 className="text-lg font-semibold text-ink">Access restricted</h1>
          <p className="mt-3 text-sm text-ink-tertiary">
            HotelTrack access is limited to Social Hippi staff accounts. This
            account isn&apos;t eligible to create an agency. If you believe this
            is a mistake, contact your administrator.
          </p>
        </div>
      </main>
    );
  }

  const suggestedName = user?.firstName
    ? `${user.firstName}'s Agency`
    : "My Agency";

  return (
    <main className="flex flex-1 items-center justify-center py-12">
      <OnboardingClient
        alreadyMember={Boolean(member)}
        suggestedName={suggestedName}
      />
    </main>
  );
}
