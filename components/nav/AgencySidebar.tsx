"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

// Agency app navigation. SAME items / routes as the previous top-bar nav — only
// the presentation changed (left sidebar on desktop, horizontal bar on mobile),
// with icon + label and an active state. Purely presentational.

const icon = (path: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-[18px] w-[18px] shrink-0"
    aria-hidden
  >
    {path}
  </svg>
);

const NAV: { href: string; label: string; icon: ReactNode }[] = [
  {
    href: "/agency/dashboard",
    label: "Dashboard",
    icon: icon(<><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>),
  },
  {
    href: "/agency/hotels",
    label: "Hotel Clients",
    icon: icon(<><path d="M3 21h18M5 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M15 21v-9h3a1 1 0 0 1 1 1v8" /><path d="M8 7h0M11 7h0M8 11h0M11 11h0M8 15h0M11 15h0" /></>),
  },
  {
    href: "/agency/influencers",
    label: "Influencers",
    icon: icon(<><path d="M12 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /><path d="M4 21a8 8 0 0 1 16 0" /></>),
  },
  {
    href: "/agency/influencers/performance",
    label: "Influencer Performance",
    icon: icon(<><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></>),
  },
  {
    href: "/agency/alerts",
    label: "Alerts",
    icon: icon(<><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>),
  },
  {
    href: "/agency/settings",
    label: "Settings",
    icon: icon(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>),
  },
  {
    href: "/agency/billing",
    label: "Billing",
    icon: icon(<><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></>),
  },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

// Hide the Billing item during the free beta (BILLING_ENABLED=false). The flag
// is read on the server and passed in, since this is a client component and
// BILLING_ENABLED isn't exposed to the browser bundle. When billing is on, the
// full nav (including Billing) is shown.
function navItems(billingEnabled: boolean) {
  return billingEnabled ? NAV : NAV.filter((item) => item.href !== "/agency/billing");
}

// Desktop: fixed left sidebar.
export function AgencySidebar({ billingEnabled }: { billingEnabled: boolean }) {
  const pathname = usePathname();
  const items = navItems(billingEnabled);
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-card lg:flex">
      <div className="flex h-16 items-center px-5">
        <Link
          href="/agency/dashboard"
          className="text-lg font-semibold tracking-tight text-ink"
        >
          HotelTrack
        </Link>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-sidebar px-3 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 ${
                active
                  ? "bg-brand/10 text-brand"
                  : "text-ink-secondary hover:bg-elevated hover:text-ink"
              }`}
            >
              {item.icon}
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

// Mobile: horizontal scrollable nav under the top bar.
export function AgencyMobileNav({ billingEnabled }: { billingEnabled: boolean }) {
  const pathname = usePathname();
  const items = navItems(billingEnabled);
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-line bg-card px-3 py-2 lg:hidden">
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex shrink-0 items-center gap-2 rounded-sidebar px-3 py-1.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 ${
              active
                ? "bg-brand/10 text-brand"
                : "text-ink-secondary hover:bg-elevated hover:text-ink"
            }`}
          >
            {item.icon}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
