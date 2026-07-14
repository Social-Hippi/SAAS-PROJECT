import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { UserButton } from "@clerk/nextjs";
import { AgencySidebar, AgencyMobileNav } from "@/components/nav/AgencySidebar";
import { getCurrentMember } from "@/lib/auth";
import { isAllowedStaffEmail } from "@/lib/access";
import { hasDashboardAccess } from "@/lib/plans";
import { BILLING_ENABLED } from "@/lib/billing-config";
import { mustCompleteContactInfo } from "@/lib/agency-contact";

// Shell for the signed-in agency app (dashboard, hotel clients, …). Onboarding
// and billing live OUTSIDE this group so they aren't gated by the subscription
// check below (otherwise billing would redirect to itself).
export default async function AgencyAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const member = await getCurrentMember();
  if (!member) redirect("/agency/onboarding");

  // AUTHORITATIVE staff gate mirrored for the UX: a member provisioned before the
  // access lockdown whose email is not a Social Hippi staff address is denied all
  // agency data. getAgencyContext() already throws for them on every scoped read
  // (so the API is closed regardless); here we render the same "Access restricted"
  // state as onboarding so a human sees the message instead of an error boundary.
  // A valid @socialhippi.com member passes and reaches the dashboard unchanged.
  if (!isAllowedStaffEmail(member.email)) {
    return (
      <main className="flex flex-1 items-center justify-center py-12">
        <div className="mx-auto max-w-md rounded-2xl border border-line bg-card p-8 text-center">
          <h1 className="text-lg font-semibold text-ink">Access restricted</h1>
          <p className="mt-3 text-sm text-ink-tertiary">
            HotelTrack access is limited to Social Hippi staff accounts. This
            account isn&apos;t eligible to access agency data. If you believe this
            is a mistake, contact your administrator.
          </p>
        </div>
      </main>
    );
  }

  // A super admin can suspend an agency independently of billing — block here.
  if (member.agency.suspendedAt) {
    redirect("/agency/suspended");
  }

  // New signups (created after this feature shipped) must provide contact info
  // before reaching the dashboard. The step lives outside this layout group, so
  // redirecting here can't loop. Existing agencies are never blocked (they get a
  // dismissible banner instead — see lib/agency-contact.ts).
  if (mustCompleteContactInfo(member.agency)) {
    redirect("/agency/onboarding/contact");
  }

  // Gate the whole agency dashboard behind an active subscription. While
  // inactive, the agency can still reach Billing (it lives outside this layout
  // group) and Settings, so they can pay or manage their account — everything
  // else bounces to Billing. The pathname is provided by proxy.ts.
  //
  // During the free beta (BILLING_ENABLED=false) hasDashboardAccess() returns
  // true for everyone, so this redirect never fires and signed-in users go
  // straight to the dashboard. Flipping BILLING_ENABLED back on restores the
  // original subscription gate unchanged.
  if (!hasDashboardAccess(member.agency.subscriptionStatus)) {
    const pathname = (await headers()).get("x-pathname") ?? "";
    if (!pathname.startsWith("/agency/settings")) {
      redirect("/agency/billing?inactive=1");
    }
  }

  return (
    <div className="flex min-h-full">
      <AgencySidebar billingEnabled={BILLING_ENABLED} />
      <div className="flex min-h-full min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-line bg-page/80 px-4 backdrop-blur sm:px-6 lg:px-8">
          <div className="min-w-0">
            <p className="text-xs text-ink-tertiary">Welcome back</p>
            <p className="truncate text-base font-semibold tracking-tight text-ink">
              {member.agency.name}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <UserButton />
          </div>
        </header>
        <AgencyMobileNav billingEnabled={BILLING_ENABLED} />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
