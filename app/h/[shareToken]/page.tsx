import type { Metadata } from "next";
import { notFound } from "next/navigation";

// ACCESS LOCKDOWN: the public /h/<shareToken> hotel-owner dashboard is retired.
// Hotels no longer log in and no longer use this full-depth dashboard (which also
// exposed journeys, funnel, and ad spend regardless of showAdSpendToHotel). They
// now receive outcomes only via the public /share/<uuid> report link.
//
// This route always returns a real 404 (rendered by ./not-found.tsx). The data
// routes it used to feed (/api/hotel/[id]/*) are independently closed in
// lib/hotel-auth.ts. The original token-resolving dashboard lives in git history
// if the product decision is ever reversed.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Link no longer active · HotelTrack",
  robots: { index: false, follow: false },
};

export default async function RetiredPublicHotelDashboard() {
  notFound();
}
