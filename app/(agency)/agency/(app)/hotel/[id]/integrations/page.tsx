import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { isPixelMode } from "@/lib/tracking-mode";
import { getTokenForApiCall } from "@/lib/token-access";
import { listProperties } from "@/lib/ga4";
import { formatNumber } from "@/lib/format";
import { getAdAccounts, MetaAuthError, type AdAccount } from "@/lib/meta";
import {
  snippetState,
  snippetTone,
  metaState,
  instagramState,
  tokenTone,
  gaTone,
  summarize,
  SNIPPET_LABELS,
  TOKEN_LABELS,
  GA_LABELS,
  type TokenState,
  type GaState,
} from "@/lib/integration-status";
import { CopyButton } from "@/components/ui/CopyButton";
import { IntegrationCard } from "@/components/ui/IntegrationCard";
import { IntegrationStatusBadge } from "@/components/ui/IntegrationStatusBadge";
import { MetaTokenForm } from "@/app/(agency)/agency/(app)/settings/MetaTokenForm";
import { disconnectMetaToken } from "@/app/(agency)/agency/(app)/settings/actions";
import { TestConnection } from "../install/TestConnection";
import { HotelAdAccountSelect } from "./HotelAdAccountSelect";
import { ConnectionHistory } from "./ConnectionHistory";
import { archivedAccountSummaries } from "@/lib/meta-archive";
import { BudgetTracking } from "./BudgetTracking";
import { FunnelConfig } from "./FunnelConfig";
import { OtaCommissionSettings } from "./OtaCommissionSettings";
import { DEFAULT_OTA_RATE } from "@/lib/savings";
import { parseFunnelRules } from "@/lib/funnel";
import { getBudgetStatus, rupeesFromPaise } from "@/lib/budget";
import { InstagramActions } from "./InstagramActions";
import { SendGuideModal } from "./SendGuideModal";
import { Ga4Card, type Ga4CardStatus } from "./Ga4Card";
import { GoogleAdsCard, type GoogleAdsCardStatus, type GoogleAdsAccount, type GoogleAdsCardMetrics } from "./GoogleAdsCard";
import { loadChannelView } from "@/lib/channel-view";
import { listCustomersWithDetails } from "@/lib/google-ads";
import { getActiveBackfill } from "@/app/(agency)/agency/(app)/settings/backfill-actions";
import { BackfillProgress } from "@/app/(agency)/agency/(app)/settings/BackfillProgress";

const DAY_MS = 86_400_000;

function daysAgo(d: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / DAY_MS));
}

function SyncFailureNotice({ failedAt, now }: { failedAt: Date; now: Date }) {
  const n = daysAgo(failedAt, now);
  return (
    <div className="rounded-lg border-l-4 border-danger bg-danger/10 p-3 text-sm text-ink-secondary">
      Data sync failed {n} day{n === 1 ? "" : "s"} ago. Reconnect to restore
      data flow.
    </div>
  );
}

function fmtDate(d: Date | null | undefined): string {
  return d ? new Date(d).toLocaleString() : "—";
}

function fmtExpiry(d: Date | null | undefined): string {
  if (!d) return "—";
  if (d.getUTCFullYear() >= 2900) return "Does not expire";
  return new Date(d).toLocaleString();
}

// User-facing messages for the ?ig_error= codes set by the OAuth callback.
const IG_ERROR_MESSAGES: Record<string, string> = {
  personal_account_not_supported:
    "Personal Instagram accounts are not supported. Please switch to Business or Creator in the Instagram app (Settings → Account type), then try again.",
  access_denied:
    "Instagram access was declined. Click “Log in with Instagram” to try again.",
  exchange_failed:
    "Instagram sign-in didn't complete — the token exchange failed. Please try again in a moment.",
};

// User-facing messages for the ?ga4_error= codes set by the GA4 OAuth callback.
const GA4_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Google access was declined. Click “Connect GA4” to try again.",
  exchange_failed:
    "Google sign-in didn't complete — the token exchange failed. Please try again in a moment.",
  no_property:
    "That Google account has no GA4 property. Sign in with an account that can access your GA4 property.",
  no_refresh:
    "Google didn't return a refresh token. Remove HotelTrack from your Google account's third-party access, then reconnect.",
};

// User-facing messages for the ?gads_error= codes set by the Google Ads callback.
const GADS_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Google access was declined. Click “Connect Google Ads” to try again.",
  exchange_failed:
    "Google sign-in didn't complete — the token exchange failed. Please try again in a moment.",
  no_account:
    "No advertiser Google Ads account was found for this login. A manager (MCC) account can't be tracked directly — create or finish setting up an advertiser account under it (accounts still “Setup in progress” won't appear yet), then reconnect.",
  no_refresh:
    "Google didn't return a refresh token. Remove HotelTrack from your Google account's third-party access, then reconnect.",
};

