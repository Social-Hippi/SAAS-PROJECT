"use client";

import { useActionState, useState } from "react";
import { CopyButton } from "@/components/ui/CopyButton";
import { createShareLink, revokeShareLink, type ShareState } from "./share-actions";
import { setShowAdSpendToHotel } from "./hotel-share-actions";

type ActiveLink = {
  id: string;
  token: string;
  hasPassword: boolean;
  expiresAt: string;
  expired: boolean;
  viewCount: number;
  lastViewedAt: string | null;
};

const initial: ShareState = { error: null, ok: false };

function CreateForm({
  hotelId,
  cta,
}: {
  hotelId: string;
  cta: string;
}) {
  const [state, action, pending] = useActionState(createShareLink, initial);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="hotelId" value={hotelId} />
      <div>
        <label className="block text-sm font-medium text-ink-secondary" htmlFor="share-password">
          Password{" "}
          <span className="font-normal text-ink-tertiary">(optional)</span>
        </label>
        <input
          id="share-password"
          name="password"
          type="text"
          autoComplete="off"
          placeholder="Leave blank for no password"
          className="mt-1 w-full rounded-lg border border-line-strong bg-page px-3 py-2 text-sm text-ink placeholder:text-ink-disabled focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
        <p className="mt-1 text-xs text-ink-tertiary">
          The hotel owner enters this to view the report. Share it with them
          separately.
        </p>
      </div>
      {state.error && (
        <p className="text-sm text-danger">{state.error}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60"
      >
        {pending ? "Generating…" : cta}
      </button>
    </form>
  );
}

/**
 * Whether the hotel sees ad-spend amounts on its /share/<uuid> report.
 *
 * WHY THIS IS HERE AND NOT IN HotelShareManager.tsx. It used to live there,
 * beside the retired /h/<token> hotel-login flow. When that route was retired
 * the whole component stopped being rendered — and the toggle went with it,
 * unnoticed, because the FLAG kept working: showAdSpendToHotel defaults to
 * false, so every hotel had spend hidden and no agency had any way to turn it
 * on. A setting nobody can reach is not a default, it is a dead end.
 *
 * Submits on change rather than behind a Save button: it is one boolean, and an
 * unsaved toggle that looks applied is worse than no toggle. The optimistic
 * local state keeps the switch from snapping back while the action round-trips.
 */
function AdSpendToggle({ hotelId, initialOn }: { hotelId: string; initialOn: boolean }) {
  const [on, setOn] = useState(initialOn);
  return (
    <form action={setShowAdSpendToHotel} className="flex items-start justify-between gap-3">
      <input type="hidden" name="hotelId" value={hotelId} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">Show ad spend amounts to hotel</p>
        <p className="mt-0.5 text-xs text-ink-tertiary">
          When OFF, the hotel sees bookings and enquiries but not what was spent on
          ads — and not return on ad spend, which would give the spend away by
          division.
        </p>
      </div>
      <label
        className="relative inline-flex shrink-0 cursor-pointer items-center"
        title="When OFF, ad spend and return on ad spend are hidden from the hotel."
      >
        <input
          type="checkbox"
          name="show"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            e.currentTarget.form?.requestSubmit();
          }}
          className="peer sr-only"
        />
        <span className="h-6 w-11 rounded-full bg-line-strong transition peer-checked:bg-brand" />
        <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition peer-checked:translate-x-5" />
      </label>
    </form>
  );
}

export function ShareLinkManager({
  hotelId,
  shareBaseUrl,
  link,
  showAdSpend,
}: {
  hotelId: string;
  shareBaseUrl: string;
  link: ActiveLink | null;
  /** The hotel's showAdSpendToHotel flag, governing the share report only. */
  showAdSpend: boolean;
}) {
  if (!link) {
    return (
      <div className="p-4">
        <p className="mb-3 text-sm text-ink-secondary">
          Generate a private link to a read-only version of this dashboard. It
          works on any phone — no login needed — and expires in 30 days.
        </p>
        <CreateForm hotelId={hotelId} cta="Generate share link" />
        {/* Rendered before a link exists too: the agency should be able to
            decide what the report will show BEFORE handing it to a client. */}
        <div className="mt-4 border-t border-line pt-4">
          <AdSpendToggle hotelId={hotelId} initialOn={showAdSpend} />
        </div>
      </div>
    );
  }

  const url = `${shareBaseUrl}/share/${link.token}`;
  const expires = new Date(link.expiresAt);
  const expired = link.expired;

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full flex-1 truncate rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink"
        />
        <CopyButton text={url} label="Copy link" />
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-tertiary">
        <span>
          {link.hasPassword ? "🔒 Password protected" : "🔓 No password"}
        </span>
        <span className={expired ? "text-danger" : ""}>
          {expired ? "Expired " : "Expires "}
          {expires.toLocaleDateString()}
        </span>
        <span>
          {link.viewCount} view{link.viewCount === 1 ? "" : "s"}
          {link.lastViewedAt
            ? ` · last ${new Date(link.lastViewedAt).toLocaleDateString()}`
            : ""}
        </span>
      </div>

      <div className="border-t border-line pt-4">
        <AdSpendToggle hotelId={hotelId} initialOn={showAdSpend} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <form action={revokeShareLink}>
          <input type="hidden" name="linkId" value={link.id} />
          <input type="hidden" name="hotelId" value={hotelId} />
          <button
            type="submit"
            className="rounded-lg border border-danger/60 px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10"
          >
            Revoke link
          </button>
        </form>
      </div>

      <details className="border-t border-line pt-3">
        <summary className="cursor-pointer text-sm font-medium text-ink-secondary hover:text-ink">
          Replace with a new link
        </summary>
        <p className="mt-2 mb-3 text-xs text-ink-tertiary">
          Generating a new link revokes the current one immediately.
        </p>
        <CreateForm hotelId={hotelId} cta="Generate new link" />
      </details>
    </div>
  );
}
