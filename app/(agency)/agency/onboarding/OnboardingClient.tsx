"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useUser } from "@clerk/nextjs";
import { AGENCY_NAME_MAX } from "@/lib/agency-validation";
import { createAgencyForCurrentUser } from "./actions";

export function OnboardingClient({ alreadyMember }: { alreadyMember: boolean }) {
  const router = useRouter();
  const { getToken } = useAuth();
  const { user } = useUser();
  const [loading, setLoading] = useState(alreadyMember);
  const [error, setError] = useState<string | null>(null);

  // Refresh the Clerk session token so the new `role` claim is visible to Proxy
  // immediately, then continue to the dashboard.
  const finish = useCallback(async () => {
    try {
      await user?.reload();
      await getToken({ skipCache: true });
    } catch {
      // best-effort; navigation will still trigger a fresh token fetch
    }
    router.replace("/agency/dashboard");
    router.refresh();
  }, [user, getToken, router]);

  useEffect(() => {
    if (alreadyMember) void finish();
  }, [alreadyMember, finish]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const formData = new FormData(event.currentTarget);
    const result = await createAgencyForCurrentUser(formData);
    if (result?.error) {
      setError(result.error);
      setLoading(false);
      return;
    }
    await finish();
  }

  if (alreadyMember) {
    return <p className="text-ink-tertiary">Setting up your workspace…</p>;
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full max-w-sm space-y-4 rounded-xl border border-line p-6"
    >
      <div>
        <h1 className="text-xl font-semibold">Name your organisation</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Everyone on your team sees this name, and it appears on the reports you
          share with hotels. You can change it later in Settings.
        </p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="agencyName" className="text-sm font-medium">
          Organisation name
        </label>
        <input
          id="agencyName"
          name="agencyName"
          placeholder="e.g. Social Hippi"
          autoComplete="organization"
          maxLength={AGENCY_NAME_MAX}
          required
          className="w-full rounded-lg border border-line-strong bg-page px-3 py-2 text-sm text-ink placeholder:text-ink-disabled outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60"
      >
        {loading ? "Creating…" : "Create agency"}
      </button>
    </form>
  );
}
