import type { Metadata } from "next";
import Link from "next/link";

// Fully public — no auth, no personalization, no DB reads. Statically rendered
// so it is always available (Meta/Google both require the Privacy Policy URL to
// be publicly reachable without a login before an app can go Live).
//
// NOTE: this route MUST also be listed in proxy.ts isPublicRoute, otherwise the
// Clerk proxy 307-redirects it to /sign-in and the URL never returns HTTP 200.
export const dynamic = "force-static";

const PUBLIC_URL = (
  process.env.NEXT_PUBLIC_APP_URL || "https://www.hoteltrack.in"
).replace(/\/$/, "");
const PAGE_URL = `${PUBLIC_URL}/privacy-policy`;

const CONTACT_EMAIL = "hello@hoteltrack.in";
const LAST_UPDATED = "23 July 2026";
const EFFECTIVE_DATE = "23 July 2026";

const TITLE = "Privacy Policy · HotelTrack";
const DESCRIPTION =
  "How HotelTrack collects, uses, protects and retains data — including Google Ads, Meta Ads and Google Analytics OAuth data, booking attribution, cookies, security and your rights.";

export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_URL),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/privacy-policy" },
  robots: { index: true, follow: true },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: PAGE_URL,
    siteName: "HotelTrack",
    type: "article",
    locale: "en_IN",
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
  },
};

// ── Table of contents ────────────────────────────────────────────────────────

const TOC: { id: string; label: string }[] = [
  { id: "introduction", label: "1. Introduction" },
  { id: "information-we-collect", label: "2. Information We Collect" },
  { id: "google-ads-oauth", label: "3. Google Ads OAuth Data" },
  { id: "meta-ads-oauth", label: "4. Meta Ads OAuth Data" },
  { id: "google-analytics", label: "5. Google Analytics Data" },
  { id: "booking-attribution", label: "6. Booking Attribution Data" },
  { id: "cookies", label: "7. Cookies & Tracking Technologies" },
  { id: "data-security", label: "8. Data Security" },
  { id: "third-party-services", label: "9. Third-Party Services" },
  { id: "user-rights", label: "10. User Rights" },
  { id: "data-retention", label: "11. Data Retention" },
  { id: "contact", label: "12. Contact Information" },
];

// ── Presentational helpers (server components) ───────────────────────────────

function Section({
  id,
  number,
  title,
  children,
}: {
  id: string;
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-line pt-10 first:border-t-0 first:pt-0">
      <h2 className="flex items-baseline gap-3 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
        <span className="text-base font-black tabular-nums text-brand sm:text-lg">{number}</span>
        {title}
      </h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-ink-secondary sm:text-base">
        {children}
      </div>
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-pretty">{children}</p>;
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="pt-2 text-lg font-semibold tracking-tight text-ink">{children}</h3>
  );
}

function Ul({ children }: { children: React.ReactNode }) {
  return (
    <ul className="ml-1 list-inside list-disc space-y-2 marker:text-brand">{children}</ul>
  );
}

function Li({ children }: { children: React.ReactNode }) {
  return <li className="text-pretty">{children}</li>;
}

function Strong({ children }: { children: React.ReactNode }) {
  return <strong className="font-semibold text-ink">{children}</strong>;
}

function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "success" | "warn";
  title: string;
  children: React.ReactNode;
}) {
  const TONE = {
    info: "border-info/40 bg-info/10",
    success: "border-success/40 bg-success/10",
    warn: "border-warning/40 bg-warning/10",
  } as const;
  const LABEL = {
    info: "text-info",
    success: "text-success",
    warn: "text-warning",
  } as const;
  return (
    <div className={`rounded-xl border px-4 py-3.5 ${TONE[tone]}`}>
      <p className={`text-sm font-semibold ${LABEL[tone]}`}>{title}</p>
      <div className="mt-1.5 text-[15px] leading-relaxed text-ink-secondary">{children}</div>
    </div>
  );
}

