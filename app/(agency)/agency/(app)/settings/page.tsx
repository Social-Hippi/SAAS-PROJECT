import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { metaState, tokenTone, TOKEN_LABELS } from "@/lib/integration-status";
import { IntegrationStatusBadge } from "@/components/ui/IntegrationStatusBadge";
import { getActiveBackfill } from "./backfill-actions";
import { BackfillProgress } from "./BackfillProgress";
import { NotificationSettings } from "./NotificationSettings";
import { AgencyContactForm } from "@/components/agency/AgencyContactForm";
import { saveAgencyContact } from "./actions";
import { ensureInviteCode, inviteUrl } from "@/lib/hotel-invite";
import { InviteCodeManager } from "./InviteCodeManager";
import { OrganisationName } from "./OrganisationName";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

// Server-side relative time (avoids Date.now() in a client render).
function relativeAgo(d: Date, now: Date): string {
  const mins = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return `${Math.floor(hrs / 24)} day${Math.floor(hrs / 24) === 1 ? "" : "s"} ago`;
}

export default async function SettingsPage() {
  const member = await getCurrentMember();
  if (!member) redirect("/agency/onboarding");

  const backfillJob = await getActiveBackfill();

  // Hotel self-signup: ensure this agency has an invite code (lazily generated
  // for agencies created before the feature) + load recent invitations.
  const invite = await ensureInviteCode(member.agencyId);
  const inviteRows = await agencyScoped(prisma.hotelInvite).findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { hotelEmail: true, status: true, createdAt: true },
  });
  const recentInvites = inviteRows.map((r) => ({
    hotelEmail: r.hotelEmail,
    status: r.status,
    date: r.createdAt.toLocaleDateString("en-IN", { dateStyle: "medium" }),
  }));
  // Build the base URL (".../join/") from a full sample so the client appends the code.
  const inviteBaseUrl = inviteUrl("").replace(/\/$/, "") + "/";

  // Notification settings (budget alerts: email + Slack).
  const notif = await agencyScoped(prisma.agency).findFirst({
    select: {
      email: true,
      alertEmailAddress: true,
      emailAlertsEnabled: true,
      slackEnabled: true,
      slackWebhookUrl: true,
      slackLastTestAt: true,
      slackLastTestStatus: true,
    },
  });
  const now = new Date();
  const lastTest =
    notif?.slackLastTestAt && notif.slackLastTestStatus
      ? notif.slackLastTestStatus === "success"
        ? { ok: true, label: `Success — ${relativeAgo(notif.slackLastTestAt, now)}` }
        : { ok: false, label: `${notif.slackLastTestStatus} (${relativeAgo(notif.slackLastTestAt, now)})` }
      : null;

  // ── Read-only Meta connection summary, per hotel ─────────────────────────
  // Meta tokens are hotel-scoped (one per hotel, like Instagram/GA4): the connect
  // UI lives on each hotel's Integrations page. This is just an at-a-glance roll-up.
  const hotels = await agencyScoped(prisma.hotelClient).findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  const hotelIds = hotels.map((h) => h.id);
  const metaTokens =
    hotelIds.length > 0
      ? await agencyScoped(prisma.metaToken).findMany({
          where: { hotelClientId: { in: hotelIds } },
          select: { hotelClientId: true, status: true, tokenExpiresAt: true },
        })
      : [];
  const tokenByHotel = new Map(metaTokens.map((t) => [t.hotelClientId, t]));
  const metaRows = hotels.map((h) => ({
    id: h.id,
    name: h.name,
    state: metaState(tokenByHotel.get(h.id) ?? null, now),
  }));
  const connectedCount = metaRows.filter(
    (r) => r.state === "connected" || r.state === "expiring",
  ).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-ink-tertiary">
          Each hotel connects its own Meta (Facebook) Ads account on its
          Integrations page to bring ad spend and ROI into its dashboard.
        </p>
      </div>

      <BackfillProgress key={backfillJob?.id ?? "none"} initialJob={backfillJob} />

      {/* ── Organisation identity ────────────────────────────────────────────
          The name every member of this agency sees in the app header and on the
          reports shared with hotels. Editable here because it previously wasn't
          editable anywhere, which left agencies stuck with the personal-name
          default that onboarding used to pre-fill. */}
      <section className="rounded-card border border-line bg-card p-6 shadow-card">
        <h2 className="font-medium">Organisation</h2>
        <p className="mt-1 text-sm text-ink-tertiary">
          How your organisation is identified across HotelTrack.
        </p>
        <OrganisationName initialName={member.agency.name} />
      </section>

      {/* ── Appearance (theme) ───────────────────────────────────────────── */}
      <section className="rounded-card border border-line bg-card p-6 shadow-card">
        <h2 className="font-medium">Appearance</h2>
        <p className="mt-1 text-sm text-ink-tertiary">
          Choose how HotelTrack looks. System follows your device setting.
        </p>
        <div className="mt-4">
          <ThemeToggle />
        </div>
      </section>

      {/* ── Agency contact information (visible to hotel clients) ─────────── */}
      <section className="rounded-xl border border-line p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-medium">Agency Contact Information</h2>
          <span className="rounded-full border border-line bg-elevated px-2 py-0.5 text-[11px] font-medium text-ink-tertiary">
            👁 Hotels can see this
          </span>
        </div>
        <p className="mt-1 text-sm text-ink-tertiary">
          This information will be visible to hotel clients on their dashboard so they can
          reach you quickly.
        </p>
        <div className="mt-5 max-w-md">
          <AgencyContactForm
            action={saveAgencyContact}
            initial={{
              mobile: member.agency.mobile ?? "",
              contactEmail: member.agency.contactEmail ?? "",
              whatsappNumber: member.agency.whatsappNumber ?? "",
              address: member.agency.address ?? "",
              websiteUrl: member.agency.websiteUrl ?? "",
            }}
            submitLabel="Save contact information"
          />
        </div>
      </section>

      {/* ── Hotel self-signup (invite code) ──────────────────────────────── */}
      <section className="rounded-xl border border-line p-6">
        <h2 className="font-medium">Hotel Self-Signup</h2>
        <p className="mt-1 text-sm text-ink-tertiary">
          Share this code with a hotel so they can enter their own details — contact,
          rooms, channel manager, OTA rate — and be added to your agency without you
          re-keying it.
        </p>
        <p className="mt-2 text-sm text-ink-tertiary">
          Whoever signs up becomes the hotel&apos;s owner and can see their own dashboard.
          To give other people at the hotel access, use <strong>Hotel access</strong> on
          that hotel&apos;s page.
        </p>
        <div className="mt-5 max-w-xl">
          <InviteCodeManager
            initialCode={invite.code}
            initialStatus={invite.status}
            baseUrl={inviteBaseUrl}
            recentInvites={recentInvites}
          />
        </div>
      </section>

      {/* ── Meta connections (read-only roll-up) ────────────────────────── */}
      <section className="rounded-xl border border-line p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-medium">Meta Ads connections</h2>
          <span className="text-sm text-ink-tertiary">
            <span className="font-medium text-ink-secondary">
              {connectedCount} of {hotels.length}
            </span>{" "}
            hotel{hotels.length === 1 ? "" : "s"} connected
          </span>
        </div>
        <p className="mt-1 text-sm text-ink-tertiary">
          Meta is connected per hotel. Open a hotel&apos;s Integrations page to
          connect, reconnect, or disconnect its Meta Ads account.
        </p>

        {hotels.length === 0 ? (
          <p className="mt-4 text-sm text-ink-tertiary">
            No hotel clients yet.{" "}
            <Link href="/agency/hotels" className="underline">
              Add your first hotel
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
            {metaRows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="text-sm font-medium text-ink">{r.name}</span>
                <div className="flex items-center gap-3">
                  <IntegrationStatusBadge tone={tokenTone(r.state)} label={TOKEN_LABELS[r.state]} />
                  <Link
                    href={`/agency/hotel/${r.id}/integrations`}
                    className="text-sm font-medium text-brand hover:underline"
                  >
                    Manage →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Notifications (budget alerts via email + Slack) ───────────────── */}
      <section className="rounded-xl border border-line p-6">
        <h2 className="font-medium">Notifications</h2>
        <p className="mt-1 text-sm text-ink-tertiary">
          Where to send ad-budget alerts when a hotel crosses 80%, 90%, or 100% of
          its monthly budget. Set per-hotel budgets on each hotel&apos;s Integrations
          page.
        </p>
        <div className="mt-5">
          <NotificationSettings
            ownerEmail={notif?.email ?? ""}
            alertEmailAddress={notif?.alertEmailAddress ?? ""}
            emailAlertsEnabled={notif?.emailAlertsEnabled ?? false}
            slackEnabled={notif?.slackEnabled ?? false}
            slackWebhookUrl={notif?.slackWebhookUrl ?? ""}
            lastTest={lastTest}
          />
        </div>
      </section>
    </div>
  );
}
