import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock, Toc } from "./SetupGuideUI";

// Fully public — no auth. Hotels read this on their phone while setting up.
export const dynamic = "force-static";

const PUBLIC_URL = (
  process.env.NEXT_PUBLIC_APP_URL || "https://www.hoteltrack.in"
).replace(/\/$/, "");
const PAGE_URL = `${PUBLIC_URL}/setup-guide`;
const PDF_URL = "/docs/HotelTrack_Integration_Guide.pdf";

export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_URL),
  title: "HotelTrack Setup Guide",
  description:
    "Step-by-step setup for hotels and marketing agencies. 20 minutes total.",
  alternates: { canonical: "/setup-guide" },
  openGraph: {
    title: "HotelTrack Setup Guide",
    description:
      "Step-by-step setup for hotels and marketing agencies. 20 minutes total.",
    url: PAGE_URL,
    siteName: "HotelTrack",
    type: "article",
    images: [
      {
        url: "/og/setup-guide.png",
        width: 1200,
        height: 630,
        alt: "HotelTrack Setup Guide",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "HotelTrack Setup Guide",
    description:
      "Step-by-step setup for hotels and marketing agencies. 20 minutes total.",
    images: ["/og/setup-guide.png"],
  },
};

const TOC = [
  { id: "intro", label: "Introduction" },
  {
    id: "part-1",
    label: "Part 1 — For Hotels",
    children: [
      { id: "section-1-1", label: "1.1 Install website snippet" },
      { id: "section-1-2", label: "1.2 Connect Instagram" },
    ],
  },
  {
    id: "part-2",
    label: "Part 2 — For Agencies",
    children: [
      { id: "section-2-1", label: "2.1 Generate Meta access token" },
      { id: "section-2-2", label: "2.2 Add UTM parameters" },
    ],
  },
  { id: "troubleshooting", label: "Troubleshooting" },
  { id: "faq", label: "FAQ" },
];

// ── Presentational helpers (server components) ───────────────────────────────

type Tone = "info" | "warn" | "success" | "danger";

const TONE: Record<
  Tone,
  { wrap: string; badge: string; label: string; icon: string }
> = {
  info: {
    wrap: "border-info bg-info/10 text-ink-secondary",
    badge: "bg-info text-white",
    label: "text-info",
    icon: "i",
  },
  warn: {
    wrap: "border-warning bg-warning/10 text-ink-secondary",
    badge: "bg-warning text-[#0a0e1a]",
    label: "text-warning",
    icon: "!",
  },
  success: {
    wrap: "border-success bg-success/10 text-ink-secondary",
    badge: "bg-success text-[#0a0e1a]",
    label: "text-success",
    icon: "✓",
  },
  danger: {
    wrap: "border-danger bg-danger/10 text-ink-secondary",
    badge: "bg-danger text-white",
    label: "text-danger",
    icon: "×",
  },
};

function Callout({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title?: string;
  children: React.ReactNode;
}) {
  const t = TONE[tone];
  return (
    <div
      data-callout
      className={`my-4 flex gap-3 rounded-r-xl border-l-4 p-4 text-sm leading-relaxed ${t.wrap}`}
    >
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${t.badge}`}
        aria-hidden
      >
        {t.icon}
      </span>
      <div className="min-w-0">
        {title && <p className={`mb-1 font-semibold ${t.label}`}>{title}</p>}
        <div className="space-y-2">{children}</div>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4 border-t border-line py-5 first:border-t-0">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h4 className="mb-2 font-semibold text-ink">{title}</h4>
        <div className="space-y-3 text-[15px] leading-relaxed text-ink-secondary">
          {children}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({
  id,
  num,
  title,
  meta,
}: {
  id: string;
  num: string;
  title: string;
  meta?: string;
}) {
  return (
    <div id={id} className="scroll-mt-24">
      <span className="text-sm font-bold uppercase tracking-wide text-brand">
        Section {num}
      </span>
      <h3 className="mt-1 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
        {title}
      </h3>
      {meta && <p className="mt-1 text-sm text-ink-tertiary">{meta}</p>}
    </div>
  );
}

function Ol({ children }: { children: React.ReactNode }) {
  return (
    <ol className="ml-1 list-inside list-decimal space-y-1.5 text-ink-secondary marker:font-semibold marker:text-brand">
      {children}
    </ol>
  );
}

function PlatformCard({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-card p-4">
      <p className="mb-2 font-semibold text-ink">If you use {name}</p>
      <div className="text-[15px] leading-relaxed text-ink-secondary">{children}</div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SetupGuidePage() {
  return (
    <div className="min-h-screen bg-page text-ink">
      {/* Print rules: backgrounds print, layout collapses to one readable column */}
      <style>{`
        @media print {
          .sg-codeblock, [data-callout] { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          a[href]:after { content: ""; }
        }
      `}</style>

      {/* Sticky top bar */}
      <header className="sticky top-0 z-30 border-b border-line bg-page/90 backdrop-blur print:static print:bg-page">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-sm font-black text-white">
              H
            </span>
            <span className="text-base font-bold tracking-tight text-ink">
              HotelTrack
            </span>
          </Link>
          <a
            href={PDF_URL}
            download="HotelTrack-Integration-Guide.pdf"
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-hover print:hidden"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Download PDF
          </a>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-line bg-gradient-to-b from-page to-card text-ink">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <span className="inline-block rounded-full bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-codeink">
            Setup Guide · v1.0
          </span>
          <h1 className="mt-4 text-4xl font-black tracking-tight sm:text-5xl">
            HotelTrack Setup Guide
          </h1>
          <p className="mt-3 max-w-2xl text-lg text-ink-secondary">
            Step-by-step instructions for hotels and marketing agencies.
          </p>

          <div className="mt-6 flex flex-wrap gap-3 text-sm">
            <span className="rounded-lg bg-white/10 px-3 py-1.5 font-medium">
              ⏱ 20 minutes total
            </span>
            <span className="rounded-lg bg-white/10 px-3 py-1.5 font-medium">
              🛠 No coding required
            </span>
            <span className="rounded-lg bg-white/10 px-3 py-1.5 font-medium">
              👥 Hotels &amp; agencies
            </span>
          </div>

          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="#part-1"
              className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-hover"
            >
              Part 1 — For Hotels →
            </a>
            <a
              href="#part-2"
              className="rounded-lg border border-white/25 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              Part 2 — For Agencies →
            </a>
          </div>
        </div>
      </section>

      {/* Body: sticky TOC + content */}
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-12">
        <aside className="lg:py-2">
          <Toc items={TOC} />
        </aside>

        <main className="min-w-0 space-y-16">
          {/* ── Introduction ─────────────────────────────────────────────── */}
          <section id="intro" className="scroll-mt-24">
            <h2 className="text-sm font-bold uppercase tracking-wide text-brand">
              Overview
            </h2>
            <h3 className="mt-1 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
              Who this guide is for
            </h3>
            <p className="mt-4 text-[15px] leading-relaxed text-ink-secondary">
              This is the complete setup guide for HotelTrack, covering both
              audiences who need to do the initial configuration.
            </p>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-line bg-card p-5">
                <p className="font-semibold text-ink">For hotels</p>
                <p className="mt-2 text-[15px] leading-relaxed text-ink-secondary">
                  Follow <strong>Part 1</strong>. You&apos;ll install a small
                  tracking code on your website (10 min) and connect your
                  Instagram account (5 min). Total time: ~15 minutes. No
                  technical knowledge required — we provide platform-specific
                  instructions for WordPress, Shopify, Wix, and Squarespace.
                </p>
              </div>
              <div className="rounded-xl border border-line bg-card p-5">
                <p className="font-semibold text-ink">For agencies</p>
                <p className="mt-2 text-[15px] leading-relaxed text-ink-secondary">
                  Follow <strong>Part 2</strong>. You&apos;ll generate a Meta
                  long-lived access token (10 min) and add UTM parameters to
                  Meta ads (5 min per ad account). This enables campaign
                  attribution and ad-performance tracking on the dashboard.
                </p>
              </div>
            </div>

            <p className="mt-4 text-[15px] leading-relaxed text-ink-secondary">
              Both parts are independent. You can complete them in any order, or
              split the work between hotel staff and agency staff.
            </p>

            <Callout tone="info" title="What you'll need before starting">
              <ul className="list-inside list-disc space-y-1">
                <li>
                  <strong>For hotels:</strong> access to your website&apos;s
                  admin panel, your Instagram account login, and the HotelTrack
                  Site ID provided by your agency.
                </li>
                <li>
                  <strong>For agencies:</strong> a Meta Developer account, the
                  hotel&apos;s Facebook Page admin access, and the connected Meta
                  Ads account ID.
                </li>
              </ul>
            </Callout>
          </section>

          {/* ── PART 1 ───────────────────────────────────────────────────── */}
          <section id="part-1" className="scroll-mt-24">
            <div className="rounded-2xl bg-gradient-to-br from-brand to-brand-hover px-6 py-5 text-white">
              <p className="text-xs font-bold uppercase tracking-widest text-codeink">
                Part 1 of 2
              </p>
              <h2 className="mt-1 text-2xl font-bold">For Hotels</h2>
              <p className="mt-1 text-sm text-ink-secondary">
                Install the website snippet and connect Instagram.
              </p>
            </div>

            {/* Section 1.1 */}
            <div className="mt-10 space-y-6">
              <SectionTitle
                id="section-1-1"
                num="1.1"
                title="Install Website Tracking Snippet"
                meta="10 minutes · Done once, runs automatically"
              />

              <Callout tone="info" title="What this does">
                We give you a small piece of code (a snippet) to add to your
                website. Once installed, it silently tracks which marketing
                channels bring visitors to your site and records when visitors
                complete a booking. You can see all of this in real time on your
                HotelTrack dashboard. The snippet does <strong>not</strong> slow
                down your website or change anything visitors can see.
              </Callout>

              <div className="rounded-2xl border border-line p-2 sm:p-4">
                <Step n={1} title="Get your tracking code from the agency">
                  <p>
                    Your marketing agency will provide you with a snippet that
                    looks like this:
                  </p>
                  <CodeBlock
                    caption="Tracking snippet"
                    code={`<script src="https://hoteltrack.in/t.js?id=YOUR-SITE-ID" async></script>`}
                  />
                  <p>
                    Save this code somewhere you can copy from later — like a
                    Notes app or email draft. You&apos;ll paste it into your
                    website in the next step.
                  </p>
                </Step>

                <Step n={2} title="Add the code to your website">
                  <p>
                    The exact steps depend on what platform your website is built
                    on. Find your platform below and follow those specific
                    instructions.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <PlatformCard name="WordPress">
                      <Ol>
                        <li>
                          Log into your WordPress admin panel (usually
                          yoursite.com/wp-admin)
                        </li>
                        <li>
                          Install the free plugin <strong>Insert Headers and
                          Footers</strong> if you don&apos;t have it (Plugins →
                          Add New → search → Install → Activate)
                        </li>
                        <li>Go to Settings → Insert Headers and Footers</li>
                        <li>
                          Paste the snippet code into the{" "}
                          <strong>Scripts in Footer</strong> box
                        </li>
                        <li>Click Save</li>
                      </Ol>
                    </PlatformCard>

                    <PlatformCard name="Shopify">
                      <Ol>
                        <li>Log into your Shopify admin</li>
                        <li>Go to Online Store → Themes</li>
                        <li>Click Actions → Edit code</li>
                        <li>
                          Open the file <code>theme.liquid</code>
                        </li>
                        <li>
                          Find the closing <code>&lt;/body&gt;</code> tag (near
                          the bottom)
                        </li>
                        <li>
                          Paste the snippet code just BEFORE the{" "}
                          <code>&lt;/body&gt;</code> tag
                        </li>
                        <li>Click Save</li>
                      </Ol>
                    </PlatformCard>

                    <PlatformCard name="Wix">
                      <Ol>
                        <li>Log into your Wix dashboard</li>
                        <li>Go to Settings → Custom Code (under Advanced)</li>
                        <li>Click + Add Custom Code</li>
                        <li>Paste the snippet into the code box</li>
                        <li>
                          Name it HotelTrack; Add Code to Pages: All pages; Place
                          Code in: Body – end
                        </li>
                        <li>Click Apply</li>
                      </Ol>
                    </PlatformCard>

                    <PlatformCard name="Squarespace">
                      <Ol>
                        <li>Log into your Squarespace site</li>
                        <li>Go to Settings → Advanced → Code Injection</li>
                        <li>
                          Paste the snippet code into the <strong>Footer</strong>{" "}
                          box
                        </li>
                        <li>Click Save</li>
                      </Ol>
                    </PlatformCard>

                    <PlatformCard name="a custom website or another platform">
                      <Ol>
                        <li>
                          Ask your web developer or whoever maintains your
                          website to add the snippet just before the closing{" "}
                          <code>&lt;/body&gt;</code> tag of every page. It&apos;s
                          a one-line addition.
                        </li>
                        <li>
                          If you don&apos;t know who manages your website, share
                          this guide with your marketing agency.
                        </li>
                      </Ol>
                    </PlatformCard>
                  </div>
                </Step>

                <Step n={3} title="Verify the snippet is working">
                  <p>
                    Once the code is added, your marketing agency can verify it
                    from the HotelTrack dashboard. They&apos;ll see a status
                    indicator change from <strong>Not Installed</strong> to{" "}
                    <strong>Live</strong> within a few minutes.
                  </p>
                  <Callout tone="success" title="Status shows Live">
                    You&apos;re done with Part 1. The snippet is now silently
                    tracking visitors and bookings.
                  </Callout>
                  <Callout
                    tone="warn"
                    title="Status stays Not Installed after 10 min"
                  >
                    The code might not have been saved correctly, or might be on
                    the wrong page. Contact your agency — they can diagnose in 5
                    minutes.
                  </Callout>
                </Step>
              </div>
            </div>

            {/* Section 1.2 */}
            <div className="mt-12 space-y-6">
              <SectionTitle
                id="section-1-2"
                num="1.2"
                title="Connect Your Instagram Account"
                meta="5–10 minutes · One-time setup"
              />

              <Callout tone="info" title="What this does">
                HotelTrack reads your Instagram account&apos;s public performance
                data — follower count, post engagement, reach, profile views.
                This appears alongside your ad and booking data on the dashboard.
                We never post anything, never see your DMs, and never make any
                changes to your account.
              </Callout>

              <div className="rounded-2xl border border-line p-2 sm:p-4">
                <Step n={1} title="Verify Instagram account type">
                  <p>
                    Instagram lets HotelTrack read insights data ONLY from{" "}
                    <strong>Business</strong> or <strong>Creator</strong>{" "}
                    accounts (not Personal accounts). Most hotels already have a
                    Business account — but let&apos;s verify:
                  </p>
                  <Ol>
                    <li>Open the Instagram app on your phone</li>
                    <li>Go to your Profile (bottom-right tab)</li>
                    <li>Tap the menu (three lines, top-right)</li>
                    <li>Tap Settings and activity</li>
                    <li>Tap Account type and tools</li>
                  </Ol>
                  <Callout tone="success" title="It says Business or Creator">
                    Perfect. You can skip ahead to Step 2.
                  </Callout>
                  <Callout tone="warn" title="It says Personal">
                    Tap <strong>Switch to professional account</strong> and
                    choose <strong>Business</strong>. This is free, takes 30
                    seconds, and doesn&apos;t change anything visitors see on
                    your profile.
                  </Callout>
                </Step>

                <Step n={2} title="Open the HotelTrack dashboard">
                  <p>
                    Your marketing agency will share a unique link with you. The
                    link looks like:
                  </p>
                  <CodeBlock
                    caption="Your integrations link"
                    code={`https://www.hoteltrack.in/agency/hotel/cmq2667w…/integrations`}
                  />
                  <Ol>
                    <li>Click the link your agency sent</li>
                    <li>
                      You&apos;ll see a page with several integrations listed
                      (Meta Ads, Instagram, Website Snippet)
                    </li>
                    <li>Find the Instagram card</li>
                    <li>
                      Click the <strong>Log in with Instagram</strong> button
                      (gradient purple/orange)
                    </li>
                  </Ol>
                </Step>

                <Step n={3} title="Authorize HotelTrack on Instagram">
                  <p>
                    You&apos;ll be redirected to Instagram&apos;s official login
                    page. Here&apos;s what happens:
                  </p>
                  <Ol>
                    <li>
                      If you&apos;re not already logged in, log in with the
                      account you post from
                    </li>
                    <li>
                      Instagram shows a permissions screen: “HotelTrack-IG would
                      like to access your account”
                    </li>
                    <li>
                      Review the permissions (read-only — we cannot post,
                      message, or change your account)
                    </li>
                    <li>Tap Allow or Continue</li>
                    <li>Wait for the page to redirect back to HotelTrack</li>
                  </Ol>
                  <Callout tone="warn" title="Don't close the page">
                    The redirect back to HotelTrack happens automatically.
                    Don&apos;t close the tab during this step — wait for it to
                    complete (usually under 5 seconds).
                  </Callout>
                </Step>

                <Step n={4} title="Confirm the connection worked">
                  <p>
                    After the redirect completes, you&apos;ll be back on the
                    HotelTrack integrations page. You should see:
                  </p>
                  <ul className="list-inside space-y-1">
                    <li>✓ Your Instagram profile picture displayed</li>
                    <li>✓ Your Instagram username shown below the picture</li>
                    <li>
                      ✓ A green <strong>Connected</strong> badge in the top-right
                      of the card
                    </li>
                    <li>✓ Last synced showing a fresh timestamp</li>
                  </ul>
                  <Callout tone="success" title="All four items checked? You're done!">
                    Your Instagram account is now connected. HotelTrack will pull
                    your performance data daily. First data appears within 24
                    hours.
                  </Callout>
                </Step>
              </div>
            </div>
          </section>

          {/* ── PART 2 ───────────────────────────────────────────────────── */}
          <section id="part-2" className="scroll-mt-24">
            <div className="rounded-2xl bg-gradient-to-br from-brand to-brand-hover px-6 py-5 text-white">
              <p className="text-xs font-bold uppercase tracking-widest text-codeink">
                Part 2 of 2
              </p>
              <h2 className="mt-1 text-2xl font-bold">For Agencies</h2>
              <p className="mt-1 text-sm text-ink-secondary">
                Generate a Meta access token and tag your ads with UTMs.
              </p>
            </div>

            {/* Section 2.1 */}
            <div className="mt-10 space-y-6">
              <SectionTitle
                id="section-2-1"
                num="2.1"
                title="Generate Meta Access Token"
                meta="10 minutes · One-time setup per ad account"
              />

              <Callout tone="info" title="What this does">
                A Meta long-lived access token gives HotelTrack permission to
                read your hotel client&apos;s Meta Ads spend, campaign
                performance, and ad-level insights. This token is the foundation
                for paid-ad attribution. Tokens last ~60 days and must be
                regenerated before expiry.
              </Callout>

              <Callout tone="info" title="Prerequisites">
                <ul className="list-inside list-disc space-y-1">
                  <li>A Meta Developer Account (developers.facebook.com)</li>
                  <li>A Meta App created (Business type)</li>
                  <li>Your Facebook account added as App Admin</li>
                  <li>
                    Hotel&apos;s Instagram Professional Account (Business or
                    Creator)
                  </li>
                  <li>Hotel&apos;s Instagram connected to their Facebook Page</li>
                </ul>
              </Callout>

              <div className="rounded-2xl border border-line p-2 sm:p-4">
                <Step n={1} title="Create a Meta App">
                  <p>
                    If you don&apos;t have a Meta App already, create one first:
                  </p>
                  <Ol>
                    <li>Go to developers.facebook.com and log in</li>
                    <li>Click My Apps in the top navigation</li>
                    <li>Click Create App</li>
                    <li>Select Business as the app type</li>
                    <li>Enter App Name (e.g., “HotelTrack-MyAgency”)</li>
                    <li>Click Create App</li>
                  </Ol>
                </Step>

                <Step n={2} title="Add required products to the app">
                  <p>Inside your App Dashboard, add these products:</p>
                  <ul className="list-inside list-disc space-y-1">
                    <li>
                      <strong>Facebook Login for Business</strong> — for OAuth
                      permissions
                    </li>
                    <li>
                      <strong>Instagram Graph API</strong> — for Instagram
                      insights data
                    </li>
                    <li>
                      <strong>Marketing API</strong> — for Meta Ads campaign data
                    </li>
                  </ul>
                  <p>Click Save changes after adding each product.</p>
                </Step>

                <Step n={3} title="Verify app roles">
                  <p>Verify your Facebook account has Admin role on the app:</p>
                  <Ol>
                    <li>Open App Dashboard</li>
                    <li>Go to App Roles in the left sidebar</li>
                    <li>Verify your Facebook account appears as Admin</li>
                    <li>
                      If not, click Add People, add your account, and accept the
                      invitation from the Facebook app
                    </li>
                  </Ol>
                </Step>

                <Step n={4} title="Generate short-lived access token">
                  <p>Generate a short-lived token via Graph API Explorer:</p>
                  <Ol>
                    <li>Open developers.facebook.com/tools/explorer</li>
                    <li>
                      At the top right, select your Meta App (NOT “Graph API
                      Explorer”)
                    </li>
                    <li>Click Generate Access Token</li>
                    <li>Log in with your Facebook account when prompted</li>
                    <li>Approve all permissions requested</li>
                  </Ol>
                  <p className="font-semibold text-ink">
                    Required permissions:
                  </p>
                  <ul className="list-inside list-disc space-y-1">
                    <li>
                      <code>ads_read</code> — read ad insights and campaign data
                    </li>
                    <li>
                      <code>business_management</code> — access business assets
                    </li>
                    <li>
                      <code>pages_show_list</code> — list managed Pages
                    </li>
                    <li>
                      <code>pages_read_engagement</code> — read Page engagement
                      data
                    </li>
                    <li>
                      <code>instagram_basic</code> — read Instagram profile
                      basics
                    </li>
                    <li>
                      <code>instagram_manage_insights</code> — read Instagram
                      insights
                    </li>
                  </ul>
                  <p>
                    After approval, Meta generates your short-lived token. It
                    looks like: <code>EAABxxxxxxxxxxxxxxxxxxxxx</code>
                  </p>
                </Step>

                <Step n={5} title="Get your App ID and App Secret">
                  <p>From your App Dashboard:</p>
                  <Ol>
                    <li>Open App Settings → Basic</li>
                    <li>
                      Copy the App ID (a long number like 2092534938335931)
                    </li>
                    <li>
                      Click Show next to App Secret and copy the value
                    </li>
                    <li>
                      Save both somewhere secure — you&apos;ll need them next
                    </li>
                  </Ol>
                  <Callout tone="danger" title="Never share the App Secret">
                    The App Secret is like a password for your Meta App. Never
                    paste it in chat, email, or public documents. Treat it with
                    the same care as your bank credentials.
                  </Callout>
                </Step>

                <Step n={6} title="Exchange for long-lived token">
                  <p>
                    Short-lived tokens expire in about 1 hour. We need to
                    exchange yours for a long-lived token (~60 days). Use this URL
                    in your browser, replacing the three values:
                  </p>
                  <CodeBlock
                    caption="Token exchange URL"
                    code={`https://graph.facebook.com/v23.0/oauth/access_token?grant_type=fb_exchange_token&client_id=YOUR_APP_ID&client_secret=YOUR_APP_SECRET&fb_exchange_token=YOUR_SHORT_LIVED_TOKEN`}
                  />
                  <p className="font-semibold text-ink">Replace:</p>
                  <ul className="list-inside list-disc space-y-1">
                    <li>
                      <code>YOUR_APP_ID</code> — your App ID from Step 5
                    </li>
                    <li>
                      <code>YOUR_APP_SECRET</code> — your App Secret from Step 5
                    </li>
                    <li>
                      <code>YOUR_SHORT_LIVED_TOKEN</code> — the EAAB token from
                      Step 4
                    </li>
                  </ul>
                  <Callout tone="warn" title="Formatting rules">
                    No spaces between parameters. No “%20” encoding. Token must
                    start with EAAB (not IGAA). Combine into one single line in
                    your browser.
                  </Callout>
                </Step>

                <Step n={7} title="Receive and verify long-lived token">
                  <p>Meta returns a response that looks like this:</p>
                  <CodeBlock
                    caption="Response"
                    code={`{
  "access_token": "EAABxxxxxxxxxxxxxxxx",
  "token_type": "bearer",
  "expires_in": 5184000
}`}
                  />
                  <p>
                    5184000 seconds ≈ 60 days. This is your long-lived access
                    token. Copy the <code>access_token</code> value (everything
                    between the quotes after <code>&quot;access_token&quot;:</code>).
                  </p>
                  <Callout tone="info" title="Verify the token works">
                    <p>Test it by visiting:</p>
                    <CodeBlock code={`https://graph.facebook.com/me?access_token=YOUR_LONG_LIVED_TOKEN`} />
                    <p>
                      If successful, you&apos;ll see your name and Facebook ID. If
                      you see an error, regenerate from Step 4.
                    </p>
                  </Callout>
                </Step>

                <Step n={8} title="Connect in HotelTrack">
                  <p>Now paste this token into HotelTrack:</p>
                  <Ol>
                    <li>Log into HotelTrack as an agency admin</li>
                    <li>Go to the hotel client → Integrations</li>
                    <li>Find the Meta Ads card</li>
                    <li>Click Connect Meta</li>
                    <li>Paste the long-lived token</li>
                    <li>Click Validate &amp; Connect</li>
                    <li>
                      HotelTrack discovers connected Pages and ad accounts —
                      select the right one for this hotel
                    </li>
                  </Ol>
                  <p>
                    Within minutes, ad spend and campaign data starts flowing into
                    the dashboard.
                  </p>
                </Step>
              </div>

              <div className="space-y-3">
                <h4 className="text-lg font-bold text-ink">
                  Common Errors &amp; Fixes
                </h4>
                <Callout tone="danger" title="Error 190 — Invalid OAuth access token">
                  <p>
                    <strong>Cause:</strong> Token is wrong, expired, or
                    incomplete (most often from copy-paste truncating the token).
                  </p>
                  <p>
                    <strong>Fix:</strong> Regenerate a fresh token starting from
                    Step 4.
                  </p>
                </Callout>
                <Callout tone="danger" title="Insufficient Developer Role">
                  <p>
                    <strong>Cause:</strong> Your account isn&apos;t an Admin,
                    Developer, or Tester on the Meta App.
                  </p>
                  <p>
                    <strong>Fix:</strong> Have the App Admin add your account
                    under App Dashboard → App Roles.
                  </p>
                </Callout>
                <Callout tone="danger" title="Cannot parse access token">
                  <p>
                    <strong>Cause:</strong> Spaces or encoding in the URL, OR you
                    used an Instagram token (IGAA) instead of a Facebook token
                    (EAAB).
                  </p>
                  <p>
                    <strong>Fix:</strong> Verify the token starts with EAAB (not
                    IGAA). Remove any spaces from the URL.
                  </p>
                </Callout>
              </div>
            </div>

            {/* Section 2.2 */}
            <div className="mt-12 space-y-6">
              <SectionTitle
                id="section-2-2"
                num="2.2"
                title="Add UTM Parameters to Meta Ads"
                meta="5 minutes per ad account · One-time setup"
              />

              <Callout tone="info" title="Why this matters">
                Without UTM tags on your Meta ads, HotelTrack cannot connect ad
                clicks to real bookings. The matching layer has nothing to match
                on, so the Campaign Performance dashboard shows empty data even
                though Meta is reporting spend. Five minutes of setup unlocks the
                whole campaign-attribution feature.
              </Callout>

              <div className="rounded-2xl border border-line bg-card p-5">
                <p className="font-semibold text-ink">How the matching works</p>
                <ol className="mt-2 ml-1 list-inside list-decimal space-y-1.5 text-[15px] leading-relaxed text-ink-secondary marker:font-semibold marker:text-brand">
                  <li>
                    Agency creates an ad in Meta Ads Manager called “Monsoon
                    Promo”
                  </li>
                  <li>
                    You add <code>utm_campaign=&#123;&#123;campaign.name&#125;&#125;</code>{" "}
                    to the ad&apos;s URL parameters
                  </li>
                  <li>
                    Someone clicks the ad and lands on the hotel site with{" "}
                    <code>?utm_campaign=Monsoon Promo</code> in the URL
                  </li>
                  <li>
                    HotelTrack&apos;s snippet captures the campaign name in a
                    30-day cookie
                  </li>
                  <li>If the visitor books, the booking is tagged with that campaign</li>
                  <li>
                    Daily cron matches Meta&apos;s “Monsoon Promo” spend with your
                    real bookings
                  </li>
                  <li>
                    Dashboard shows: Monsoon Promo → ₹45,000 spent → 12 real
                    bookings → True ROAS 5.3×
                  </li>
                </ol>
              </div>

              <div className="rounded-2xl border border-line p-2 sm:p-4">
                <Step n={1} title="Open Meta Ads Manager">
                  <p>
                    Go to business.facebook.com/adsmanager, log in, and select the
                    ad account whose token is connected to HotelTrack.
                  </p>
                  <Callout tone="info">
                    <strong>Tip:</strong> confirm you&apos;re in the correct
                    account by checking the account ID at the top. It should match
                    the <code>act_…</code> number shown on HotelTrack&apos;s Meta
                    integration page.
                  </Callout>
                </Step>

                <Step n={2} title="Choose your setup method">
                  <p>
                    You have two options. Pick the one that suits your account:
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-line bg-card p-4">
                      <p className="mb-2 font-semibold text-ink">
                        Option A — Account-level defaults{" "}
                        <span className="text-brand">(recommended)</span>
                      </p>
                      <Ol>
                        <li>
                          Look for Account Settings or settings gear → URL
                          parameters
                        </li>
                        <li>
                          If available, paste the UTM string from Step 3 once
                        </li>
                        <li>
                          Applies to all current and future ads automatically
                        </li>
                      </Ol>
                    </div>
                    <div className="rounded-xl border border-line bg-card p-4">
                      <p className="mb-2 font-semibold text-ink">
                        Option B — Edit each ad individually
                      </p>
                      <Ol>
                        <li>
                          Go to Ads Manager → Ads tab (the bottom level, not
                          Campaigns or Ad Sets)
                        </li>
                        <li>Click an ad → click Edit</li>
                        <li>
                          Scroll down to the Tracking section (sometimes hidden
                          under “Show more options”)
                        </li>
                        <li>
                          Paste the UTM string from Step 3 into the URL parameters
                          field
                        </li>
                        <li>Click Publish — repeat for each ad</li>
                      </Ol>
                    </div>
                  </div>
                </Step>

                <Step n={3} title="Paste the UTM string">
                  <p>
                    Whether you use Option A or B, the UTM string to paste is
                    identical. Copy this exactly:
                  </p>
                  <CodeBlock
                    caption="UTM string"
                    code={`utm_source=facebook&utm_medium=cpc&utm_campaign={{campaign.name}}&utm_content={{ad.name}}`}
                  />
                  <p>
                    The double-curly placeholders are Meta&apos;s built-in dynamic
                    variables. Meta automatically substitutes them with real
                    values when each ad runs.
                  </p>
                  <ul className="list-inside list-disc space-y-1">
                    <li>
                      <code>&#123;&#123;campaign.name&#125;&#125;</code> → Meta
                      substitutes with the campaign name (e.g., “Monsoon Promo”)
                    </li>
                    <li>
                      <code>&#123;&#123;ad.name&#125;&#125;</code> → Meta
                      substitutes with the ad name (e.g., “Monsoon Reel Variant
                      A”)
                    </li>
                  </ul>
                  <Callout tone="warn" title="Important">
                    Type the placeholders exactly as shown, including the double
                    curly braces. Don&apos;t modify, translate, or wrap them in
                    quotes. Meta only recognizes them in this exact format.
                  </Callout>
                </Step>

                <Step n={4} title="Verify it's working">
                  <p>Quick test to confirm Meta is auto-tagging correctly:</p>
                  <Ol>
                    <li>
                      In Ads Manager, click the preview link on one of your edited
                      ads (or visit the live ad on Facebook)
                    </li>
                    <li>Click through to the landing page as if you&apos;re a visitor</li>
                    <li>Look at the URL in your browser&apos;s address bar</li>
                    <li>It should now contain:</li>
                  </Ol>
                  <CodeBlock code={`?utm_source=facebook&utm_medium=cpc&utm_campaign=YourCampaignName…`} />
                  <Callout tone="success" title="Success">
                    If you see UTM tags in the URL, Meta is auto-tagging every
                    click. HotelTrack&apos;s daily cron will start producing
                    campaign-attributed data at 2am UTC tomorrow.
                  </Callout>
                  <Callout
                    tone="warn"
                    title="Caveat — attribution only works going forward"
                  >
                    Ads that ran BEFORE you added UTM parameters cannot be
                    retroactively attributed. Their clicks arrived without UTM
                    tags. Historical Meta spend still appears on the dashboard,
                    but as “Direct / Unattributed”. When demoing to hotels, set
                    expectations: “Real attribution data starts from the day we
                    add UTM tags. The first 2–4 weeks will be partial.”
                  </Callout>
                </Step>
              </div>
            </div>
          </section>

          {/* ── Troubleshooting ──────────────────────────────────────────── */}
          <section id="troubleshooting" className="scroll-mt-24 space-y-6">
            <div>
              <span className="text-sm font-bold uppercase tracking-wide text-brand">
                Appendix
              </span>
              <h3 className="mt-1 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
                Troubleshooting common issues
              </h3>
            </div>

            <div className="divide-y divide-line rounded-2xl border border-line">
              {[
                {
                  q: "Snippet shows 'Not Installed' after I added the code",
                  a: "Most often: the code was added but not saved, or added to the wrong page (only homepage, missing /book page). Ask your agency to verify which pages have the snippet.",
                },
                {
                  q: "Instagram OAuth completes but card stays 'Not Connected'",
                  a: "Browser may have blocked the redirect, or your Instagram account is still set to Personal. Try in incognito with a Business/Creator account.",
                },
                {
                  q: "Meta token validation fails with 'Invalid access token'",
                  a: "Token may have been truncated during copy-paste. Regenerate from Graph API Explorer, copy the entire string at once.",
                },
                {
                  q: "Campaign Performance dashboard shows empty",
                  a: "Most often: UTM parameters not yet added to Meta ads. Complete Part 2.2 of this guide. Data starts appearing 24 hours after UTM setup.",
                },
                {
                  q: "Dashboard shows wrong currency or formatting",
                  a: "Check the hotel's locale setting in HotelTrack admin. Default is ₹ (INR) but can be customized per hotel.",
                },
              ].map((item) => (
                <div key={item.q} className="p-5">
                  <p className="font-semibold text-ink">{item.q}</p>
                  <p className="mt-1 text-[15px] leading-relaxed text-ink-secondary">
                    {item.a}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* ── FAQ ──────────────────────────────────────────────────────── */}
          <section id="faq" className="scroll-mt-24 space-y-6">
            <div>
              <span className="text-sm font-bold uppercase tracking-wide text-brand">
                Appendix
              </span>
              <h3 className="mt-1 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
                Frequently asked questions
              </h3>
            </div>

            <div className="space-y-3">
              {[
                {
                  q: "Will the snippet slow down my hotel's website?",
                  a: "No. The snippet loads asynchronously (in the background) and is under 10KB — smaller than a single image on your homepage. It has no measurable impact on page load speed.",
                },
                {
                  q: "Can HotelTrack see my Instagram DMs or post on my behalf?",
                  a: "No. We have read-only access to public insights only. We cannot read messages, post content, comment, change your bio, or perform any action on your account.",
                },
                {
                  q: "What if the hotel wants to disconnect later?",
                  a: "For Instagram: open Instagram app → Settings → Apps and websites → Active → tap HotelTrack-IG → Remove. For website snippet: just delete the code from your website. Both take 30 seconds. We immediately stop syncing data.",
                },
                {
                  q: "Is the data secure?",
                  a: "Yes. All tokens are encrypted at rest using AES-256. We never share your data with third parties. Data deletion can be requested anytime via support@hoteltrack.in.",
                },
                {
                  q: "What if the hotel changes their Instagram password?",
                  a: "Your password is never shared with HotelTrack. We use Instagram's official OAuth system. Changing your password doesn't affect the connection — you only need to reconnect if you explicitly revoke our access from Instagram's settings.",
                },
                {
                  q: "How often does Meta data refresh on the dashboard?",
                  a: "Meta Ads data syncs once daily at 2am UTC (7:30am IST). Instagram organic data syncs daily at 3am UTC. The website snippet captures visits and conversions in real-time (instant).",
                },
                {
                  q: "What happens when a Meta token expires (after 60 days)?",
                  a: "HotelTrack alerts you via email 7 days before expiry. You generate a fresh token following Steps 4–7 of Part 2.1 and paste it back into the Meta integration card. Historical data is preserved.",
                },
                {
                  q: "Can multiple agencies manage the same hotel?",
                  a: "Currently each hotel client has one agency owner. If a hotel switches agencies, the new agency receives transfer access from the old one.",
                },
              ].map((item) => (
                <details
                  key={item.q}
                  className="group rounded-xl border border-line bg-card p-4 open:bg-card"
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between font-semibold text-ink">
                    {item.q}
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="h-4 w-4 shrink-0 text-ink-disabled transition-transform group-open:rotate-180"
                    >
                      <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </summary>
                  <p className="mt-2 text-[15px] leading-relaxed text-ink-secondary">
                    {item.a}
                  </p>
                </details>
              ))}
            </div>

            <Callout tone="info" title="Need help?">
              Email{" "}
              <a className="font-medium underline" href="mailto:support@hoteltrack.in">
                support@hoteltrack.in
              </a>{" "}
              with your hotel name and a description of the issue. Our team
              responds within 24 hours during business days (Mon–Fri, 10am–6pm
              IST). For urgent issues, contact your marketing agency — they have
              direct access to diagnostic tools and can usually resolve issues in
              minutes.
            </Callout>
          </section>

          {/* Bottom download CTA */}
          <section className="rounded-2xl border border-line bg-card p-6 text-center print:hidden">
            <p className="text-lg font-bold text-ink">
              Prefer a printable copy?
            </p>
            <p className="mt-1 text-sm text-ink-secondary">
              Download the full guide as a PDF to share or print.
            </p>
            <a
              href={PDF_URL}
              download="HotelTrack-Integration-Guide.pdf"
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-hover"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Download PDF
            </a>
          </section>
        </main>
      </div>

      {/* Footer */}
      <footer className="border-t border-line py-8 text-center text-sm text-ink-tertiary">
        HotelTrack · Complete Setup Guide · Version 1.0 ·{" "}
        <a href="https://www.hoteltrack.in" className="font-medium text-brand hover:underline">
          www.hoteltrack.in
        </a>
      </footer>
    </div>
  );
}
