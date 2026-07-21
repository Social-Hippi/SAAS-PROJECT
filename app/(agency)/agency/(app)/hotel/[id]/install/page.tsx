import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentMember } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { CopyButton } from "@/components/ui/CopyButton";
import { SnippetStatusBadge } from "@/components/ui/SnippetStatusBadge";
import {
  SITE_PLATFORMS,
  SITE_PLATFORM_LABELS,
  normalizeSitePlatform,
  type SitePlatform,
} from "@/lib/site-platform";
import { TestConnection } from "./TestConnection";

// Platform-specific install guides. Each is the same one-line snippet, with the
// steps to drop it before </head> on that platform.
const GUIDES: Record<SitePlatform, { intro: string; steps: ReactNode[] }> = {
  wordpress: {
    intro:
      "The cleanest way on WordPress is a header-script plugin — no theme code to edit.",
    steps: [
      <>
        In your WordPress admin, install and activate a header plugin such as{" "}
        <strong>WPCode</strong> or <strong>Insert Headers and Footers</strong>{" "}
        (Plugins → Add New).
      </>,
      <>
        Open its settings (e.g. <strong>Settings → Insert Headers and Footers</strong>,
        or <strong>Code Snippets → Header &amp; Footer</strong> in WPCode).
      </>,
      <>
        Paste the snippet into the <strong>Scripts in Header</strong> box and save.
      </>,
      <>
        Prefer editing the theme? Go to <strong>Appearance → Theme File Editor →
        header.php</strong> and paste it just before <code>&lt;/head&gt;</code>.
        Use a <strong>child theme</strong> so a theme update won&apos;t erase it.
      </>,
      <>Open your site, then come back and click <strong>Test connection</strong>.</>,
    ],
  },
  shopify: {
    intro: "On Shopify you add the snippet to your theme's layout file.",
    steps: [
      <>
        From your Shopify admin, go to <strong>Online Store → Themes</strong>.
      </>,
      <>
        On your current theme, click <strong>⋯ (three dots) → Edit code</strong>.
      </>,
      <>
        Open <strong>layout/theme.liquid</strong> and paste the snippet just
        before the closing <code>&lt;/head&gt;</code> tag.
      </>,
      <>
        Click <strong>Save</strong>.
      </>,
      <>
        If bookings finish in Shopify checkout, also paste it under{" "}
        <strong>Settings → Checkout → Order status page additional scripts</strong>{" "}
        so post-purchase pages are tracked.
      </>,
      <>Open your store, then come back and click <strong>Test connection</strong>.</>,
    ],
  },
  other: {
    intro:
      "Any site works — the snippet just needs to load on every page, inside the <head>.",
    steps: [
      <>
        Open the HTML template / layout that renders the <code>&lt;head&gt;</code>{" "}
        on every page of your site.
      </>,
      <>
        Paste the snippet on its own line, just before the closing{" "}
        <code>&lt;/head&gt;</code> tag.
      </>,
      <>
        Make sure it loads on <strong>every</strong> page — homepage, room pages,
        and the whole booking flow — not just one.
      </>,
      <>
        Deploy the change. The <code>async</code> attribute means it never blocks
        or slows the page.
      </>,
      <>
        Using <strong>Google Tag Manager</strong> instead? Add a{" "}
        <strong>Custom HTML</strong> tag with the snippet, trigger it on{" "}
        <strong>All Pages</strong>, and publish. (Test connection may not see a
        GTM-injected snippet in your homepage HTML — that&apos;s fine, events
        will still register.)
      </>,
      <>Load your site, then come back and click <strong>Test connection</strong>.</>,
    ],
  },
};

