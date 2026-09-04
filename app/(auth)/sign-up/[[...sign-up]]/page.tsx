import type { Metadata } from "next";
import { SignUp } from "@clerk/nextjs";
import { AuthShell, authAppearance } from "../../AuthShell";

export const metadata: Metadata = {
  title: "Create an account · HotelTrack",
  description: "Create your HotelTrack account — marketing attribution for hotels.",
};

export default function SignUpPage() {
  return (
    <AuthShell title="Create your account" subtitle="Get started with HotelTrack.">
      <SignUp appearance={authAppearance} />
    </AuthShell>
  );
}
