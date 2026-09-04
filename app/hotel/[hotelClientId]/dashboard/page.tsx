import { notFound } from "next/navigation";
import { resolveHotelForViewer } from "@/lib/hotel-auth";
import { HotelDashboardBody } from "@/components/dashboard/HotelDashboardBody";
import { HotelDetailsForm } from "./HotelDetailsForm";

// Hotel-owner dashboard. Gives the hotel owner FULL visibility into their OWN
// hotel's data — the same depth an agency analyst sees for this hotel — but with
// none of the agency-operations chrome (no other hotels, no integration
// management, no billing/team/settings).
//
// The dashboard itself lives in the shared <HotelDashboardBody>, which renders
// IDENTICALLY for the logged-in owner here and for the public share link
// (/h/[shareToken]). The only owner-specific piece is the editable details form,
// injected as `editSlot`.
//
// Security model:
//   • resolveHotelForViewer gates access to THIS hotel only (owner or an agency
//     member of the owning agency); a foreign hotel id → 404.
//   • All data is read through the owner-scoped API routes (/api/hotel/[id]/*),
//     each of which re-checks access via requireReadAccess (Clerk session here),
//     OR through runWithAgencyScope(hotel.agencyId, …) for the server-rendered
//     sections — so every query is scoped to the owning agency + this hotel.
//   • Ad spend is ALWAYS shown to the signed-in owner for their own hotel.
//   • Only the owner's own contact details are editable. The OTA commission rate
//     is agency-managed (read-only here).
//   • What the viewer sees depends on their ROLE, not just on reaching the page:
//     viewGuestDetails decides whether the visitor-journey rows are fetched at
//     all, so a marketing user gets the performance picture without individual
//     visitors. The predicate is the same one the guards use.

export const dynamic = "force-dynamic";
const HOTEL_API = "/api/hotel";

export default async function HotelOwnerDashboard({
  params,
  searchParams,
}: {
  params: Promise<{ hotelClientId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { hotelClientId } = await params;
  const viewer = await resolveHotelForViewer(hotelClientId);
  if (!viewer) notFound();
  const { hotel, canEdit } = viewer;

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const editSlot =
    canEdit ? (
      <section className="overflow-hidden rounded-2xl border border-line bg-card">
        <div className="border-b border-line px-4 py-3 sm:px-5">
          <h2 className="font-medium text-ink">Your hotel details</h2>
          <p className="mt-0.5 text-sm text-ink-tertiary">Keep your contact info and channel manager up to date.</p>
        </div>
        <HotelDetailsForm
          hotelClientId={hotel.id}
          canEditOtaRate={false}
          initial={{
            contactName: hotel.contactName,
            contactEmail: hotel.contactEmail,
            contactPhone: hotel.contactPhone ?? "",
            whatsappNumber: hotel.whatsappNumber ?? "",
            address: hotel.address ?? "",
            otaCommissionRate: hotel.otaCommissionRate == null ? "18" : Number(hotel.otaCommissionRate).toString(),
            channelManager: hotel.channelManager ?? "None",
          }}
        />
      </section>
    ) : null;

  return (
    <HotelDashboardBody
      hotelId={hotel.id}
      hotelName={hotel.name}
      agencyId={hotel.agencyId}
      agencyName={hotel.agency.name}
      snippetStatus={hotel.snippetStatus}
      lastSyncedAt={hotel.lastSyncedAt}
      agencyContact={hotel.agency}
      basePath={`/hotel/${hotel.id}/dashboard`}
      apiBase={HOTEL_API}
      rangeParam={one(sp.range)}
      fromParam={one(sp.from)}
      toParam={one(sp.to)}
      channelParam={one(sp.channel)}
      showRestrictedNotice={one(sp.notice) === "agency-restricted"}
      channelBackLabel="← My Dashboard"
      canViewGuestDetails={viewer.can("viewGuestDetails")}
      editSlot={editSlot}
    />
  );
}
