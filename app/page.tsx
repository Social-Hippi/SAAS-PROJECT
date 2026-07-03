import Link from "next/link";
import { redirect } from "next/navigation";
import { Playfair_Display } from "next/font/google";
import { Show, UserButton } from "@clerk/nextjs";
import {
  Wallet,
  Route,
  Unlink,
  TrendingUp,
  Filter,
  BadgePercent,
  Target,
  Network,
  Code2,
  PlugZap,
  LayoutDashboard,
  ArrowRight,
  Play,
  Mail,
  MousePointerClick,
  Crosshair,
} from "lucide-react";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { getPlatformRole } from "@/lib/auth";

// Public marketing landing page for HotelTrack — the ONLY app surface that renders
// for logged-out visitors (it sits in the proxy's isPublicRoute list).
//
// COLOR: this page intentionally does NOT use the app-wide blue+gold tokens (those
// dress every dashboard/admin screen). Instead it carries its own self-contained
// EMERALD palette, scoped to the `.ht-lp` wrapper via the <style> block below, so
// the marketing surface gets a distinct boutique-hospitality identity without
// touching the product UI. Dark is the primary look (deep near-black with a green
// undertone, vivid emerald accent, one gold detail); a polished off-white light
// theme is provided too. Both follow the app's existing `.light`/`.dark` toggle
// (the wrapper defaults to dark; `.light .ht-lp` overrides to the light palette).
//
// Hotel owners (hotel_client) who reach here — directly or after being bounced off
// an agency-only route by the proxy — are forwarded to their own hotel dashboard,
// carrying any "agency-restricted" notice so the dashboard can explain the bounce.
// Everyone else (signed-out OR agency/admin) sees the landing page; signed-in users
// get a "Go to dashboard" link in place of Sign in.

export const dynamic = "force-dynamic";

// Serif display face for headlines (Playfair) — scoped to this page via the CSS
// variable below, so the rest of the app's Inter typography is untouched.
const playfair = Playfair_Display({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-playfair",
  display: "swap",
});