// Small lettered/icon glyphs for each card (kept inline to avoid an icon dep).
const SnippetIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5 text-ink-secondary"
  >
    <path d="m8 6-6 6 6 6" />
    <path d="m16 6 6 6-6 6" />
  </svg>
);

export default async function HotelIntegrationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) redirect("/agency/onboarding");

  // Multi-tenant: scope by id AND agencyId so one agency can never open another
  // agency's hotel.
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id },
    select: {
      id: true,
      name: true,
      websiteUrl: true,
      siteId: true,
      snippetStatus: true,
      lastEventAt: true,
      metaAdAccountId: true,
      lastSyncedAt: true,
      previousAdAccountIds: true,
      budgetTrackingEnabled: true,
      monthlyAdBudget: true,
      budgetResetDay: true,
      funnelStageRules: true,
      otaCommissionRate: true,
    },
  });
  if (!hotel) notFound();

  // Budget status (null when tracking is off / no budget set).
  const budgetStatus = await getBudgetStatus({
    id: hotel.id,
    agencyId: member.agencyId,
    budgetTrackingEnabled: hotel.budgetTrackingEnabled,
    monthlyAdBudget: hotel.monthlyAdBudget,
    budgetResetDay: hotel.budgetResetDay,
  });

  const pixelMode = isPixelMode();
  const now = new Date();

  // OAuth round-trip feedback (?ig_connected=success / ?ig_error=…).
  const igConnectedBanner = sp.ig_connected === "success";
  const igErrorCode = typeof sp.ig_error === "string" ? sp.ig_error : null;
  const igErrorBanner = igErrorCode
    ? IG_ERROR_MESSAGES[igErrorCode] ?? "Instagram connection failed. Please try again."
    : null;

  // GA4 OAuth round-trip feedback (?ga4_connected / ?ga4_error / ?ga4_select).
  const ga4ConnectedBanner = sp.ga4_connected === "success";
  const ga4SelectBanner = sp.ga4_select === "1";
  const ga4ErrorCode = typeof sp.ga4_error === "string" ? sp.ga4_error : null;
  const ga4ErrorBanner = ga4ErrorCode
    ? GA4_ERROR_MESSAGES[ga4ErrorCode] ?? "GA4 connection failed. Please try again."
    : null;

  // Google Ads OAuth round-trip feedback (?gads_connected / ?gads_error / ?gads_select).
  const gadsConnectedBanner = sp.gads_connected === "success";
  const gadsSelectBanner = sp.gads_select === "1";
  const gadsErrorCode = typeof sp.gads_error === "string" ? sp.gads_error : null;
  const gadsErrorBanner = gadsErrorCode
    ? GADS_ERROR_MESSAGES[gadsErrorCode] ?? "Google Ads connection failed. Please try again."
    : null;

  // Meta OAuth round-trip feedback (?meta_connected=success / ?meta_error=…).
  const metaConnectedBanner = sp.meta_connected === "success";
  const metaErrorCode = typeof sp.meta_error === "string" ? sp.meta_error : null;
  const metaErrorBanner = metaErrorCode
    ? metaErrorCode === "access_denied"
      ? "Facebook connection cancelled. You can try again whenever you're ready."
      : "We couldn't complete the Facebook connection. Please try again, or paste a long-lived token instead."
    : null;

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://your-domain.com").replace(
    /\/$/,
    "",
  );
  const snippet = `<script src="${appUrl}/t.js?id=${hotel.siteId}" async></script>`;
  // Public URL for the setup-guide share modal (defaults to the prod domain so
  // the copied link is always shareable even if the env var isn't set locally).
  const guidePublicUrl = (
    process.env.NEXT_PUBLIC_APP_URL || "https://www.hoteltrack.in"
  ).replace(/\/$/, "");

  // ── Meta Ads (per-hotel token) ─────────────────────────────────────────────
  const token = await agencyScoped(prisma.metaToken).findFirst({
    where: { hotelClientId: hotel.id },
    // Ciphertext is never selected here — only read + decrypted via
    // getTokenForApiCall below, which audits the access.
    select: {
      id: true,
      status: true,
      tokenExpiresAt: true,
      tokenSource: true,
      refreshableViaOAuth: true,
      connectedFacebookUserName: true,
    },
  });
  let metaSt: TokenState = metaState(token, now);
  let adAccounts: AdAccount[] = [];
  let metaLoadError: string | null = null;
  if (token && metaSt !== "not_connected" && metaSt !== "expired") {
    try {
      const secret = await getTokenForApiCall("meta_ads", token.id, {
        agencyId: member.agencyId,
        source: "page:integrations",
      });
      adAccounts = await getAdAccounts(secret.reveal());
    } catch (err) {
      if (err instanceof MetaAuthError) {
        // Token expired/revoked since stored — flip to disconnected so Settings
        // shows the reconnect prompt, and reflect it here.
        await agencyScoped(prisma.metaToken).update({
          where: { id: token.id },
          data: { status: "disconnected" },
        });
        metaSt = "expired";
      } else {
        metaLoadError =
          err instanceof Error
            ? err.message
            : "Couldn't load your Meta ad accounts.";
      }
    }
  }

  // ── Connection History: archived data from previously-mapped ad accounts ───
  const accountName = (accId: string): string | null =>
    adAccounts.find((a) => a.id === accId)?.name ?? null;
  const historySummaries =
    hotel.previousAdAccountIds.length > 0
      ? await archivedAccountSummaries(member.agencyId, hotel.id, hotel.previousAdAccountIds)
      : [];
  const connectionHistory = historySummaries
    // Newest previous account first (previousAdAccountIds is oldest→newest).
    .slice()
    .reverse()
    .map((s) => ({ ...s, name: accountName(s.accountId) }));

  // ── Instagram (per-hotel IGAA connection) ──────────────────────────────────
  const ig = await agencyScoped(prisma.instagramConnection).findFirst({
    where: { hotelClientId: hotel.id, tokenType: "igaa_direct" },
    select: {
      status: true,
      username: true,
      igAccountType: true,
      profilePicUrl: true,
      tokenExpiresAt: true,
      lastSyncedAt: true,
      errorMessage: true,
      requiresReconnect: true,
      lastErrorReason: true,
    },
  });
  const igSt = instagramState(ig, now);
  const igConnected = ig?.status === "active";

  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  // Per-post data is no longer shown here (moved to the dashboard's Instagram
  // Organic channel view). We still surface account-level stats below.
  const [latestSnap, reachAgg] = igConnected
    ? await Promise.all([
        agencyScoped(prisma.socialSnapshot).findFirst({
          where: { hotelClientId: hotel.id },
          orderBy: { date: "desc" },
          select: { followers: true, date: true },
        }),
        agencyScoped(prisma.socialSnapshot).aggregate({
          where: { hotelClientId: hotel.id, date: { gte: since30 } },
          _sum: { reach: true, impressions: true, profileViews: true, websiteClicks: true },
        }),
      ])
    : [null, null];

  // ── Google Analytics 4 (per-hotel, OAuth) ──────────────────────────────────
  const ga4 = await agencyScoped(prisma.ga4Connection).findFirst({
    where: { hotelClientId: hotel.id },
    select: {
      id: true,
      status: true,
      propertyId: true,
      propertyName: true,
      lastSyncedAt: true,
      lastSyncError: true,
      requiresReconnect: true,
      lastErrorReason: true,
    },
  });
  const ga4Status: Ga4CardStatus = !ga4
    ? "none"
    : ga4.status === "TOKEN_EXPIRED" || ga4.status === "REVOKED"
      ? "token_expired"
      : ga4.status === "ERROR"
        ? "error"
        : ga4.propertyId === ""
          ? "needs_property"
          : "active";
  // When the user has multiple GA4 properties, list them for the picker (uses
  // the stored access token, read + decrypted out of band).
  let ga4Properties: { propertyId: string; displayName: string }[] = [];
  if (ga4Status === "needs_property" && ga4) {
    try {
      const tok = await getTokenForApiCall("ga4_access", ga4.id, {
        agencyId: member.agencyId,
        hotelClientId: hotel.id,
        source: "page:integrations-ga4-picker",
      });
      ga4Properties = (await listProperties(tok.reveal())).map((p) => ({ propertyId: p.propertyId, displayName: p.displayName }));
    } catch (err) {
      console.error("[GA4-OAUTH] property list for picker failed:", err instanceof Error ? err.message : err);
    }
  }
  // Map GA4 status into the integration-summary's GaState (ungated).
  const gaSummaryState: GaState =
    ga4Status === "active" ? "connected" : ga4Status === "none" ? "not_connected" : "broken";

  // ── Google Ads (per-hotel, OAuth — SEPARATE API from GA4) ──────────────────
  const gads = await agencyScoped(prisma.googleAdsConnection).findFirst({
    where: { hotelClientId: hotel.id },
    select: {
      id: true,
      status: true,
      customerId: true,
      customerName: true,
      currencyCode: true,
      lastSyncedAt: true,
      lastSyncError: true,
      requiresReconnect: true,
      lastErrorReason: true,
    },
  });
  const gadsStatus: GoogleAdsCardStatus = !gads
    ? "none"
    : gads.status === "TOKEN_EXPIRED" || gads.status === "REVOKED"
      ? "token_expired"
      : gads.status === "ERROR"
        ? "error"
        : gads.customerId === ""
          ? "needs_account"
          : "active";
  // When the account needs picking, list the user's accessible Ads customers
  // (uses the stored access token, read + decrypted out of band).
  let gadsAccounts: GoogleAdsAccount[] = [];
  if (gadsStatus === "needs_account" && gads) {
    try {
      const tok = await getTokenForApiCall("google_ads_access", gads.id, {
        agencyId: member.agencyId,
        hotelClientId: hotel.id,
        source: "page:integrations-gads-picker",
      });
      gadsAccounts = await listCustomersWithDetails(tok.reveal());
    } catch (err) {
      console.error("[GADS-OAUTH] account list for picker failed:", err instanceof Error ? err.message : err);
    }
  }

  // Trailing-30-day headline metrics for the connected card. Reuses the dashboard's
  // Google Ads channel loader so the numbers are identical by construction: spend
  // already in rupees, CTR/CPC recomputed from summed totals, agency-scoped. Only
  // runs when the account is active; null when there's no in-range activity.
  let gadsMetrics: GoogleAdsCardMetrics | null = null;
  if (gadsStatus === "active") {
    // Snapshots are keyed at UTC midnight, so align the 30-day window's start to
    // midnight — otherwise a mid-day `start` would drop the oldest day's row and
    // under-report spend.
    const end = new Date();
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 30);
    start.setUTCHours(0, 0, 0, 0);
    const gv = await loadChannelView(hotel.id, "google_ads", start, end);
    if (gv && gv.channelType === "paid_ads" && gv.hasData && gv.kpis) {
      const k = gv.kpis;
      gadsMetrics = {
        totalSpend: k.totalSpend,
        impressions: k.impressions,
        clicks: k.linkClicks,
        ctr: k.ctr,
        cpc: k.cpc,
      };
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const summary = summarize({
    snippet: snippetState(hotel.snippetStatus, hotel.lastEventAt),
    meta: metaSt,
    instagram: igSt,
    ga: gaSummaryState,
    snippetApplies: !pixelMode,
    planAllowsGa4: true, // GA4 (OAuth) is a standard integration, not plan-gated
  });
  const snippetSt = summary.snippet;

  // ── Active sync failures (unresolved) + any running backfill ───────────────
  const syncFailures = await agencyScoped(prisma.syncFailure).findMany({
    where: { resolvedAt: null },
    select: { tokenType: true, hotelClientId: true, failedAt: true },
  });
  const metaFailure =
    syncFailures.find(
      (f) => f.tokenType === "meta_ads" && f.hotelClientId === hotel.id,
    ) ?? null;
  const igFailure =
    syncFailures.find(
      (f) => f.tokenType === "instagram" && f.hotelClientId === hotel.id,
    ) ?? null;
  const backfillJob = await getActiveBackfill();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link href="/agency/hotels" className="text-sm text-ink-tertiary hover:underline">
          ← Hotel Clients
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{hotel.name}</h1>
            <p className="text-ink-tertiary">{hotel.websiteUrl}</p>
          </div>
          <p className="text-sm text-ink-tertiary">
            <span className="font-medium text-ink-secondary">
              {summary.connectedCount} of {summary.total}
            </span>{" "}
            integrations connected
          </p>
        </div>
      </div>

      {/* Help — share the public setup guide with the hotel */}
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
              <path d="M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <p className="text-sm font-semibold">New to HotelTrack setup?</p>
            <p className="text-sm text-ink-tertiary">
              Send {hotel.name} a step-by-step guide for installing the snippet
              and connecting Instagram.
            </p>
          </div>
        </div>
        <SendGuideModal hotelId={hotel.id} publicUrl={guidePublicUrl} />
      </div>

      <BackfillProgress key={backfillJob?.id ?? "none"} initialJob={backfillJob} />

      {/* OAuth round-trip feedback */}
      {igConnectedBanner && (
        <div className="rounded-lg border-l-4 border-success bg-success/10 p-4 text-sm text-ink-secondary">
          Instagram connected successfully. Click <strong>Sync insights now</strong>{" "}
          on the Instagram card to pull the first data.
        </div>
      )}
      {igErrorBanner && (
        <div className="rounded-lg border-l-4 border-danger bg-danger/10 p-4 text-sm text-ink-secondary">
          {igErrorBanner}
        </div>
      )}
      {ga4ConnectedBanner && (
        <div className="rounded-lg border-l-4 border-success bg-success/10 p-4 text-sm text-ink-secondary">
          Google Analytics connected. Click <strong>Sync now</strong> on the GA4
          card to pull the last 30 days.
        </div>
      )}
      {ga4SelectBanner && (
        <div className="rounded-lg border-l-4 border-info bg-info/10 p-4 text-sm text-ink-secondary">
          Almost there — choose which GA4 property to use on the GA4 card below.
        </div>
      )}
      {ga4ErrorBanner && (
        <div className="rounded-lg border-l-4 border-danger bg-danger/10 p-4 text-sm text-ink-secondary">
          {ga4ErrorBanner}
        </div>
      )}
      {gadsConnectedBanner && (
        <div className="rounded-lg border-l-4 border-success bg-success/10 p-4 text-sm text-ink-secondary">
          Google Ads connected. Campaign data will appear in the Google Ads channel
          after the next daily sync.
        </div>
      )}
      {gadsSelectBanner && (
        <div className="rounded-lg border-l-4 border-info bg-info/10 p-4 text-sm text-ink-secondary">
          Almost there — choose which Google Ads account to track on the Google Ads
          card below.
        </div>
      )}
      {gadsErrorBanner && (
        <div className="rounded-lg border-l-4 border-danger bg-danger/10 p-4 text-sm text-ink-secondary">
          {gadsErrorBanner}
        </div>
      )}
      {metaConnectedBanner && (
        <div className="rounded-lg border-l-4 border-success bg-success/10 p-4 text-sm text-ink-secondary">
          Meta connected with Facebook for {hotel.name}. Map the right ad account
          below to start pulling ad spend &amp; ROI.
        </div>
      )}
      {metaErrorBanner && (
        <div className="rounded-lg border-l-4 border-danger bg-danger/10 p-4 text-sm text-ink-secondary">
          {metaErrorBanner}
        </div>
      )}

      {/* ── Card 1 — Meta Ads (per-hotel token) ──────────────────────────── */}
      {metaSt === "expiring" && (
        <div className="rounded-lg border-l-4 border-warning bg-warning/10 p-4 text-sm">
          <p className="font-medium text-warning">
            This hotel&apos;s Meta Ads token is expiring soon. Reconnect below to
            keep ad spend &amp; ROI syncing.
          </p>
        </div>
      )}
      <IntegrationCard
        icon={<span className="text-base font-bold text-brand">f</span>}
        title="Meta Ads"
        subtitle="Paid ad performance, ROAS, campaign data"
        badge={<IntegrationStatusBadge tone={tokenTone(metaSt)} label={TOKEN_LABELS[metaSt]} />}
      >
        {metaFailure && (
          <div className="mb-4">
            <SyncFailureNotice failedAt={metaFailure.failedAt} now={now} />
          </div>
        )}
        {metaSt === "not_connected" ? (
          <div className="space-y-4">
            <p className="text-sm text-ink-secondary">
              Connect this hotel&apos;s Meta (Facebook) Ads account to bring its ad
              spend and ROI into the dashboard. Each hotel has its own connection,
              so hotels in separate Meta accounts stay independent.
            </p>
            <MetaConnect hotelId={hotel.id} guidePublicUrl={guidePublicUrl} />
          </div>
        ) : metaSt === "expired" ? (
          <div className="space-y-4">
            <div className="rounded-lg border-l-4 border-warning bg-warning/10 p-3 text-sm text-ink-secondary">
              This hotel&apos;s Meta connection expired or was revoked — ad spend
              &amp; ROI syncing is paused. Reconnect to restore it (a backfill
              refills the gap).
            </div>
            <MetaConnect hotelId={hotel.id} guidePublicUrl={guidePublicUrl} reconnect />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1 text-sm text-ink-secondary">
                {token?.connectedFacebookUserName && (
                  <p>
                    Connected by{" "}
                    <span className="font-medium text-ink-secondary">
                      {token.connectedFacebookUserName}
                    </span>{" "}
                    <span className="text-ink-tertiary">
                      ({token.tokenSource === "OAUTH" ? "Facebook Login" : "manual token"})
                    </span>
                  </p>
                )}
                <p>
                  Token active · expires:{" "}
                  <span className="font-medium">{fmtExpiry(token?.tokenExpiresAt)}</span>
                </p>
                {token?.tokenSource === "OAUTH" && token.refreshableViaOAuth && (
                  <p className="text-success">Auto-refreshes before expiry.</p>
                )}
                {hotel.lastSyncedAt && (
                  <p className="text-ink-tertiary">
                    Last synced: {fmtDate(hotel.lastSyncedAt)}
                  </p>
                )}
              </div>
              <form action={disconnectMetaToken}>
                <input type="hidden" name="hotelId" value={hotel.id} />
                <button
                  type="submit"
                  className="rounded-lg border border-line-strong bg-elevated px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-line-strong"
                >
                  Disconnect
                </button>
              </form>
            </div>
            <HotelAdAccountSelect
              hotelId={hotel.id}
              hotelName={hotel.name}
              accounts={adAccounts}
              currentAdAccountId={hotel.metaAdAccountId}
            />
            {metaLoadError && <p className="text-sm text-danger">{metaLoadError}</p>}
            <ConnectionHistory
              hotelId={hotel.id}
              currentAdAccountId={hotel.metaAdAccountId}
              currentAccountName={hotel.metaAdAccountId ? accountName(hotel.metaAdAccountId) : null}
              previous={connectionHistory}
            />
            <details className="text-sm">
              <summary className="cursor-pointer text-ink-tertiary hover:text-ink">
                Reconnect or replace this hotel&apos;s token
              </summary>
              <div className="mt-3">
                <MetaConnect hotelId={hotel.id} guidePublicUrl={guidePublicUrl} reconnect />
              </div>
            </details>
          </div>
        )}
      </IntegrationCard>

      {/* ── Ad Budget Tracking ───────────────────────────────────────────── */}
      <IntegrationCard
        icon={<span className="text-base font-bold text-brand">₹</span>}
        title="Ad Budget Tracking"
        subtitle="Set a monthly ad budget and get alerted at 80%, 90%, and 100%."
        badge={
          <IntegrationStatusBadge
            tone={hotel.budgetTrackingEnabled ? "green" : "gray"}
            label={hotel.budgetTrackingEnabled ? "Tracking on" : "Off"}
          />
        }
      >
        <BudgetTracking
          hotelId={hotel.id}
          enabled={hotel.budgetTrackingEnabled}
          budgetRupees={hotel.monthlyAdBudget != null ? rupeesFromPaise(hotel.monthlyAdBudget) : null}
          resetDay={hotel.budgetResetDay}
          status={
            budgetStatus
              ? {
                  spendPaise: budgetStatus.spendPaise,
                  budgetPaise: budgetStatus.budgetPaise,
                  pct: budgetStatus.pct,
                  state: budgetStatus.state,
                  nextThreshold: budgetStatus.nextThreshold,
                  remainingToNextPaise: budgetStatus.remainingToNextPaise,
                }
              : null
          }
        />
        <p className="mt-3 text-xs text-ink-tertiary">
          Alerts go to the channels configured in{" "}
          <Link href="/agency/settings" className="underline">
            Settings → Notifications
          </Link>
          .
        </p>
      </IntegrationCard>

      {/* ── Funnel Stages (Phase 2 journey funnel) ───────────────────────── */}
      <IntegrationCard
        icon={<span className="text-base font-bold text-brand">⛢</span>}
        title="Funnel Stages"
        subtitle="Tag your website pages with funnel stages so HotelTrack can show drop-off analysis."
        badge={
          <IntegrationStatusBadge
            tone={parseFunnelRules(hotel.funnelStageRules).length > 0 ? "green" : "gray"}
            label={
              parseFunnelRules(hotel.funnelStageRules).length > 0
                ? `${parseFunnelRules(hotel.funnelStageRules).length} rule${parseFunnelRules(hotel.funnelStageRules).length === 1 ? "" : "s"}`
                : "Not configured"
            }
          />
        }
      >
        <FunnelConfig hotelId={hotel.id} initialRules={parseFunnelRules(hotel.funnelStageRules)} />
        <p className="mt-3 text-xs text-ink-tertiary">
          See drop-off analysis on the{" "}
          <Link href={`/agency/hotel/${hotel.id}/journeys`} className="underline">
            Visitor Journeys
          </Link>{" "}
          page.
        </p>
      </IntegrationCard>

      {/* ── OTA Commission Tracking (per-hotel rate for direct-booking savings) ── */}
      <OtaCommissionSettings
        hotelId={hotel.id}
        currentRate={hotel.otaCommissionRate == null ? DEFAULT_OTA_RATE : Number(hotel.otaCommissionRate)}
      />

      {/* ── Card 2 — Instagram (IGAA via Instagram Login) ────────────────── */}
      <IntegrationCard
        icon={<span className="text-xs font-bold text-pink-400">IG</span>}
        title="Instagram"
        subtitle="Organic reach, followers, post engagement"
        badge={<IntegrationStatusBadge tone={tokenTone(igSt)} label={TOKEN_LABELS[igSt]} />}
      >
        {igFailure && (
          <div className="mb-4">
            <SyncFailureNotice failedAt={igFailure.failedAt} now={now} />
          </div>
        )}
        {ig?.requiresReconnect && (
          <ReconnectBanner
            href={`/api/auth/instagram/start?hotelClientId=${hotel.id}`}
            reason={ig.lastErrorReason}
          />
        )}
        {igConnected ? (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              {ig?.profilePicUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- external IG CDN avatar
                <img
                  src={ig.profilePicUrl}
                  alt={`@${ig.username ?? "instagram"} profile picture`}
                  className="h-12 w-12 rounded-full border border-line object-cover"
                />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-pink-900/40 text-sm font-bold text-pink-400">
                  IG
                </div>
              )}
              <div className="text-sm">
                <p className="font-medium">@{ig?.username}</p>
                <p className="text-ink-tertiary">
                  {ig?.igAccountType === "CREATOR" ? "Creator" : "Business"} account ·
                  Last synced: {fmtDate(ig?.lastSyncedAt)}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Followers" value={formatNumber(latestSnap?.followers ?? 0)} />
              <Stat label="Reach · 30d" value={formatNumber(reachAgg?._sum.reach ?? 0)} />
              <Stat
                label="Impressions · 30d"
                value={formatNumber(reachAgg?._sum.impressions ?? 0)}
              />
              <Stat
                label="Profile views · 30d"
                value={formatNumber(reachAgg?._sum.profileViews ?? 0)}
              />
              <Stat
                label="Website clicks · 30d"
                value={formatNumber(reachAgg?._sum.websiteClicks ?? 0)}
              />
            </div>

            <div className="rounded-lg border-l-4 border-info bg-info/10 p-3 text-xs text-ink-secondary">
              <span className="font-semibold text-ink">Note:</span> Video retention
              time and skip rate are only available in the Instagram app itself —
              Meta does not expose these through their API. Hotels can screenshot
              those from the app and share them for weekly retention reports.
            </div>

            <InstagramActions hotelId={hotel.id} />

            {/* Instagram posts/content now live on the hotel dashboard's
                "Instagram Organic" channel view (My Instagram Content). This page
                stays focused on connection status, account info, and sync controls.
                Post syncing is unchanged — see lib/instagram-sync.ts. */}
          </div>
        ) : (
          <div className="space-y-3">
            {ig?.status === "error" && ig.errorMessage && (
              <div className="rounded-lg border-l-4 border-warning bg-warning/10 p-3 text-sm text-ink-secondary">
                The last sync failed: {ig.errorMessage} — reconnect below to
                resume.
              </div>
            )}
            <p className="text-sm text-ink-secondary">
              Bring organic reach, impressions, follower growth, and per-post
              engagement into HotelTrack.
            </p>
            <a
              href={`/api/auth/instagram/start?hotelClientId=${hotel.id}`}
              className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-purple-600 via-pink-600 to-orange-500 px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z" />
              </svg>
              Log in with Instagram
            </a>
            <p className="text-xs text-ink-tertiary">
              The hotel will be asked to log in with their Instagram Business or
              Creator account. No Facebook Page required.
            </p>
          </div>
        )}
      </IntegrationCard>

      {/* ── Card 3 — Website Tracking Snippet ─────────────────────────────── */}
      <IntegrationCard
        icon={SnippetIcon}
        title="Website Tracking Snippet"
        subtitle="Captures which content sends visitors and records bookings."
        badge={
          pixelMode ? (
            <IntegrationStatusBadge tone="gray" label="Facebook Pixel mode" />
          ) : (
            <IntegrationStatusBadge
              tone={snippetTone(snippetSt)}
              label={SNIPPET_LABELS[snippetSt]}
            />
          )
        }
      >
        {pixelMode ? (
          <div className="space-y-2 text-sm text-ink-secondary">
            <p>
              This agency uses Meta&apos;s Pixel for website tracking, so the
              HotelTrack snippet isn&apos;t used here. Conversions and ROAS appear
              under <strong>Paid ads performance</strong> on the dashboard.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-2">
              <code className="block flex-1 overflow-x-auto rounded-lg bg-code px-4 py-3 text-sm text-codeink">
                {snippet}
              </code>
              <CopyButton text={snippet} />
            </div>
            <p className="text-xs text-ink-tertiary">
              Site ID: <code>{hotel.siteId}</code>
            </p>
            {snippetSt === "live" && (
              <p className="text-xs text-ink-tertiary">
                Last event received: {fmtDate(hotel.lastEventAt)}
              </p>
            )}

            <div className="rounded-lg border-l-4 border-info bg-info/10 p-3 text-xs text-ink-secondary">
              <p className="font-semibold text-ink">Capture booking revenue</p>
              <p className="mt-1">
                For accurate revenue, add this to your booking confirmation page
                total:
              </p>
              <code className="mt-1.5 block overflow-x-auto rounded bg-code px-2 py-1.5 text-codeink">
                {`<span data-ht-value="YOUR_BOOKING_AMOUNT">₹X,XXX</span>`}
              </code>
              <p className="mt-1.5">
                Replace <code>YOUR_BOOKING_AMOUNT</code> with the variable your
                booking system uses for the total.
              </p>
            </div>

            <TestConnection hotelId={hotel.id} />

            <p className="text-sm">
              <Link
                href={`/agency/hotel/${hotel.id}/install`}
                className="font-medium underline"
              >
                View install guide →
              </Link>{" "}
              <span className="text-ink-tertiary">
                — step-by-step for WordPress, Shopify, or any site.
              </span>
            </p>
          </div>
        )}
      </IntegrationCard>

      {/* ── Card 4 — Google Analytics 4 (OAuth) ───────────────────────────── */}
      <IntegrationCard
        icon={<span className="text-xs font-bold text-warning">GA</span>}
        title="Google Analytics 4"
        subtitle="Traffic sources, Google Ads, geographic breakdown"
        badge={<IntegrationStatusBadge tone={gaTone(gaSummaryState)} label={GA_LABELS[gaSummaryState]} />}
      >
        {ga4?.requiresReconnect && (
          <ReconnectBanner
            href={`/api/auth/ga4/start?hotelClientId=${hotel.id}`}
            reason={ga4.lastErrorReason}
          />
        )}
        <Ga4Card
          hotelId={hotel.id}
          status={ga4Status}
          propertyName={ga4?.propertyName ?? null}
          propertyId={ga4?.propertyId ?? null}
          lastSyncedAt={ga4?.lastSyncedAt?.toISOString() ?? null}
          lastSyncError={ga4?.lastSyncError ?? null}
          properties={ga4Properties}
        />
      </IntegrationCard>

      {/* ── Card 5 — Google Ads (OAuth, separate API from GA4) ─────────────── */}
      <IntegrationCard
        icon={<span className="text-xs font-bold text-brand">Ads</span>}
        title="Google Ads"
        subtitle="Campaign spend, clicks, conversions, ROAS"
        badge={
          <IntegrationStatusBadge
            tone={gadsStatus === "active" ? "green" : gadsStatus === "none" ? "gray" : "red"}
            label={
              gadsStatus === "active"
                ? "Connected"
                : gadsStatus === "none"
                  ? "Not connected"
                  : gadsStatus === "needs_account"
                    ? "Pick account"
                    : gadsStatus === "token_expired"
                      ? "Reconnect needed"
                      : "Error"
            }
          />
        }
      >
        {gads?.requiresReconnect && (
          <ReconnectBanner
            href={`/api/auth/google-ads/start?hotelClientId=${hotel.id}`}
            reason={gads.lastErrorReason}
          />
        )}
        <GoogleAdsCard
          hotelId={hotel.id}
          status={gadsStatus}
          customerName={gads?.customerName ?? null}
          customerId={gads?.customerId ?? null}
          currencyCode={gads?.currencyCode ?? null}
          lastSyncedAt={gads?.lastSyncedAt?.toISOString() ?? null}
          lastSyncError={gads?.lastSyncError ?? null}
          accounts={gadsAccounts}
          metrics={gadsMetrics}
        />
      </IntegrationCard>
    </div>
  );
}

