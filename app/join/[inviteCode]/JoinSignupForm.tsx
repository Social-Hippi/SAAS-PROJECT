"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { completeHotelSignup } from "./actions";

// Hotel self-signup form. Submits to the server action, which creates the hotel's
// Clerk account (Backend SDK) + the HotelClient.
//
// It used to redirect to /hotel/<id>/dashboard on success. Hotel logins are
// currently disabled at the authorization layer (hotelAccessNeutralized in
// lib/hotel-auth.ts), so that route 404s and proxy.ts bounces the signed-in
// hotel user to the marketing homepage with no explanation — the signup
// completed, the account existed, and the product silently ejected them.
//
// It now resolves to an on-page confirmation that says what actually happened
// and what happens next. No redirect into a dead route, and no dashboard is
// promised that the product cannot open.

const CHANNEL_MANAGERS = ["None", "djubo", "eZee", "STAAH", "RateGain", "Other", "Custom"];
const inputCls =
  "w-full rounded-lg border border-line-strong bg-page px-3 py-2 text-sm text-ink placeholder:text-ink-disabled outline-none focus:border-brand focus:ring-1 focus:ring-brand";
const labelCls = "block text-sm font-medium text-ink-secondary";

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className={labelCls}>{label}</label>
      <div className="mt-1">{children}</div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

export function JoinSignupForm({
  inviteCode,
  agencyName,
  alreadyAuthed,
}: {
  inviteCode: string;
  agencyName: string;
  alreadyAuthed: boolean;
}) {
  const [pending, start] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [existingEmail, setExistingEmail] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [sameWa, setSameWa] = useState(false);
  const [v, setV] = useState({
    hotelName: "", websiteUrl: "", contactName: "", ownerEmail: "", password: "",
    ownerPhone: "", address: "", whatsappNumber: "", roomCount: "", channelManager: "None", otaCommissionRate: "18",
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setV((p) => ({ ...p, [k]: e.target.value }));
  const waValue = sameWa ? v.ownerPhone : v.whatsappNumber;

  if (done) {
    return (
      <div className="rounded-card border border-line bg-card p-6 text-center shadow-card">
        <p className="text-2xl" aria-hidden>
          ✓
        </p>
        <h2 className="mt-2 text-lg font-semibold tracking-tight text-ink">
          You&apos;re set up with {agencyName}
        </h2>
        <p className="mt-2 text-sm text-ink-secondary">
          Your hotel has been added to {agencyName}&apos;s account. They&apos;ll finish
          connecting your marketing data and share your performance reports with you.
        </p>
        <div className="mt-5 rounded-button border border-line bg-page p-4 text-left">
          <p className="text-sm font-medium text-ink">What happens next</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink-tertiary">
            <li>{agencyName} installs a small tracking snippet on your website.</li>
            <li>They connect your ad and analytics accounts.</li>
            <li>You receive a report link by email — no login needed.</li>
          </ol>
        </div>
        <p className="mt-5 text-xs text-ink-disabled">
          Questions? Contact {agencyName} directly — they manage your account.
        </p>
      </div>
    );
  }


  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null); setErrs({}); setExistingEmail(false);
    start(async () => {
      const res = await completeHotelSignup({ ...v, whatsappNumber: waValue, inviteCode });
      if (!res.ok) {
        setFormError(res.error);
        setErrs(res.fieldErrors ?? {});
        setExistingEmail(!!res.existingEmail);
        return;
      }
      setDone(true);
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-line bg-card p-6">
      <Field id="hotelName" label="Hotel name" error={errs.hotelName}>
        <input id="hotelName" value={v.hotelName} onChange={set("hotelName")} required className={inputCls} placeholder="Neelakurinji Resort" />
      </Field>
      <Field id="websiteUrl" label="Website URL" error={errs.websiteUrl}>
        <input id="websiteUrl" value={v.websiteUrl} onChange={set("websiteUrl")} required className={inputCls} placeholder="neelakurinji.com" />
      </Field>
      <Field id="contactName" label="Owner / contact name" error={errs.contactName}>
        <input id="contactName" value={v.contactName} onChange={set("contactName")} required className={inputCls} placeholder="Your name" />
      </Field>
      <Field id="ownerEmail" label={alreadyAuthed ? "Contact email" : "Owner email (used to log in)"} error={errs.ownerEmail}>
        <input id="ownerEmail" type="email" value={v.ownerEmail} onChange={set("ownerEmail")} required className={inputCls} placeholder="you@hotel.com" />
      </Field>
      {!alreadyAuthed && (
        <Field id="password" label="Create a password" error={errs.password}>
          <input id="password" type="password" value={v.password} onChange={set("password")} required autoComplete="new-password" className={inputCls} placeholder="At least 8 characters" />
        </Field>
      )}
      <Field id="ownerPhone" label="Phone number" error={errs.ownerPhone}>
        <input id="ownerPhone" type="tel" value={v.ownerPhone} onChange={set("ownerPhone")} required className={inputCls} placeholder="+91 98765 43210" />
      </Field>
      <Field id="whatsappNumber" label="WhatsApp number" error={errs.whatsappNumber}>
        <input id="whatsappNumber" type="tel" value={waValue} onChange={set("whatsappNumber")} readOnly={sameWa} className={`${inputCls} ${sameWa ? "opacity-60" : ""}`} placeholder="+91 98765 43210" />
        <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-ink-secondary">
          <input type="checkbox" checked={sameWa} onChange={(e) => setSameWa(e.target.checked)} className="h-4 w-4 rounded border-line-strong" />
          Same as phone number
        </label>
      </Field>
      <Field id="address" label="Hotel address" error={errs.address}>
        <textarea id="address" value={v.address} onChange={set("address")} rows={2} required className={`${inputCls} resize-y`} placeholder="Street, City, State, PIN" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="roomCount" label="Number of rooms (optional)" error={errs.roomCount}>
          <input id="roomCount" type="number" min={0} value={v.roomCount} onChange={set("roomCount")} className={inputCls} placeholder="e.g. 24" />
        </Field>
        <Field id="otaCommissionRate" label="OTA commission rate (%)">
          <input id="otaCommissionRate" type="number" min={0} max={50} step={0.5} value={v.otaCommissionRate} onChange={set("otaCommissionRate")} className={inputCls} />
        </Field>
      </div>
      <Field id="channelManager" label="Channel manager">
        <select id="channelManager" value={v.channelManager} onChange={set("channelManager")} className={inputCls}>
          {CHANNEL_MANAGERS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>

      {formError && (
        <div className="text-sm text-danger">
          {formError}
          {existingEmail && (
            <>{" "}
              <Link href={`/sign-in?redirect_url=${encodeURIComponent(`/join/${inviteCode}`)}`} className="font-medium text-brand hover:underline">
                Sign in instead →
              </Link>
            </>
          )}
        </div>
      )}

      <p className="text-xs text-ink-tertiary">
        By signing up, you agree to be managed by {agencyName} in HotelTrack. You can leave the agency at any time.
      </p>
      <button type="submit" disabled={pending} className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60">
        {pending ? "Creating…" : "Create Hotel Account"}
      </button>
    </form>
  );
}