const serif = { fontFamily: "var(--font-playfair), Georgia, 'Times New Roman', serif" };

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { userId } = await auth();
  if (userId) {
    const role = await getPlatformRole();
    if (role === "hotel_client") {
      const hotel = await prisma.hotelClient.findFirst({
        where: { createdByUserId: userId, deletedAt: null },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      if (hotel) {
        const sp = await searchParams;
        const notice = sp.notice === "agency-restricted" ? "?notice=agency-restricted" : "";
        redirect(`/hotel/${hotel.id}/dashboard${notice}`);
      }
    }
  }

  return (
    <div
      className={`${playfair.variable} ht-lp min-h-screen scroll-smooth bg-[var(--lp-bg)] text-[var(--lp-ink)] antialiased`}
    >
      {/* Scoped emerald palette + hero motion. Everything below references these
          vars, so the page recolors light/dark with zero hardcoded hex in markup. */}
      <style>{LP_STYLES}</style>

      {/* ── Top nav ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-[var(--lp-border)] bg-[var(--lp-nav-bg)] backdrop-blur-xl">
        <nav
          aria-label="Primary"
          className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-5 py-3.5 sm:px-8"
        >
          <Link
            href="/"
            className="flex items-center gap-2.5 text-lg font-semibold tracking-tight"
            aria-label="HotelTrack home"
          >
            <Logo />
            <span style={serif} className="text-xl font-bold">
              HotelTrack
            </span>
          </Link>

          {/* Center nav links — desktop only. */}
          <div className="hidden items-center gap-9 md:flex">
            {NAV_LINKS.map(({ label, href }) => (
              <a
                key={label}
                href={href}
                className="text-sm font-medium text-[var(--lp-ink-muted)] transition-colors hover:text-[var(--lp-ink)]"
              >
                {label}
              </a>
            ))}
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            <Show when="signed-out">
              <Link
                href="/sign-in"
                className="hidden text-sm font-medium text-[var(--lp-ink-muted)] transition-colors hover:text-[var(--lp-ink)] sm:inline"
              >
                Sign in
              </Link>
              <a href="#demo" className={btnSolid}>
                Book a Demo
              </a>
            </Show>
            <Show when="signed-in">
              <Link href="/agency/dashboard" className={btnSolid}>
                Go to dashboard
              </Link>
              <UserButton />
            </Show>
          </div>
        </nav>
      </header>

      {/* ── Hero ────────────────────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden">
        {/* Emerald grid + two slow-drifting glows behind the hero. */}
        <div aria-hidden="true" className="lp-hero-grid absolute inset-0 -z-10" />
        <div aria-hidden="true" className="lp-glow lp-glow-1 absolute -z-10 rounded-full" />
        <div aria-hidden="true" className="lp-glow lp-glow-2 absolute -z-10 rounded-full" />

        <div className="mx-auto flex max-w-4xl flex-col items-center px-5 pb-20 pt-20 text-center sm:px-8 sm:pb-28 sm:pt-28">
          <span className="inline-flex items-center gap-2 rounded-full border border-[var(--lp-emerald-border)] bg-[var(--lp-emerald-tint)] px-4 py-1.5 text-xs font-medium tracking-wide text-[var(--lp-emerald)] sm:text-sm">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--lp-emerald)]" />
            All-In-One Hotel Marketing Attribution Platform
          </span>

          <h1
            style={serif}
            className="mt-7 text-balance text-4xl font-bold leading-[1.08] tracking-tight sm:text-5xl md:text-[3.75rem]"
          >
            Know What Drives Bookings.
            <br />
            <span className="text-[var(--lp-emerald)]">Grow Direct Revenue.</span>
          </h1>

          <p className="mt-6 max-w-2xl text-pretty text-base leading-relaxed text-[var(--lp-ink-muted)] sm:text-lg">
            HotelTrack helps hotels track every marketing touchpoint, measure true
            ROI, and increase direct bookings with confidence.
          </p>

          <div className="mt-9 flex w-full flex-col items-center gap-3.5 sm:w-auto sm:flex-row">
            <a href="#demo" className={`${btnSolid} w-full justify-center sm:w-auto`}>
              Book a Demo
              <ArrowRight aria-hidden="true" className="h-4 w-4" strokeWidth={2.25} />
            </a>
            <a href="#how" className={`${btnOutline} w-full justify-center sm:w-auto`}>
              <Play aria-hidden="true" className="h-3.5 w-3.5 fill-current" />
              See How It Works
            </a>
          </div>

          {/* Three feature highlights. */}
          <ul className="mt-12 grid w-full gap-x-8 gap-y-5 text-left sm:grid-cols-3">
            {HIGHLIGHTS.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex items-start gap-3">
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--lp-emerald-tint)] text-[var(--lp-emerald)]">
                  <Icon aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
                </span>
                <span>
                  <span className="block text-sm font-semibold">{title}</span>
                  <span className="block text-sm text-[var(--lp-ink-muted)]">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Dashboard preview — placeholder slot until a real screenshot is dropped in. */}
        <div className="mx-auto -mb-24 max-w-5xl px-5 sm:px-8">
          <div
            role="img"
            aria-label="HotelTrack attribution dashboard preview (placeholder)"
            className="relative flex aspect-[16/9] items-center justify-center overflow-hidden rounded-2xl border border-[var(--lp-border)] bg-[var(--lp-card)] shadow-[0_40px_120px_-40px_var(--lp-glow-strong)]"
          >
            <div aria-hidden="true" className="lp-hero-grid absolute inset-0 opacity-60" />
            <span className="relative flex flex-col items-center gap-3 text-sm text-[var(--lp-ink-faint)]">
              <LayoutDashboard className="h-9 w-9 text-[var(--lp-emerald)]" strokeWidth={1.5} />
              [ REPLACE WITH REAL HOTELTRACK DASHBOARD SCREENSHOT ]
            </span>
          </div>
        </div>
      </section>

      {/* spacer to clear the overlapping preview */}
      <div aria-hidden="true" className="h-24" />

      {/* ── The problem ─────────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <Eyebrow>The problem</Eyebrow>
          <h2 style={serif} className="mt-4 text-3xl font-bold tracking-tight sm:text-[2.6rem] sm:leading-[1.12]">
            Hotels can&apos;t connect bookings to the marketing that created them.
          </h2>
        </div>
        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {PROBLEMS.map(({ icon: Icon, title, body }) => (
            <div key={title} className={card}>
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--lp-emerald-tint)] text-[var(--lp-emerald)]">
                <Icon aria-hidden="true" className="h-5 w-5" strokeWidth={1.75} />
              </span>
              <h3 className="mt-5 text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--lp-ink-muted)]">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── What HotelTrack measures ────────────────────────────────────────── */}
      <section id="features" className="scroll-mt-20 border-y border-[var(--lp-border)] bg-[var(--lp-panel)]">
        <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <Eyebrow>What HotelTrack measures</Eyebrow>
            <h2 style={serif} className="mt-4 text-3xl font-bold tracking-tight sm:text-[2.6rem] sm:leading-[1.12]">
              The full picture, from first touch to confirmed revenue.
            </h2>
          </div>
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {MEASURES.map(({ icon: Icon, title, body }) => (
              <div key={title} className={cardHover}>
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--lp-emerald-tint)] text-[var(--lp-emerald)]">
                  <Icon aria-hidden="true" className="h-5 w-5" strokeWidth={1.75} />
                </span>
                <h3 className="mt-5 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[var(--lp-ink-muted)]">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────────────────────── */}
      <section id="how" className="scroll-mt-20">
        <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <Eyebrow>How it works</Eyebrow>
            <h2 style={serif} className="mt-4 text-3xl font-bold tracking-tight sm:text-[2.6rem] sm:leading-[1.12]">
              Up and running in three steps.
            </h2>
          </div>
          <ol className="mt-14 grid gap-5 md:grid-cols-3">
            {STEPS.map(({ icon: Icon, title, body }, i) => (
              <li key={title} className={`relative ${card}`}>
                <div className="flex items-center justify-between">
                  <span className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--lp-emerald-tint)] text-[var(--lp-emerald)]">
                    <Icon aria-hidden="true" className="h-5 w-5" strokeWidth={1.75} />
                  </span>
                  <span
                    style={serif}
                    aria-hidden="true"
                    className="text-5xl font-bold text-[var(--lp-step-num)]"
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <h3 className="mt-5 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[var(--lp-ink-muted)]">{body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── OTA commission savings ──────────────────────────────────────────── */}
      <section className="border-y border-[var(--lp-border)] bg-[var(--lp-panel)]">
        <div className="mx-auto grid max-w-7xl items-center gap-12 px-5 py-20 sm:px-8 sm:py-28 lg:grid-cols-2">
          <div>
            <Eyebrow>OTA commission savings</Eyebrow>
            <h2 style={serif} className="mt-4 text-3xl font-bold tracking-tight sm:text-[2.6rem] sm:leading-[1.12]">
              Every direct booking is commission you keep.
            </h2>
            <p className="mt-5 text-base leading-relaxed text-[var(--lp-ink-muted)]">
              Online travel agencies typically charge Indian hotels{" "}
              <strong className="font-semibold text-[var(--lp-ink)]">15–25% commission</strong>{" "}
              on every reservation. When your own marketing wins the booking on your
              website instead, that commission stays with the hotel — and HotelTrack
              shows you exactly how much each direct booking saved.
            </p>
            <p className="mt-4 text-xs text-[var(--lp-ink-faint)]">
              Commission range is a published industry benchmark, not a hotel-specific
              figure. Your dashboard reports real savings from your own bookings.
            </p>
          </div>

          {/* Bold stat block. */}
          <div className="relative overflow-hidden rounded-3xl border border-[var(--lp-emerald-border)] bg-[var(--lp-stat-bg)] p-8 shadow-[0_30px_90px_-40px_var(--lp-glow-strong)] sm:p-10">
            <div aria-hidden="true" className="lp-glow lp-glow-stat absolute -right-16 -top-16 rounded-full" />
            <div className="relative flex items-end gap-2">
              <BadgePercent aria-hidden="true" className="mb-3 h-8 w-8 text-[var(--lp-emerald)]" strokeWidth={1.75} />
              <span style={serif} className="text-6xl font-bold leading-none text-[var(--lp-emerald)] sm:text-7xl">
                15–25%
              </span>
            </div>
            <p className="relative mt-4 text-sm font-medium text-[var(--lp-ink)]">
              Typical OTA commission avoided per direct booking
            </p>
            <hr className="relative my-7 border-[var(--lp-border)]" />
            <dl className="relative space-y-4">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-sm text-[var(--lp-ink-muted)]">Commission saved this period</dt>
                <dd className="rounded-md bg-[var(--lp-emerald-tint)] px-2.5 py-1 text-xs font-semibold text-[var(--lp-emerald)]">
                  [ LIVE FROM YOUR DATA ]
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-sm text-[var(--lp-ink-muted)]">Direct bookings attributed</dt>
                <dd className="rounded-md bg-[var(--lp-emerald-tint)] px-2.5 py-1 text-xs font-semibold text-[var(--lp-emerald)]">
                  [ LIVE FROM YOUR DATA ]
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      {/* ── Final CTA + contact ─────────────────────────────────────────────── */}
      <section id="demo" className="scroll-mt-20 border-t border-[var(--lp-border)] bg-[var(--lp-panel)]">
        <div className="relative mx-auto max-w-3xl overflow-hidden px-5 py-24 text-center sm:px-8 sm:py-32">
          <div aria-hidden="true" className="lp-glow lp-glow-cta absolute left-1/2 top-0 -z-10 -translate-x-1/2 rounded-full" />
          <Eyebrow>Book a demo</Eyebrow>
          <h2 style={serif} className="mt-4 text-3xl font-bold tracking-tight sm:text-5xl sm:leading-[1.1]">
            Ready to know what drives your bookings?
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-[var(--lp-ink-muted)]">
            Walk through HotelTrack with your own hotel&apos;s setup. We&apos;ll show you
            content-to-revenue attribution, channel ROAS, and OTA commission saved — live.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3.5 sm:flex-row">
            <a
              href="mailto:yashwanth@socialhippi.com?subject=HotelTrack%20demo%20request"
              className={`${btnSolid} w-full justify-center sm:w-auto`}
            >
              <Mail aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
              Book a Demo
            </a>
            <Show when="signed-out">
              <Link href="/sign-in" className={`${btnOutline} w-full justify-center sm:w-auto`}>
                Sign in
                <ArrowRight aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
              </Link>
            </Show>
          </div>
          <p className="mt-8 text-sm text-[var(--lp-ink-muted)]">
            Prefer email? Reach us at{" "}
            <a
              href="mailto:yashwanth@socialhippi.com"
              className="font-medium text-[var(--lp-emerald)] underline-offset-4 hover:underline"
            >
              yashwanth@socialhippi.com
            </a>
          </p>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer className="bg-[var(--lp-bg)]">
        <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8">
          <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-xs">
              <Link href="/" className="flex items-center gap-2.5" aria-label="HotelTrack home">
                <Logo />
                <span style={serif} className="text-lg font-bold">
                  HotelTrack
                </span>
              </Link>
              <p className="mt-3 text-sm leading-relaxed text-[var(--lp-ink-muted)]">
                Marketing attribution built for hotels — prove what drives direct
                bookings and grow revenue with confidence.
              </p>
            </div>

            <div className="flex flex-col gap-8 sm:flex-row sm:gap-16">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--lp-ink-faint)]">
                  Explore
                </h4>
                <ul className="mt-4 space-y-2.5">
                  {NAV_LINKS.map(({ label, href }) => (
                    <li key={label}>
                      <a
                        href={href}
                        className="text-sm text-[var(--lp-ink-muted)] transition-colors hover:text-[var(--lp-ink)]"
                      >
                        {label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--lp-ink-faint)]">
                  Contact
                </h4>
                <ul className="mt-4 space-y-2.5 text-sm">
                  <li className="font-medium text-[var(--lp-ink)]">Social Hippi</li>
                  <li className="text-[var(--lp-ink-muted)]">Yashwanth</li>
                  <li>
                    <a
                      href="mailto:yashwanth@socialhippi.com"
                      className="text-[var(--lp-ink-muted)] transition-colors hover:text-[var(--lp-ink)]"
                    >
                      yashwanth@socialhippi.com
                    </a>
                  </li>
                  <li>
                    <a
                      href="tel:+919390114551"
                      className="text-[var(--lp-ink-muted)] transition-colors hover:text-[var(--lp-ink)]"
                    >
                      +91 9390114551
                    </a>
                  </li>
                  <li>
                    <a href="#demo" className="text-[var(--lp-ink-muted)] transition-colors hover:text-[var(--lp-ink)]">
                      Book a demo
                    </a>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <div className="mt-10 flex flex-col items-center justify-between gap-3 border-t border-[var(--lp-border)] pt-6 text-xs text-[var(--lp-ink-faint)] sm:flex-row">
            <p>© 2026 HotelTrack. All rights reserved.</p>
            <p>Made for hotels &amp; hotel marketing agencies in India.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ── Shared class strings ──────────────────────────────────────────────────────

const btnSolid =
  "inline-flex items-center gap-2 rounded-full bg-[var(--lp-emerald)] px-6 py-3 text-sm font-semibold text-[var(--lp-on-emerald)] shadow-[0_10px_30px_-8px_var(--lp-glow)] transition hover:-translate-y-0.5 hover:bg-[var(--lp-emerald-hover)]";

const btnOutline =
  "inline-flex items-center gap-2 rounded-full border border-[var(--lp-border-strong)] px-6 py-3 text-sm font-semibold text-[var(--lp-ink)] transition hover:-translate-y-0.5 hover:border-[var(--lp-emerald)] hover:bg-[var(--lp-emerald-tint)]";

const card =
  "rounded-2xl border border-[var(--lp-border)] bg-[var(--lp-card)] p-7";

const cardHover =
  "rounded-2xl border border-[var(--lp-border)] bg-[var(--lp-card)] p-7 transition hover:-translate-y-1 hover:border-[var(--lp-emerald)]";

// ── Section data ──────────────────────────────────────────────────────────────

const NAV_LINKS = [
  { label: "Product", href: "#how" },
  { label: "Features", href: "#features" },
];

const HIGHLIGHTS = [
  {
    icon: MousePointerClick,
    title: "Track Every Touchpoint",
    body: "from ad click to booking",
  },
  {
    icon: Crosshair,
    title: "Accurate Attribution",
    body: "first, last & multi-touch",
  },
  {
    icon: TrendingUp,
    title: "Increase Direct Bookings",
    body: "reduce OTA dependency",
  },
];

const PROBLEMS = [
  {
    icon: Wallet,
    title: "Spend with no visibility",
    body: "Marketing budget is spread across ads, social, and influencers — with no clear view of which spend actually returned a booking.",
  },
  {
    icon: Route,
    title: "Fragmented guest journeys",
    body: "A guest discovers you on Instagram, clicks an ad, then books days later. Each step lives in a different tool and the path is never joined up.",
  },
  {
    icon: Unlink,
    title: "Revenue disconnected from campaigns",
    body: "Bookings land on the hotel website with no origin, so revenue can never be traced back to the campaign that earned it.",
  },
];

const MEASURES = [
  {
    icon: TrendingUp,
    title: "Revenue by Source",
    body: "Attribute confirmed booking revenue back to the exact channel, campaign, and piece of content that drove it.",
  },
  {
    icon: Route,
    title: "Visitor Journey Tracking",
    body: "Follow each visitor step by step — from the first content touch to the booking they complete on your site.",
  },
  {
    icon: Filter,
    title: "Funnel Drop-off",
    body: "See where prospective guests fall out of the booking flow so you can fix the leaks that cost reservations.",
  },
  {
    icon: BadgePercent,
    title: "OTA Commission Saved",
    body: "Quantify the commission kept every time a direct booking replaces one that would have come through an OTA.",
  },
  {
    icon: Target,
    title: "Campaign ROAS",
    body: "Tie Meta ad spend to real bookings for true return on ad spend — not platform-reported conversions.",
  },
  {
    icon: Network,
    title: "Multi-channel Attribution",
    body: "Compare first-touch, last-touch, and multi-touch models to credit every channel for its true role in the booking.",
  },
];

const STEPS = [
  {
    icon: Code2,
    title: "Install a lightweight snippet",
    body: "Add one small tracking script to the hotel's website. It captures which content sent each visitor and when a booking happens.",
  },
  {
    icon: PlugZap,
    title: "Connect your marketing",
    body: "Securely link Meta Ads, Instagram, and Google Analytics. Access tokens are encrypted — never exposed to the browser.",
  },
  {
    icon: LayoutDashboard,
    title: "See unified attribution",
    body: "Watch content → visit → booking → revenue come together in one dashboard, per hotel, with ad ROI and OTA savings.",
  },
];

// ── Small presentational helpers (server-rendered) ────────────────────────────

function Logo() {
  return (
    <span
      aria-hidden="true"
      className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--lp-emerald)] text-base font-bold text-[var(--lp-on-emerald)]"
    >
      H
    </span>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--lp-emerald)]">
      {children}
    </span>
  );
}

