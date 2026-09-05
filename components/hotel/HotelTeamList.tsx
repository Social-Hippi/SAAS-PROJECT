import { HOTEL_ROLE_LABEL } from "@/lib/hotel-capabilities";
import type { HotelTeamRow } from "@/lib/hotel-team";

// Who can see a hotel, as a list. Presentational and shared by the agency
// surface and the hotel's own, so the two never drift into describing the same
// grants differently.
//
// Members and pending invitations are rendered in ONE list rather than two,
// because the question being asked is "who can get in?" and an outstanding
// invitation is a partial answer to it. They are visually distinguished by the
// "Invited" chip, not by being filed somewhere else.

function relativeDays(from: Date, now: Date): string {
  const days = Math.floor((now.getTime() - from.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

const actionButtonCls =
  "rounded-button border border-line-strong px-3 py-1.5 text-xs font-medium text-ink-secondary transition hover:border-danger hover:text-danger";

export function HotelTeamList({
  rows,
  hotelClientId,
  now,
  removeAction,
  revokeAction,
  emptyHint,
}: {
  rows: HotelTeamRow[];
  hotelClientId: string;
  /** Passed in so this component does no impure work during render. */
  now: Date;
  removeAction: (formData: FormData) => Promise<void>;
  revokeAction: (formData: FormData) => Promise<void>;
  emptyHint: string;
}) {
  const members = rows.filter((r) => r.kind === "member");
  const invites = rows.filter((r) => r.kind === "invite");

  if (members.length === 0 && invites.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm text-ink-tertiary">Nobody has access to this hotel yet.</p>
        <p className="mt-1 text-xs text-ink-disabled">{emptyHint}</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-line">
      {members.map((m) => (
        <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">{m.name || m.email}</p>
            <p className="truncate text-xs text-ink-tertiary">
              {m.email} · {HOTEL_ROLE_LABEL[m.role]} · added {relativeDays(m.since, now)}
            </p>
          </div>
          <form action={removeAction}>
            <input type="hidden" name="memberId" value={m.id} />
            <input type="hidden" name="hotelClientId" value={hotelClientId} />
            <button type="submit" className={actionButtonCls}>
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
              {i.expiresAt
                ? ` · expires ${i.expiresAt.toLocaleDateString("en-IN", { dateStyle: "medium" })}`
                : ""}
            </p>
          </div>
          <form action={revokeAction}>
            <input type="hidden" name="inviteId" value={i.id} />
            <input type="hidden" name="hotelClientId" value={hotelClientId} />
            <button type="submit" className={actionButtonCls}>
              Cancel invite
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}