/** Responsive data table: scrolls horizontally on small screens, never the page. */
function DataTable({
  head,
  rows,
  caption,
}: {
  head: string[];
  rows: React.ReactNode[][];
  caption?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="bg-[var(--overlay-header)]">
            {head.map((h) => (
              <th
                key={h}
                scope="col"
                className="border-b border-line px-4 py-2.5 font-semibold text-ink"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="align-top odd:bg-[var(--overlay-soft)]">
              {row.map((cell, j) => (
                <td key={j} className="border-b border-line px-4 py-2.5 text-ink-secondary last:border-0">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[0.85em] text-ink">
      {children}
    </code>
  );
}

function MailLink() {
  return (
    <a
      href={`mailto:${CONTACT_EMAIL}`}
      className="font-medium text-brand underline underline-offset-2 hover:text-brand-hover"
    >
      {CONTACT_EMAIL}
    </a>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-page text-ink">
      {/* Sticky top bar — mirrors /setup-guide */}
      <header className="sticky top-0 z-30 border-b border-line bg-page/90 backdrop-blur print:static">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-sm font-black text-white">
              H
            </span>
            <span className="text-base font-bold tracking-tight text-ink">HotelTrack</span>
          </Link>
          <Link
            href="/setup-guide"
            className="text-sm font-medium text-ink-tertiary transition hover:text-ink print:hidden"
          >
            Setup guide
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-line bg-gradient-to-b from-page to-card">
        <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
          <span className="inline-block rounded-full bg-brand/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-brand">
            Legal
          </span>
          <h1 className="mt-4 text-4xl font-black tracking-tight text-ink sm:text-5xl">
            Privacy Policy
          </h1>
          <p className="mt-3 max-w-2xl text-pretty text-lg text-ink-secondary">
            How HotelTrack collects, uses, protects and retains data — written to
            be read, not to be survived.
          </p>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-tertiary">
            <span>
              <Strong>Effective:</Strong> {EFFECTIVE_DATE}
            </span>
            <span>
              <Strong>Last updated:</Strong> {LAST_UPDATED}
            </span>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        {/* Table of contents */}
        <nav
          aria-label="Table of contents"
          className="mb-12 rounded-xl border border-line bg-card p-5 shadow-sm"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
            On this page
          </p>
          <ol className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-2">
            {TOC.map((item) => (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  className="text-[15px] text-ink-secondary underline-offset-2 transition hover:text-brand hover:underline"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <main className="space-y-10">
          {/* ── 1. Introduction ───────────────────────────────────────────── */}
          <Section id="introduction" number="1" title="Introduction">
            <P>
              HotelTrack is a marketing intelligence platform operated by{" "}
              <Strong>Social Hippi</Strong>. It is used by marketing agencies to
              measure how their work — organic social content, paid advertising and
              influencer collaborations — produces real bookings on their hotel
              clients&apos; own websites.
            </P>
            <P>
              This Privacy Policy explains what data HotelTrack collects, why we
              collect it, how it is protected, how long we keep it, and the rights
              you have over it. It applies to{" "}
              <Mono>{PUBLIC_URL.replace(/^https?:\/\//, "")}</Mono>, the HotelTrack
              application, and the HotelTrack tracking snippet installed on hotel
              websites.
            </P>

            <H3>Who this policy covers</H3>
            <Ul>
              <Li>
                <Strong>Agencies</Strong> — our direct customers, who hold accounts
                and connect advertising platforms.
              </Li>
              <Li>
                <Strong>Hotels</Strong> — our customers&apos; clients, whose website
                performance is measured and who receive reports.
              </Li>
              <Li>
                <Strong>Website visitors</Strong> — people who visit a hotel website
                running the HotelTrack snippet.
              </Li>
            </Ul>

            <Callout tone="success" title="Our core commitment">
              HotelTrack is built to measure <em>marketing performance</em>, not
              people. We do not sell data, we do not build cross-site advertising
              profiles, and we do not share one customer&apos;s data with another.
              Where we can measure something without storing personal data, we do.
            </Callout>

            <H3>Controller and processor</H3>
            <P>
              For agency account data, Social Hippi acts as the{" "}
              <Strong>data controller</Strong>. For data collected from a hotel&apos;s
              website visitors, the hotel and its agency are the controllers and
              Social Hippi acts as a <Strong>data processor</Strong> on their
              instructions.
            </P>
          </Section>

          {/* ── 2. Information We Collect ─────────────────────────────────── */}
          <Section id="information-we-collect" number="2" title="Information We Collect">
            <P>
              We collect only what is required to produce accurate marketing
              reporting. Categories are set out below; sections 3–7 describe the
              most significant ones in detail.
            </P>

            <H3>Account information</H3>
            <Ul>
              <Li>Name, email address and password credentials, handled by our authentication provider (Clerk). HotelTrack never stores or sees your password.</Li>
              <Li>Agency name, business contact details, address, phone and WhatsApp number.</Li>
              <Li>Team member names, email addresses and roles.</Li>
              <Li>Billing details, processed by Razorpay. HotelTrack never stores full card numbers.</Li>
            </Ul>

            <H3>Hotel client information</H3>
            <Ul>
              <Li>Hotel name, website URL, contact name and email, address, room count and channel manager.</Li>
              <Li>Configuration you supply, such as conversion-detection rules and OTA commission rates.</Li>
            </Ul>

            <H3>Connected platform data</H3>
            <Ul>
              <Li>OAuth access and refresh tokens for Google Ads, Meta Ads, Instagram and Google Analytics 4 — always encrypted at rest.</Li>
              <Li>Advertising performance metrics: spend, impressions, clicks, reach and platform-reported conversions.</Li>
              <Li>Organic social metrics: followers, reach, views and per-post engagement.</Li>
            </Ul>

            <H3>Website measurement data</H3>
            <Ul>
              <Li>Page paths, page titles, referring URLs and UTM campaign parameters.</Li>
              <Li>Session and visitor identifiers generated by us — random values that are not derived from any personal information.</Li>
              <Li>Device type, viewport dimensions and browser user-agent string.</Li>
              <Li>Booking value and coupon code at the point of a confirmed booking.</Li>
            </Ul>

            <Callout tone="info" title="What we deliberately do not collect">
              <Ul>
                <Li>We do not store <Strong>raw IP addresses</Strong>. Where an IP is needed for abuse prevention, only a salted SHA-256 hash is retained.</Li>
                <Li>We do not store <Strong>raw email addresses or phone numbers</Strong> of website visitors. If a visitor identifies themselves, the value is hashed in the browser before transmission and salted again on our servers.</Li>
                <Li>We do not capture <Strong>form field contents</Strong>. We record only whether a tagged field was filled, never what was typed.</Li>
                <Li>We do not record screen sessions, keystrokes or mouse movement.</Li>
                <Li>We do not knowingly collect data from children under 16.</Li>
              </Ul>
            </Callout>

            <H3>Legal bases for processing</H3>
            <DataTable
              caption="Legal bases for processing"
              head={["Purpose", "Legal basis"]}
              rows={[
                ["Providing the HotelTrack service to an agency", "Performance of a contract"],
                ["Analytics and booking attribution on hotel websites", "Consent, obtained by the hotel, or legitimate interests where permitted"],
                ["Security, fraud prevention and abuse rate-limiting", "Legitimate interests"],
                ["Billing, invoicing and tax records", "Legal obligation"],
                ["Product and service email", "Performance of a contract, or consent for marketing"],
              ]}
            />
          </Section>

          {/* ── 3. Google Ads OAuth ───────────────────────────────────────── */}
          <Section id="google-ads-oauth" number="3" title="Google Ads OAuth Data">
            <P>
              When an agency connects a Google Ads account, HotelTrack uses Google
              OAuth 2.0. You authenticate directly with Google — HotelTrack never
              sees your Google password.
            </P>

            <H3>Scope requested</H3>
            <DataTable
              caption="Google Ads OAuth scope"
              head={["Scope", "Access", "Why"]}
              rows={[
                [
                  <Mono key="s">https://www.googleapis.com/auth/adwords</Mono>,
                  "Read",
                  "Retrieve campaign performance so spend can be compared against bookings we measure.",
                ],
              ]}
            />

            <H3>What we retrieve</H3>
            <Ul>
              <Li>Accessible Google Ads customer accounts, their names, IDs and currency.</Li>
              <Li>Per-campaign daily metrics: campaign name and status, cost, impressions, clicks, conversions and conversion value.</Li>
            </Ul>

            <H3>What we never do</H3>
            <Ul>
              <Li>We never create, edit, pause or delete campaigns, ads, budgets or bids. Access is strictly read-only.</Li>
              <Li>We never retrieve keyword-level search terms, audience lists or customer-match data.</Li>
              <Li>We never share your advertising data with any other agency or third party.</Li>
            </Ul>

            <Callout tone="info" title="Google API Services User Data Policy">
              HotelTrack&apos;s use and transfer of information received from Google
              APIs adheres to the{" "}
              <a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-brand underline underline-offset-2 hover:text-brand-hover"
              >
                Google API Services User Data Policy
              </a>
              , including its Limited Use requirements. Google Ads data is used
              solely to provide user-facing reporting inside HotelTrack. It is
              never used for advertising, never sold, and never used to train
              generalised artificial-intelligence or machine-learning models.
            </Callout>

            <P>
              Tokens are encrypted with AES-256-GCM before storage. You may revoke
              access at any time from the hotel&apos;s Integrations page in
              HotelTrack, or from your{" "}
              <a
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-brand underline underline-offset-2 hover:text-brand-hover"
              >
                Google Account permissions
              </a>
              . Revoking stops all future synchronisation immediately.
            </P>
          </Section>

          {/* ── 4. Meta Ads OAuth ─────────────────────────────────────────── */}
          <Section id="meta-ads-oauth" number="4" title="Meta Ads OAuth Data">
            <P>
              When an agency connects a Meta (Facebook) advertising account,
              HotelTrack uses Facebook Login. You authenticate directly with Meta —
              HotelTrack never sees your Facebook password.
            </P>

            <H3>Permissions requested</H3>
            <DataTable
              caption="Meta permissions requested"
              head={["Permission", "Access", "Why"]}
              rows={[
                [
                  <Mono key="a">ads_read</Mono>,
                  "Read",
                  "Retrieve ad account and campaign performance metrics.",
                ],
                [
                  <Mono key="b">business_management</Mono>,
                  "Read",
                  "Identify which ad accounts are available through your Business Manager.",
                ],
              ]}
            />

            <H3>What we retrieve</H3>
            <Ul>
              <Li>Your Facebook user ID and name, recorded so we can show who connected the account.</Li>
              <Li>Accessible ad accounts, their names, IDs, currency and time zone.</Li>
              <Li>Daily account and campaign metrics: spend, impressions, reach, clicks, CTR, CPC, CPM and Meta-reported conversions.</Li>
            </Ul>

            <H3>What we never do</H3>
            <Ul>
              <Li>We never create, edit, pause or delete campaigns, ads, audiences or budgets. Access is strictly read-only.</Li>
              <Li>We never access your personal Facebook profile content, friends, photos, messages or posts.</Li>
              <Li>We never request access to Facebook Pages, and we never post on your behalf.</Li>
              <Li>We never retrieve Custom Audiences or any customer list uploaded to Meta.</Li>
            </Ul>

            <P>
              Access tokens are encrypted with AES-256-GCM before storage and are
              refreshed automatically so that reporting continues without
              re-authentication. You may disconnect at any time from the
              hotel&apos;s Integrations page, or remove HotelTrack from your{" "}
              <a
                href="https://www.facebook.com/settings?tab=business_tools"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-brand underline underline-offset-2 hover:text-brand-hover"
              >
                Facebook Business Integrations
              </a>{" "}
              settings.
            </P>

            <H3>Instagram</H3>
            <P>
              Instagram is connected through a separate authorisation using the{" "}
              <Mono>instagram_business_basic</Mono> and{" "}
              <Mono>instagram_business_manage_insights</Mono> permissions. We
              retrieve account-level insights (followers, reach, views, profile
              visits) and per-post metrics for professional accounts only. We never
              read direct messages, and we never publish content.
            </P>
          </Section>

          {/* ── 5. Google Analytics ───────────────────────────────────────── */}
          <Section id="google-analytics" number="5" title="Google Analytics Data">
            <P>
              A hotel may connect an existing Google Analytics 4 property so that
              total website performance can be presented alongside HotelTrack&apos;s
              own booking attribution.
            </P>

            <H3>Scope requested</H3>
            <DataTable
              caption="Google Analytics OAuth scope"
              head={["Scope", "Access", "Why"]}
              rows={[
                [
                  <Mono key="s">https://www.googleapis.com/auth/analytics.readonly</Mono>,
                  "Read",
                  "Retrieve aggregated GA4 reporting for the selected property.",
                ],
              ]}
            />

            <H3>What we retrieve</H3>
            <Ul>
              <Li>Daily aggregates: sessions, users, new users, page views, bounce rate, engagement rate and average session duration.</Li>
              <Li>Acquisition channels, traffic sources, campaigns and landing pages.</Li>
              <Li>Aggregate geography, device category, browser and operating system.</Li>
              <Li>Key events and, where the property has e-commerce enabled, transaction and revenue totals.</Li>
            </Ul>

            <Callout tone="info" title="Aggregates only">
              We retrieve <Strong>aggregated report rows</Strong>. HotelTrack does
              not request, receive or store GA4 user-level identifiers, client IDs
              or the User Explorer report. Google Analytics data is subject to the
              same Limited Use commitments described in section 3.
            </Callout>

            <P>
              Connecting GA4 does not change your Google Analytics configuration in
              any way. We never modify property settings, filters, audiences or
              conversion definitions.
            </P>
          </Section>

          {/* ── 6. Booking Attribution ────────────────────────────────────── */}
          <Section id="booking-attribution" number="6" title="Booking Attribution Data">
            <P>
              The HotelTrack tracking snippet is a small JavaScript file that a
              hotel installs on its own website. Its single purpose is to connect a
              marketing touchpoint to a resulting booking, so an agency can show
              which work produced revenue.
            </P>

            <H3>What the snippet records</H3>
            <DataTable
              caption="Data recorded by the tracking snippet"
              head={["Data", "Example", "Purpose"]}
              rows={[
                ["Page path and title", <Mono key="p">/rooms/deluxe-suite</Mono>, "Understand the browsing journey"],
                ["UTM parameters", <Mono key="u">utm_source=instagram</Mono>, "Identify which content drove the visit"],
                ["Referring website", <Mono key="r">instagram.com</Mono>, "Identify traffic sources"],
                ["Session identifier", <Mono key="s">sess_8f3a…</Mono>, "Group page views into one visit"],
                ["Visitor identifier", <Mono key="v">vis_2c91…</Mono>, "Link repeat visits across sessions"],
                ["Device and viewport", "mobile · 390×844", "Report on device performance"],
                ["Booking value", "₹24,500", "Calculate revenue and return on ad spend"],
                ["Coupon code", <Mono key="c">PRIYA10</Mono>, "Attribute bookings to an influencer"],
              ]}
            />

            <Callout tone="warn" title="Identifiers are not identity">
              Session and visitor identifiers are <Strong>randomly generated</Strong>.
              They are not derived from an email address, name, IP address or device
              fingerprint, and they cannot be reversed to identify a person. They are
              scoped to a single hotel&apos;s website and are never used to follow
              anyone across unrelated websites.
            </Callout>

            <H3>Optional visitor identification</H3>
            <P>
              A hotel may choose to link a booking to a known guest. Where this is
              enabled, the email address and phone number are hashed with SHA-256{" "}
              <Strong>inside the visitor&apos;s browser</Strong> before anything is
              transmitted, and hashed again with a server-side salt on receipt. The
              raw values never reach HotelTrack&apos;s servers and cannot be
              recovered from what we store.
            </P>

            <H3>Attribution modelling</H3>
            <P>
              We record the ordered sequence of marketing touchpoints preceding a
              booking and apply an attribution model — first-touch, last-touch or
              position-based — to assign credit. This is a calculation performed on
              data already described above; no additional information is collected.
            </P>
          </Section>

          {/* ── 7. Cookies ────────────────────────────────────────────────── */}
          <Section id="cookies" number="7" title="Cookies & Tracking Technologies">
            <P>
              HotelTrack uses a small number of first-party cookies and browser
              storage entries. We use <Strong>no third-party advertising cookies</Strong>,
              no advertising pixels of our own, and no cross-site trackers.
            </P>

            <H3>Cookies set on hotel websites</H3>
            <DataTable
              caption="Cookies set by the HotelTrack snippet"
              head={["Name", "Type", "Lifetime", "Purpose"]}
              rows={[
                [<Mono key="1">ht_visitor_id</Mono>, "Cookie", "365 days", "Recognise a returning visitor to the same hotel site"],
                [<Mono key="2">_ht_attr</Mono>, "Cookie", "30 days", "Remember the first campaign that referred the visitor"],
                [<Mono key="3">_ht_journey</Mono>, "Cookie", "30 days", "Store the ordered touchpoints preceding a booking"],
                [<Mono key="4">_ht_conv</Mono>, "Cookie", "Session", "Prevent a single booking being counted twice"],
                [<Mono key="5">ht_visitor_identity</Mono>, "Cookie", "365 days", "Retain hashed identifiers only, where identification is enabled"],
                [<Mono key="6">ht_session_id</Mono>, "Session storage", "Until tab closes", "Group page views into one browsing session"],
                [<Mono key="7">ht_coupon</Mono>, "Session storage", "Until tab closes", "Carry a coupon code to the confirmation page"],
              ]}
            />

            <H3>Cookies on the HotelTrack application</H3>
            <P>
              When signed in, our authentication provider Clerk sets a session
              cookie that is strictly necessary to keep you logged in. A small
              preference cookie stores your light or dark theme choice.
            </P>

            <H3>Managing cookies</H3>
            <Ul>
              <Li>All browsers allow cookies to be blocked or cleared. Blocking HotelTrack cookies prevents booking attribution but does not affect a hotel&apos;s website.</Li>
              <Li>The snippet honours the hotel&apos;s own consent-management platform where one is installed. It is the hotel&apos;s responsibility to obtain any consent required in its jurisdiction before the snippet loads.</Li>
              <Li>Because we do not track across sites, HotelTrack cookies convey no information to any other website.</Li>
            </Ul>
          </Section>

          {/* ── 8. Data Security ──────────────────────────────────────────── */}
          <Section id="data-security" number="8" title="Data Security">
            <P>
              Security is engineered into HotelTrack in layers rather than added at
              the perimeter.
            </P>

            <H3>Encryption</H3>
            <Ul>
              <Li>All traffic is served over TLS 1.2 or higher, with HTTP Strict Transport Security enforced.</Li>
              <Li>Every third-party access token is encrypted at rest with <Strong>AES-256-GCM</Strong>, which provides both confidentiality and tamper detection.</Li>
              <Li>Encryption keys are versioned so they can be rotated without downtime, and are held in a managed secret store — never in source code.</Li>
              <Li>Databases are encrypted at rest by our infrastructure providers.</Li>
            </Ul>

            <H3>Access control and tenant isolation</H3>
            <Ul>
              <Li>Every record carries an agency identifier, and every query is filtered by it, so one agency can never read another&apos;s data.</Li>
              <Li>Isolation is additionally enforced at the database layer through row-level security policies.</Li>
              <Li>Sensitive credential columns are stripped from query results by default and are readable only through a single audited code path.</Li>
              <Li>Administrative actions require elevated privileges and are recorded.</Li>
            </Ul>

            <H3>Operational safeguards</H3>
            <Ul>
              <Li>Every decryption of a stored credential is written to a tamper-evident audit log. Repeated failures raise a security alert.</Li>
              <Li>Application logs are automatically scrubbed so that credentials cannot be written to them, even accidentally.</Li>
              <Li>Public endpoints are rate-limited to resist enumeration and abuse.</Li>
              <Li>Automated tests covering encryption and tenant isolation run on every change and block release on failure.</Li>
            </Ul>

            <Callout tone="warn" title="No absolute guarantee">
              No system can be perfectly secure. We apply industry-standard
              safeguards proportionate to the sensitivity of the data, but we cannot
              guarantee absolute security. If a breach affecting your personal data
              occurs, we will notify affected customers and the relevant supervisory
              authority without undue delay and, where required, within 72 hours of
              becoming aware of it.
            </Callout>
          </Section>

          {/* ── 9. Third-Party Services ───────────────────────────────────── */}
          <Section id="third-party-services" number="9" title="Third-Party Services">
            <P>
              HotelTrack relies on the sub-processors below. Each is bound by
              contractual data-protection obligations, and each receives only the
              data necessary for its function.
            </P>

            <DataTable
              caption="Sub-processors used by HotelTrack"
              head={["Provider", "Function", "Data processed"]}
              rows={[
                ["Vercel", "Application hosting and delivery", "Request metadata, application logs"],
                ["Neon / PostgreSQL", "Primary database", "All stored application data"],
                ["Clerk", "Authentication and session management", "Account name, email, session data"],
                ["Razorpay", "Subscription billing", "Billing contact and payment details"],
                ["Resend", "Transactional email", "Recipient address and message content"],
                ["Upstash", "Rate limiting", "Hashed request identifiers"],
                ["Google", "Google Ads and Analytics APIs", "Advertising and analytics metrics"],
                ["Meta", "Ads and Instagram APIs", "Advertising and social metrics"],
              ]}
            />

            <H3>International transfers</H3>
            <P>
              Some sub-processors operate outside India. Where personal data is
              transferred internationally, it is protected by appropriate safeguards
              such as Standard Contractual Clauses or an equivalent recognised
              mechanism.
            </P>

            <Callout tone="success" title="We do not sell data">
              HotelTrack does not sell, rent or trade personal data. We do not share
              data with advertising networks or data brokers. Data is disclosed only
              to the sub-processors listed above, to a customer regarding their own
              account, or where we are legally compelled to do so.
            </Callout>
          </Section>

          {/* ── 10. User Rights ───────────────────────────────────────────── */}
          <Section id="user-rights" number="10" title="User Rights">
            <P>
              Depending on your jurisdiction — including under India&apos;s Digital
              Personal Data Protection Act 2023 and the EU and UK General Data
              Protection Regulation — you have the following rights.
            </P>

            <DataTable
              caption="Your data protection rights"
              head={["Right", "What it means"]}
              rows={[
                ["Access", "Obtain a copy of the personal data we hold about you."],
                ["Correction", "Have inaccurate or incomplete data corrected."],
                ["Erasure", "Request deletion of your personal data, subject to legal retention obligations."],
                ["Restriction", "Ask us to limit how we process your data while a concern is resolved."],
                ["Portability", "Receive your data in a structured, machine-readable format."],
                ["Objection", "Object to processing carried out on the basis of legitimate interests."],
                ["Withdraw consent", "Withdraw consent at any time, without affecting prior lawful processing."],
                ["Complain", "Lodge a complaint with your supervisory authority or, in India, the Data Protection Board."],
              ]}
            />

            <H3>Exercising your rights</H3>
            <P>
              Write to <MailLink /> with the word <em>Privacy</em> in the subject
              line. We respond within <Strong>30 days</Strong>. We may ask you to
              verify your identity before acting, so that we do not disclose data to
              the wrong person. Exercising these rights is free of charge.
            </P>

            <H3>Website visitors</H3>
            <P>
              If you visited a hotel website and wish to have the associated
              measurement data deleted, contact us at <MailLink /> with the hotel&apos;s
              website address and the approximate date of your visit. Because our
              identifiers are random and not linked to your identity, we may ask you
              to supply the value of the <Mono>ht_visitor_id</Mono> cookie from your
              browser so that we can locate the correct records. Clearing your
              browser cookies also severs the link immediately.
            </P>

            <H3>Agency and hotel customers</H3>
            <P>
              Account holders may export their data at any time from within
              HotelTrack, and may request deletion of a hotel client or of an entire
              agency account by contacting us.
            </P>
          </Section>

          {/* ── 11. Data Retention ────────────────────────────────────────── */}
          <Section id="data-retention" number="11" title="Data Retention">
            <P>
              We retain data only for as long as it serves the purpose it was
              collected for, or as long as the law requires.
            </P>

            <DataTable
              caption="Data retention periods"
              head={["Data", "Retention period"]}
              rows={[
                ["Detailed visitor journey data (sessions, page views, interactions)", "90 days, then automatically deleted"],
                ["Booking and conversion records", "For the life of the account, as the basis of historical reporting"],
                ["Aggregated advertising and analytics metrics", "For the life of the account"],
                ["OAuth access tokens", "Until disconnected, revoked, or expired"],
                ["Account and agency records", "For the life of the account, then deleted within 90 days of closure"],
                ["Security and credential audit logs", "24 months"],
                ["Billing and invoice records", "8 years, as required by Indian tax law"],
                ["Backups", "Rolling 30-day window, after which they expire automatically"],
              ]}
            />

            <P>
              When an agency closes its account, we delete or irreversibly anonymise
              its data within <Strong>90 days</Strong>, except where a longer period
              is legally required — principally billing records. Deletion propagates
              to backups as those backups expire on the schedule above.
            </P>

            <Callout tone="info" title="Automatic minimisation">
              Detailed journey data is removed on a rolling 90-day schedule by an
              automated process. The aggregated reporting an agency depends on is
              preserved, so historical dashboards remain accurate while the
              underlying individual-level records are discarded.
            </Callout>
          </Section>

          {/* ── 12. Contact ───────────────────────────────────────────────── */}
          <Section id="contact" number="12" title="Contact Information">
            <P>
              For any question, request or complaint concerning privacy or this
              policy, please contact us. We read every message.
            </P>

            <div className="rounded-xl border border-line bg-card p-5 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-tertiary">
                Data protection contact
              </p>
              <p className="mt-3 text-lg font-semibold text-ink">Social Hippi</p>
              <dl className="mt-3 space-y-1.5 text-[15px] text-ink-secondary">
                <div className="flex flex-wrap gap-x-2">
                  <dt className="font-medium text-ink">Email:</dt>
                  <dd>
                    <MailLink />
                  </dd>
                </div>
                <div className="flex flex-wrap gap-x-2">
                  <dt className="font-medium text-ink">Website:</dt>
                  <dd>
                    <a
                      href={PUBLIC_URL}
                      className="font-medium text-brand underline underline-offset-2 hover:text-brand-hover"
                    >
                      {PUBLIC_URL.replace(/^https?:\/\//, "")}
                    </a>
                  </dd>
                </div>
                <div className="flex flex-wrap gap-x-2">
                  <dt className="font-medium text-ink">Response time:</dt>
                  <dd>Within 30 days</dd>
                </div>
              </dl>
            </div>

            <H3>Changes to this policy</H3>
            <P>
              We may update this policy as the product evolves or the law changes.
              The <Strong>Last updated</Strong> date at the top of this page always
              reflects the current version. Where a change materially affects how we
              handle personal data, we will notify account holders by email at least{" "}
              <Strong>30 days</Strong> before it takes effect. Continued use of
              HotelTrack after that date constitutes acceptance of the revised
              policy.
            </P>
          </Section>
        </main>

        <p className="mt-12 border-t border-line pt-6 text-sm text-ink-tertiary">
          This policy is provided for transparency and does not constitute legal
          advice. Agencies and hotels remain responsible for their own compliance
          obligations towards their customers and website visitors.
        </p>
      </div>

      {/* Footer */}
      <footer className="border-t border-line py-8 text-center text-sm text-ink-tertiary">
        <p>
          HotelTrack · Privacy Policy · Last updated {LAST_UPDATED} ·{" "}
          <a
            href={PUBLIC_URL}
            className="font-medium text-brand underline-offset-2 hover:underline"
          >
            {PUBLIC_URL.replace(/^https?:\/\//, "")}
          </a>
        </p>
        <p className="mt-2">
          <Link href="/setup-guide" className="underline-offset-2 hover:text-ink hover:underline">
            Setup guide
          </Link>
          <span className="mx-2 text-ink-disabled">·</span>
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline-offset-2 hover:text-ink hover:underline">
            {CONTACT_EMAIL}
          </a>
        </p>
      </footer>
    </div>
  );
}
