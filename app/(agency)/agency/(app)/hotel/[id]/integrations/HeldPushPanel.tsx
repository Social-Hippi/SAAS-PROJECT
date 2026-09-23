import Link from "next/link";

import { CopyButton } from "@/components/ui/CopyButton";
import type { HeldPush, HeldPushBody } from "@/lib/booking-push-preview";

/**
 * Held Booking Push bodies, for writing a provider's field mapping from what it
 * actually sends. Admin-only, and guest data is masked before it reaches here.
 */
export function HeldPushPanel({
  held,
  open,
  hrefFor,
  closeHref,
}: {
  held: HeldPush[];
  open: HeldPushBody | null;
  hrefFor: (id: string) => string;
  closeHref: string;
}) {
  if (held.length === 0) return null;

  return (
    <div className="mt-6 space-y-3 border-t border-line pt-6">
      <div>
        <p className="text-sm font-medium text-ink">
          {held.length} push{held.length === 1 ? "" : "es"} held, waiting for the field mapping
        </p>
        <p className="mt-1 max-w-[70ch] text-sm text-ink-tertiary">
          Each is a real booking the provider sent. They are stored encrypted and recorded as
          bookings once the mapping is in place, so nothing is lost. Guest details are masked
          below — the field names, formats and amounts are not.
        </p>
      </div>

      <ul className="divide-y divide-line rounded-lg border border-line bg-card">
        {held.map((h) => {
          const isOpen = open?.id === h.id;
          return (
            <li key={h.id} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 text-sm">
                  <span className="text-ink">{new Date(h.receivedAt).toLocaleString()}</span>
                  <span className="text-ink-tertiary">
                    {" "}
                    · {h.provider} · {h.bodyBytes} bytes
                    {h.replayedAt ? " · recorded" : " · waiting"}
                  </span>
                </div>
                <Link
                  href={isOpen ? closeHref : hrefFor(h.id)}
                  scroll={false}
                  className="rounded-md border border-line-strong bg-elevated px-2 py-1 text-xs font-medium text-ink-secondary hover:bg-line-strong"
                >
                  {isOpen ? "Hide payload" : "View payload"}
                </Link>
              </div>

              {isOpen && open && (
                <div className="mt-3 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-ink-tertiary">
                      Guest name, email, phone and address are masked. HotelTrack&apos;s own
                      journey identifiers are not, so we can see whether the provider echoes
                      them back.
                    </p>
                    {!open.unreadable && (
                      <CopyButton
                        text={open.masked}
                        label="Copy payload"
                        className="shrink-0 rounded-md border border-line-strong bg-elevated px-2 py-1 text-xs font-medium text-ink-secondary hover:bg-line-strong"
                      />
                    )}
                  </div>
                  <pre className="max-h-[28rem] overflow-auto rounded-lg border border-line bg-page p-3 text-xs leading-relaxed text-ink">
                    {open.masked}
                  </pre>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
