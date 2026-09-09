import Link from "next/link";
import type { ReactNode } from "react";

// Shared chrome for /sign-in and /sign-up.
//
// Both pages previously rendered a bare <SignIn /> on a gradient with no props,
// so the first screen of the product carried Clerk's own identity rather than
// HotelTrack's: the card heading is the Clerk APPLICATION NAME, which had never
// been changed from the scaffold default ("SAASPROJECT", taken from
// package.json). A hotel owner was signing in to a product with a different name
// from the one they were sold.
//
// This wraps the widget in HotelTrack's own frame — wordmark, one line of
// context, and the app's card/border/typography tokens — so the auth screen
// belongs to the same product as the dashboard behind it.
//
// The Clerk application name still appears INSIDE the widget and can only be
// changed in the Clerk dashboard; renaming it is tracked as an external action.
// The wordmark above the card means the page reads as HotelTrack either way.

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          {/* Same wordmark treatment as the app sidebar — one product identity. */}
          <Link
            href="/"
            className="text-2xl font-semibold tracking-tight text-ink transition hover:text-brand"
          >
            HotelTrack
          </Link>
          <h1 className="mt-6 text-lg font-semibold tracking-tight text-ink">{title}</h1>
          <p className="mt-1 text-sm text-ink-tertiary">{subtitle}</p>
        </div>

        <div className="flex justify-center">{children}</div>

        <p className="mt-8 text-center text-xs text-ink-disabled">
          Marketing attribution for hotels.
        </p>
      </div>
    </main>
  );
}

/**
 * Clerk `appearance` for the auth widgets.
 *
 * Uses the app's OWN Tailwind token classes rather than hard-coded colours, so
 * the widget follows the existing light/dark theme automatically and stays in
 * step with app/globals.css instead of drifting from it.
 *
 * `header` is hidden because AuthShell already states the product name and the
 * page's purpose above the card; leaving Clerk's header in place would show the
 * Clerk application name a second time, directly under the HotelTrack wordmark.
 */
export const authAppearance = {
  elements: {
    rootBox: "w-full",
    cardBox: "w-full shadow-card",
    card: "bg-card border border-line shadow-none rounded-card",
    header: "hidden",
    socialButtonsBlockButton:
      "border border-line-strong bg-page text-ink hover:bg-elevated rounded-button",
    socialButtonsBlockButtonText: "text-ink font-medium",
    dividerLine: "bg-line",
    dividerText: "text-ink-tertiary",
    formFieldLabel: "text-ink font-medium",
    formFieldInput:
      "bg-page border border-line-strong text-ink rounded-button focus:border-brand focus:ring-1 focus:ring-brand",
    formButtonPrimary:
      "bg-brand hover:bg-brand-hover text-white rounded-button font-medium normal-case",
    footerActionText: "text-ink-tertiary",
    footerActionLink: "text-brand hover:text-brand-hover font-medium",
    identityPreviewText: "text-ink",
    identityPreviewEditButton: "text-brand",
    formFieldInputShowPasswordButton: "text-ink-tertiary",
    otpCodeFieldInput: "border border-line-strong text-ink",
  },
} as const;
