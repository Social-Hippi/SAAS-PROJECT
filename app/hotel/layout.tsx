import { UserButton } from "@clerk/nextjs";
import {
  AppSidebar,
  AppMobileNav,
  IconDashboard,
  type NavItem,
} from "@/components/nav/AppSidebar";
import { listHotelMembershipsForCurrentUser } from "@/lib/hotel-access";

// Shell for the hotel-side product. No agency navigation: a hotel user sees
// their own property (or properties) and nothing about the agency's other
// clients. Per-hotel authorization is enforced inside each page by
// resolveHotelAccess — this layout only decides what to LINK to, and derives
// that from the same grants, so the nav can never offer a hotel the gate
// would refuse.
// The only nav is the logo, a "My Dashboard" link, and the Clerk account menu
// (profile / sign out). Nothing here exposes other hotels or agency operations.
export default async function HotelLayout({ children }: { children: React.ReactNode }) {
  // Navigation is derived from the user's actual GRANTS, not from a single
  // createdByUserId column. That column recorded who signed the hotel up; it
  // could not express a second person, a role, or more than one property.
  const memberships = await listHotelMembershipsForCurrentUser();
  const primary = memberships[0] ?? null;

  // With several properties the brand goes to the picker; with one it goes
  // straight to that hotel.
  const dashboardHref = primary
    ? memberships.length > 1
      ? "/hotel"
      : `/hotel/${primary.hotelClientId}/dashboard`
    : "/";

  const navItems: NavItem[] = primary
    ? [
        {
          href: memberships.length > 1 ? "/hotel" : `/hotel/${primary.hotelClientId}/dashboard`,
          label: memberships.length > 1 ? "My hotels" : "My dashboard",
          icon: IconDashboard,
        },
      ]
    : [];

  return (
    <div className="flex min-h-full">
      <AppSidebar brand={{ href: dashboardHref, label: "HotelTrack" }} items={navItems} />
      <div className="flex min-h-full min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-line bg-page/80 px-4 backdrop-blur sm:px-6 lg:px-8">
          <p className="truncate text-base font-semibold tracking-tight text-ink">
            {primary && memberships.length === 1 ? primary.hotelName : "Your hotels"}
          </p>
          <UserButton />
        </header>
        <AppMobileNav items={navItems} />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
