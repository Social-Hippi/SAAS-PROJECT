import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { parseKrayaExport } from "@/lib/kraya-import";
import { ingestKrayaLead } from "@/lib/kraya-ingest";

// ─────────────────────────────────────────────────────────────────────────────
// Kraya export import — backfill, and the reconciliation backstop.
//
// Kraya's API is POST-only: both documented endpoints push data INTO Kraya and
// none reads leads back. So the webhook starts from empty, and every lead that
// existed before it was switched on is unreachable by any other route. Kraya
// also retries a failed delivery twice and then drops it for good, with no
// catch-up query — so re-uploading the export is the only way to notice and
// repair a gap.
//
// IDEMPOTENT. Conversations are keyed on (hotel, phone hash) and bookings on the
// phone hash too, so the same file uploaded twice updates rather than
// duplicates. That is what makes this safe to use as a routine backstop rather
// than a one-off.
//
// SESSION-AUTHENTICATED, unlike the webhook — a person uploads this from the
// dashboard, so it is an agency admin action scoped to their own hotel.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** Kraya caps an export at 25,000 leads; this is generous headroom for that. */
const MAX_BYTES = 20 * 1024 * 1024;

export async function POST(request: Request) {
  const member = await requireAdmin();
  if (!member) return Response.json({ error: "Not authorized" }, { status: 403 });

  const form = await request.formData();
  const hotelId = String(form.get("hotelId") ?? "").trim();
  const file = form.get("file");

  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true, agencyId: true },
  });
  if (!hotel) return Response.json({ error: "Hotel not found" }, { status: 404 });

  if (!(file instanceof File)) {
    return Response.json({ error: "No file uploaded" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "File too large" }, { status: 413 });
  }

  const connection = await agencyScoped(prisma.krayaConnection).findFirst({
    where: { hotelClientId: hotel.id },
    select: { id: true, confirmedStageName: true },
  });
  if (!connection) {
    // Without a connection there is no confirmed-stage setting, and importing
    // leads with no way to recognise a booking would quietly produce none.
    return Response.json({ error: "Connect Kraya first." }, { status: 400 });
  }

  let parsed;
  try {
    parsed = parseKrayaExport(
      Buffer.from(await file.arrayBuffer()),
      connection.confirmedStageName,
    );
  } catch {
    return Response.json(
      { error: "That file could not be read as a Kraya lead export." },
      { status: 400 },
    );
  }

  const tenant = {
    connectionId: connection.id,
    agencyId: hotel.agencyId,
    hotelClientId: hotel.id,
    confirmedStageName: connection.confirmedStageName,
  };

  let conversations = 0;
  let bookings = 0;
  let attributed = 0;
  let failed = 0;

  for (const lead of parsed.leads) {
    try {
      const r = await ingestKrayaLead(tenant, lead, new Date(), {
        firstSeenAt: lead.createdAt,
        lastSeenAt: lead.stageUpdatedAt,
        // Falls back to the stage-updated time: a booking whose history could
        // not be read is still a booking, and dropping it would understate the
        // total to avoid an imprecise date.
        confirmedAt: lead.confirmedAt ?? lead.stageUpdatedAt,
      });
      if (!r) continue;
      conversations += 1;
      if (r.booking) bookings += 1;
      if (r.attributed) attributed += 1;
    } catch {
      // One bad row must not abandon the other 1,037.
      failed += 1;
    }
  }

  // Without this the integrations page keeps the render it had BEFORE the
  // import, so the confirmed-stage dropdown still offers whatever handful of
  // stages had arrived by webhook — and an operator who just imported 4,000
  // leads cannot find the stage they imported. The import is a fetch() to a
  // route handler, so nothing else revalidates on its behalf.
  revalidatePath(`/agency/hotel/${hotel.id}/integrations`);
  revalidatePath(`/agency/hotel/${hotel.id}`);

  return Response.json({
    ok: true,
    rowsInFile: parsed.rows,
    conversations,
    bookings,
    attributed,
    failed,
    skipped: parsed.skipped.length,
    confirmedStageUsed: connection.confirmedStageName,
  });
}
