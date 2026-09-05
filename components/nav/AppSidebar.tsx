"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

// Generic app navigation shell — same presentation as the agency sidebar (left
// sidebar on desktop, scrollable bar on mobile, icon + label + active pill).
// Used by the hotel-owner and admin areas. Purely presentational: items, hrefs
// and order are passed in by each layout; nothing here changes routing or auth.

export type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  /** Exact match — for section-index routes (e.g. "/admin") that would
   *  otherwise stay active on every nested page. */
  exact?: boolean;
};

function isActive(pathname: string, href: string, exact?: boolean): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

const linkClass = (active: boolean) =>
  `flex items-center gap-3 rounded-sidebar px-3 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 ${
    active
      ? "bg-brand/10 text-brand"
      : "text-ink-secondary hover:bg-elevated hover:text-ink"
  }`;

export function AppSidebar({
  brand,
  items,
}: {
  brand: { href: string; label: string; badge?: ReactNode };
  items: NavItem[];
}) {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-card lg:flex">
      <div className="flex h-16 items-center gap-2 px-5">
        <Link
          href={brand.href}
          className="text-lg font-semibold tracking-tight text-ink"
        >
          {brand.label}
        </Link>
        {brand.badge}
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
        {items.map((item) => {
          const active = isActive(pathname, item.href, item.exact);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={linkClass(active)}
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

export function AppMobileNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  if (items.length === 0) return null;
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-line bg-card px-3 py-2 lg:hidden">
      {items.map((item) => {
        const active = isActive(pathname, item.href, item.exact);
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

// Shared inline icons (18px, stroke=currentColor) so layouts stay declarative.
const svg = (path: ReactNode) => (
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

export const IconDashboard = svg(
  <><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>,
);
export const IconBilling = svg(
  <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></>,
);
export const IconAudit = svg(
  <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h8M8 9h2" /></>,
);
export const IconPeople = svg(
  <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
);
export const IconSync = svg(
  <><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" /></>,
);