// Surfaced when a connection's stored token has gone invalid (requiresReconnect).
// One-click reconnect re-runs the provider's OAuth /start, which clears the flag.
function ReconnectBanner({ href, reason }: { href: string; reason: string | null }) {
  return (
    <div className="mb-4 rounded-lg border-l-4 border-danger bg-danger/10 p-3 text-sm text-ink-secondary">
      <p className="font-semibold text-ink">Reconnect needed</p>
      <p className="mt-1">
        This connection&apos;s token is no longer valid
        {reason ? <> (<span className="font-mono text-xs">{reason}</span>)</> : null} — its
        data has stopped flowing. Reconnect to resume.
      </p>
      <a
        href={href}
        className="mt-2 inline-flex items-center gap-1 rounded-lg bg-danger px-3 py-1.5 text-sm font-medium text-white hover:bg-danger/90"
      >
        Reconnect now →
      </a>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

// Per-hotel Meta connect options: the recommended "Connect with Facebook" OAuth
// button (auto-refreshing token) plus a disclosure to paste a long-lived token.
// Both paths store a token scoped to THIS hotel.
function MetaConnect({
  hotelId,
  guidePublicUrl,
  reconnect = false,
}: {
  hotelId: string;
  guidePublicUrl: string;
  reconnect?: boolean;
}) {
  return (
    <div className="space-y-3">
      <a
        href={`/api/auth/meta/start?hotelClientId=${hotelId}`}
        className="inline-flex items-center gap-2 rounded-lg bg-[#1877F2] px-4 py-2 text-sm font-medium text-white hover:bg-[#166fe0]"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z" />
        </svg>
        {reconnect ? "Reconnect with Facebook" : "Connect with Facebook"}
      </a>
      <p className="text-xs text-ink-tertiary">
        Recommended — Meta handles the login and the token auto-refreshes. Need
        help?{" "}
        <a href={`${guidePublicUrl}/setup-guide`} target="_blank" rel="noopener noreferrer" className="underline">
          View the setup guide
        </a>
        .
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer text-ink-tertiary hover:text-ink">
          Or paste a long-lived access token (advanced)
        </summary>
        <div className="mt-3 space-y-2">
          <p className="text-xs text-ink-tertiary">
            Paste a Meta access token with <code className="text-xs">ads_read</code>{" "}
            permission (from the Graph API Explorer or your app&apos;s system user).
            Manual tokens don&apos;t auto-refresh.
          </p>
          <MetaTokenForm hotelId={hotelId} submitLabel={reconnect ? "Reconnect Meta" : "Connect Meta"} />
        </div>
      </details>
    </div>
  );
}
