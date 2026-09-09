import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";
import { AuthShell, authAppearance } from "../../AuthShell";

export const metadata: Metadata = {
  title: "Sign in · HotelTrack",
  description: "Sign in to HotelTrack — marketing attribution for hotels.",
};

export default function SignInPage() {
  return (
    <AuthShell title="Sign in" subtitle="Welcome back. Sign in to continue.">
      <SignIn appearance={authAppearance} />
    </AuthShell>
  );
}