// ── Scoped palette + motion ───────────────────────────────────────────────────
// The `.ht-lp` block carries the DARK palette as the default (the primary look).
// `.light .ht-lp` overrides to the off-white palette. Since the app always sets
// `.light` or `.dark` on <html>, the page follows the global theme toggle while
// keeping dark as the design's identity. None of these vars leak outside `.ht-lp`.
const LP_STYLES = `
  .ht-lp {
    /* Surfaces — deep near-black with a faint green undertone */
    --lp-bg: #0A1410;
    --lp-panel: #0C1813;
    --lp-card: #10211A;
    --lp-nav-bg: rgba(10, 20, 16, 0.72);

    /* Borders */
    --lp-border: rgba(255, 255, 255, 0.08);
    --lp-border-strong: rgba(255, 255, 255, 0.18);

    /* Text */
    --lp-ink: #F4F8F5;
    --lp-ink-muted: #9DB1A6;
    --lp-ink-faint: #6B7E74;
    --lp-step-num: rgba(255, 255, 255, 0.07);

    /* Emerald accent */
    --lp-emerald: #2ECC71;
    --lp-emerald-hover: #45D982;
    --lp-on-emerald: #06140D;
    --lp-emerald-tint: rgba(46, 204, 113, 0.12);
    --lp-emerald-border: rgba(46, 204, 113, 0.35);

    /* One gold detail (emphasis only) */
    --lp-gold: #D9B65A;
    --lp-gold-ink: #1A1405;

    /* Glows / stat panel */
    --lp-glow: rgba(46, 204, 113, 0.45);
    --lp-glow-strong: rgba(46, 204, 113, 0.30);
    --lp-stat-bg: #0C1813;
  }

  .light .ht-lp {
    /* Surfaces — off-white with a faint green tint */
    --lp-bg: #F6FAF7;
    --lp-panel: #EEF5F0;
    --lp-card: #FFFFFF;
    --lp-nav-bg: rgba(246, 250, 247, 0.78);

    /* Borders */
    --lp-border: #E0EAE4;
    --lp-border-strong: #C4D6CC;

    /* Text — near-black */
    --lp-ink: #0B1A12;
    --lp-ink-muted: #4C5C53;
    --lp-ink-faint: #788A80;
    --lp-step-num: rgba(11, 26, 18, 0.08);

    /* Emerald accent — deeper & muted for readability on white */
    --lp-emerald: #167C4A;
    --lp-emerald-hover: #126B40;
    --lp-on-emerald: #FFFFFF;
    --lp-emerald-tint: rgba(22, 124, 74, 0.10);
    --lp-emerald-border: rgba(22, 124, 74, 0.28);

    /* One gold detail — deepened so it holds on white */
    --lp-gold: #B8902F;
    --lp-gold-ink: #FFFFFF;

    /* Glows / stat panel */
    --lp-glow: rgba(22, 124, 74, 0.28);
    --lp-glow-strong: rgba(22, 124, 74, 0.18);
    --lp-stat-bg: #FFFFFF;
  }

  /* Faint emerald grid behind the hero, masked to fade at the edges. */
  .lp-hero-grid {
    background-image:
      linear-gradient(to right, color-mix(in srgb, var(--lp-emerald) 9%, transparent) 1px, transparent 1px),
      linear-gradient(to bottom, color-mix(in srgb, var(--lp-emerald) 9%, transparent) 1px, transparent 1px);
    background-size: 56px 56px;
    mask-image: radial-gradient(ellipse 75% 65% at 50% 30%, #000 35%, transparent 100%);
    -webkit-mask-image: radial-gradient(ellipse 75% 65% at 50% 30%, #000 35%, transparent 100%);
  }

  .lp-glow {
    filter: blur(90px);
    will-change: transform;
    pointer-events: none;
  }
  .lp-glow-1 {
    top: -10rem;
    left: -8rem;
    height: 26rem;
    width: 26rem;
    opacity: 0.55;
    background: radial-gradient(circle, color-mix(in srgb, var(--lp-emerald) 55%, transparent), transparent 70%);
    animation: lp-drift-1 22s ease-in-out infinite alternate;
  }
  .lp-glow-2 {
    top: 2rem;
    right: -10rem;
    height: 30rem;
    width: 30rem;
    opacity: 0.4;
    background: radial-gradient(circle, color-mix(in srgb, var(--lp-emerald) 40%, transparent), transparent 70%);
    animation: lp-drift-2 26s ease-in-out infinite alternate;
  }
  .lp-glow-stat {
    height: 16rem;
    width: 16rem;
    opacity: 0.5;
    background: radial-gradient(circle, color-mix(in srgb, var(--lp-emerald) 45%, transparent), transparent 70%);
  }
  .lp-glow-cta {
    height: 22rem;
    width: 34rem;
    opacity: 0.35;
    background: radial-gradient(circle, color-mix(in srgb, var(--lp-emerald) 40%, transparent), transparent 70%);
  }

  @keyframes lp-drift-1 {
    from { transform: translate3d(0, 0, 0) scale(1); }
    to   { transform: translate3d(3rem, 2rem, 0) scale(1.12); }
  }
  @keyframes lp-drift-2 {
    from { transform: translate3d(0, 0, 0) scale(1); }
    to   { transform: translate3d(-3rem, 2rem, 0) scale(1.1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .lp-glow-1, .lp-glow-2 { animation: none; }
  }
`;