export default async function HotelInstallPage({
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

  // Multi-tenant: scope by both id AND agencyId so one agency can never open
  // another agency's hotel.
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id },
    select: { id: true, name: true, websiteUrl: true, siteId: true, snippetStatus: true, sitePlatform: true },
  });
  if (!hotel) notFound();

  // Falls back to the production origin, never a placeholder domain: this string
  // is copied straight onto a hotel's website, and NEXT_PUBLIC_APP_URL is
  // guaranteed present in production by validatePlatformEnv().
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://hoteltrack.in").replace(
    /\/$/,
    "",
  );
  const snippet = `<script src="${appUrl}/t.js?id=${hotel.siteId}" async></script>`;

  // Show the guide for the platform in the URL (?platform=…) if present, else
  // the one chosen when the hotel was created.
  const rawPlatform = Array.isArray(sp.platform) ? sp.platform[0] : sp.platform;
  const active: SitePlatform = normalizeSitePlatform(rawPlatform ?? hotel.sitePlatform);
  const guide = GUIDES[active];

  return (
    <div className="space-y-8">
      <div>
        <Link href={`/agency/hotel/${hotel.id}`} className="text-sm text-ink-tertiary hover:underline">
          ← {hotel.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Install the tracking snippet</h1>
        <p className="text-ink-tertiary">{hotel.websiteUrl}</p>
        <div className="mt-2">
          <SnippetStatusBadge status={hotel.snippetStatus} />
        </div>
      </div>

      {/* ── The snippet ──────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-line p-6">
        <h2 className="font-semibold">Your snippet</h2>
        <p className="mt-1 text-sm text-ink-tertiary">
          The same one line works on every platform. Copy it, then follow the
          guide below.
        </p>
        <div className="mt-4 flex items-start gap-2">
          <code className="block flex-1 overflow-x-auto rounded-lg bg-code px-4 py-3 text-sm text-codeink">
            {snippet}
          </code>
          <CopyButton text={snippet} />
        </div>
        <p className="mt-2 text-xs text-ink-tertiary">
          Site ID: <code>{hotel.siteId}</code>
        </p>
      </section>

      {/* ── Revenue capture helper ───────────────────────────────────────── */}
      <section className="rounded-xl border-l-4 border-info bg-info/10 p-6">
        <h2 className="font-semibold text-ink">Capture booking revenue (recommended)</h2>
        <p className="mt-1 text-sm text-ink-secondary">
          For the most accurate revenue tracking, mark the booking total on your
          confirmation page with a <code className="text-codeink">data-ht-value</code>{" "}
          attribute. The snippet reads it the moment a booking confirms — no
          personal data is touched.
        </p>
        <div className="mt-4 flex items-start gap-2">
          <code className="block flex-1 overflow-x-auto rounded-lg bg-code px-4 py-3 text-sm text-codeink">
            {`<span data-ht-value="YOUR_BOOKING_AMOUNT">₹X,XXX</span>`}
          </code>
          <CopyButton text={`<span data-ht-value="YOUR_BOOKING_AMOUNT">₹X,XXX</span>`} />
        </div>
        <p className="mt-2 text-xs text-ink-tertiary">
          Replace <code>YOUR_BOOKING_AMOUNT</code> with the variable your booking
          system uses for the total (digits only, e.g. <code>15000</code>). If you
          can&apos;t add this, HotelTrack still tries to read the total from the
          page text or a <code>?amount=</code> URL parameter automatically.
        </p>
      </section>

      {/* ── Platform guide (with tabs) ───────────────────────────────────── */}
      <section className="rounded-xl border border-line p-6">
        <h2 className="font-semibold">Step-by-step guide</h2>

        <div className="mt-3 flex flex-wrap gap-2">
          {SITE_PLATFORMS.map((p) => {
            const isActive = p === active;
            return (
              <Link
                key={p}
                href={`/agency/hotel/${hotel.id}/install?platform=${p}`}
                scroll={false}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                  isActive
                    ? "border-brand bg-brand text-white"
                    : "border-line-strong text-ink-secondary hover:bg-elevated"
                }`}
              >
                {SITE_PLATFORM_LABELS[p]}
                {p === hotel.sitePlatform && !isActive && (
                  <span className="ml-1.5 text-xs text-ink-disabled">· selected</span>
                )}
              </Link>
            );
          })}
        </div>

        <p className="mt-4 text-sm text-ink-secondary">{guide.intro}</p>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-ink-secondary">
          {guide.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
        <p className="mt-4 text-xs text-ink-tertiary">
          We only collect campaign (UTM) and page data — never names, emails, or
          form contents.
        </p>
      </section>

      {/* ── Test connection ──────────────────────────────────────────────── */}
      <section className="rounded-xl border border-line p-6">
        <h2 className="font-semibold">Test connection</h2>
        <div className="mt-3">
          <TestConnection hotelId={hotel.id} />
        </div>
      </section>
    </div>
  );
}
