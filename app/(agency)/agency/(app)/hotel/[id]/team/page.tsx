import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { loadHotelTeam } from "@/lib/hotel-team";
import { HOTEL_ROLE_LABEL } from "@/lib/hotel-capabilities";
import { InviteForm } from "./InviteForm";
import { removeHotelMemberAction, revokeHotelInviteAction } from "./actions";

// Who can see this hotel.
//
// Admin-only, matching the other per-hotel configuration surfaces. A non-admin
// gets notFound() rather than a redirect, so the page's existence is not
// confirmed to someone who may not act on it.

export const dynamic = "force-dynamic";

function relativeDays(from: Date, now: Date): string {
  const days = Math.floor((now.getTime() - from.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export default async function HotelTeamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const member = await requireAdmin();
  if (!member) notFound();

  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id },
    select: { id: true, name: true },
  });
  if (!hotel) notFound();

  const team = await loadHotelTeam({ agencyId: member.agencyId, hotelClientId: hotel.id });
  const members = team.filter((t) => t.kind === "member");
  const invites = team.filter((t) => t.kind === "invite");
  const now = new Date();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href={`/agency/hotel/${hotel.id}`} className="text-sm text-ink-tertiary hover:underline">
          ← {hotel.name}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Hotel access</h1>
        <p className="text-sm text-ink-tertiary">
          People at {hotel.name} who can sign in and see their own performance. They see only
          this hotel — never your other clients, and never your agency settings.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* ── Current access ────────────────────────────────────────────── */}
        <section className="overflow-hidden rounded-card border border-line bg-card shadow-card">
          <div className="border-b border-line px-4 py-3">
            <h2 className="font-medium text-ink">People with access</h2>
          </div>

          {members.length === 0 && invites.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-ink-tertiary">
                Nobody at this hotel has access yet.
              </p>
              <p className="mt-1 text-xs text-ink-disabled">
                Invite them and they&apos;ll be able to see their own results.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {members.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{m.name || m.email}</p>
                    <p className="truncate text-xs text-ink-tertiary">
                      {m.email} · {HOTEL_ROLE_LABEL[m.role]} · added {relativeDays(m.since, now)}
                    </p>
                  </div>
                  <form action={removeHotelMemberAction}>
                    <input type="hidden" name="memberId" value={m.id} />
                    <input type="hidden" name="hotelClientId" value={hotel.id} />
                    <button
                      type="submit"
                      className="rounded-button border border-line-strong px-3 py-1.5 text-xs font-medium text-ink-secondary transition hover:border-danger hover:text-danger"
                    >
                      Remove access
                    </button>
                  </form>
                </li>
              ))}

              {invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{i.email}</p>
                    <p className="truncate text-xs text-ink-tertiary">
                      <span className="rounded-full bg-warning/15 px-1.5 py-0.5 font-medium text-warning">
                        Invited
                      </span>{" "}
                      {HOTEL_ROLE_LABEL[i.role]} · sent {relativeDays(i.since, now)}
                      {i.expiresAt ? ` · expires ${i.expiresAt.toLocaleDateString("en-IN", { dateStyle: "medium" })}` : ""}
                    </p>
                  </div>
                  <form action={revokeHotelInviteAction}>
                    <input type="hidden" name="inviteId" value={i.id} />
                    <input type="hidden" name="hotelClientId" value={hotel.id} />
                    <button
                      type="submit"
                      className="rounded-button border border-line-strong px-3 py-1.5 text-xs font-medium text-ink-secondary transition hover:border-danger hover:text-danger"
                    >
                      Cancel invite
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Invite ─────────────────────────────────────────────────────── */}
        <section className="rounded-card border border-line bg-card p-4 shadow-card">
          <h2 className="font-medium text-ink">Invite someone</h2>
          <p className="mt-1 text-sm text-ink-tertiary">
            They&apos;ll get an email with a link that works once and expires in 14 days.
          </p>
          <div className="mt-4">
            <InviteForm hotelClientId={hotel.id} />
          </div>
        </section>
      </div>
    </div>
  );
}
