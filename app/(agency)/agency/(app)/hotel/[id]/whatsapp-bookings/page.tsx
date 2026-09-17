import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { resolveRange } from "@/lib/attribution";
import {
  listWhatsAppBookingValues,
  summariseValues,
} from "@/lib/whatsapp-booking-values";
import { zonedDayString } from "@/lib/timezone";
import { BookingValueList, ValueSummary, type BookingRow } from "./BookingValueList";

// Per-hotel valuation of WhatsApp bookings.
//
// Kraya tells us a booking happened, never what it was worth, so this screen is
// where the agency reads the reservations record and types the amount in. That
// figure then appears on the hotel's own share link and feeds return on ad
// spend, which is why the page is ADMIN-only and shows guest names — the same
// policy as the journeys screen.

export default async function WhatsAppBookingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const member = await requireAdmin();
  if (!member) redirect(`/agency/hotel/${id}`);

  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id },
    select: { id: true, name: true, timezone: true, agencyId: true },
  });
  if (!hotel) notFound();

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const range = resolveRange(
    { range: one(sp.range) ?? "30", from: one(sp.from), to: one(sp.to) },
    { timezone: hotel.timezone },
  );

  const bookings = await listWhatsAppBookingValues(
    hotel.agencyId,
    hotel.id,
    range.since,
    range.until,
  );
  const summary = summariseValues(bookings);

  const rows: BookingRow[] = bookings.map((b) => ({
    id: b.id,
    bookedAtLabel: zonedDayString(b.bookedAt, hotel.timezone),
    krayaLeadId: b.krayaLeadId,
    phoneLast4: b.phoneLast4,
    stageName: b.stageName,
    pipelineName: b.pipelineName,
    traced: b.traced,
    marked: b.marked,
    amount: b.amount,
  }));

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/agency/hotel/${hotel.id}`}
          className="text-sm text-ink-tertiary hover:text-ink-secondary"
        >
          ← {hotel.name}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-ink">WhatsApp booking values</h1>
        <p className="mt-2 max-w-[70ch] text-sm text-ink-tertiary">
          Kraya records that a booking happened but not what it was worth. Enter the
          value from the reservations record, and tick the bookings you believe came
          from an ad. Both feed the hotel&apos;s report — a booking with no value
          entered is left out of the total rather than counted as zero.
        </p>
      </div>

      {/* Ranges mirror the share report, so the figure the agency is completing
          is the figure the hotel is reading. */}
      <nav className="flex flex-wrap gap-2 text-sm">
        {[
          ["7", "Last 7 days"],
          ["30", "Last 30 days"],
          ["90", "Last 90 days"],
          ["365", "Last year"],
        ].map(([value, label]) => (
          <Link
            key={value}
            href={`/agency/hotel/${hotel.id}/whatsapp-bookings?range=${value}`}
            className={`rounded-lg border px-3 py-1.5 ${
              (one(sp.range) ?? "30") === value
                ? "border-brand bg-brand text-white"
                : "border-line-strong bg-card text-ink-secondary hover:bg-line-strong"
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>

      <ValueSummary
        countable={summary.countable}
        valued={summary.valued}
        total={summary.total}
      />

      <BookingValueList hotelId={hotel.id} bookings={rows} currency="INR" />
    </div>
  );
}
