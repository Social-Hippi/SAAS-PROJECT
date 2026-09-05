# STATUS — canonical metric layer

Where the revenue and paid-classification migration landed, what it changed, and
what it deliberately did not.

## What moved

`lib/metrics/canonical.ts` is now THE classifier and THE revenue sum for every
path that decides paid-ness or totals money. `classifySourceType` and
`rowSourceType` are gone from all nine revenue call sites; `rowSourceType` is
deleted outright. `tests/canonical-adoption.test.ts` holds that line.

## Only two surfaces change numbers

**`/api/agency/overview`** and **`lib/owner-summary.ts`**.

Both previously decided paid-ness with `rowSourceType`, which returned
`influencer` whenever a coupon was present — so a coupon used on a paid Meta or
Google click erased the paid signal and that booking's revenue was excluded from
the ROAS numerator. Under `canonicalSourceType`, paid wins over the coupon, so
that revenue now counts as paid.

Reported ROAS on these two surfaces STRICTLY RISES. Paid revenue only ever gains
rows — a row that was `influencer` because of its coupon can become `meta_ads`
or `google_ads`, never the reverse — and the spend denominator is untouched. Any
step change on those two figures is this commit, not a change in the data.

**Every other migrated site is behaviour-preserving.** `isPaidRow(row)` is
exactly equivalent to `isPaidSourceType(classifySourceType(row))`, because
`canonicalSourceType` returns the paid type before it ever consults the coupon:

    const byUtm = classifySourceType(...);
    if (isPaidSourceType(byUtm)) return byUtm;   // paid short-circuits here
    if (hasCoupon(row)) return "influencer";
    return byUtm;

So for the paid/not-paid question the two agree on every possible row. The
agency dashboard, the CSV export, the weekly alert email, `lib/attribution.ts`
and `lib/owner-metrics.ts` all changed which function they call, not which
answer they get.

One shape change worth knowing: in `aggregateRevenueBySource`, a booking's
GROUP KEY still comes from the coupon (an influencer's bookings stay under their
code) while its `sourceType` is now canonical. A coupon used on a paid click
therefore groups under `influencer` but is typed `meta_ads`. That is deliberate
— "who drove this booking" and "what kind of media was it" are different
questions, and conflating them is what produced the defect.

## Residual 1 — channel-view still uses the old classifier

`lib/channel-view.ts` was explicitly out of scope and still partitions with
`classifySourceType`. It has no coupon-aware branch at all, so a COUPON-ONLY
booking (a coupon with no paid click) is:

  * `influencer` in revenue-by-source, and
  * organic — `instagram_organic` / `facebook_organic` / `direct` — in
    channel-view.

The two screens still disagree about the same booking. This is the same class of
defect the migration just fixed, one file further out.

## Residual 2 — owner-metrics cannot see coupons

The Prisma selects in `lib/owner-metrics.ts` do not project `couponCodeUsed`.
`canonicalSourceType` therefore receives rows with no coupon field, its coupon
branch never fires, and the surface is NOT unified for coupon-only rows — they
still classify by UTM alone.

**The selects were deliberately not widened.** Adding `couponCodeUsed` would
move bookings between buckets in `calculateBookingsBySource`, `calculateROAS`
and the top-campaigns table — a numeric change well beyond routing calls through
one classifier. It should be its own change, with its own before/after.

## Still open

1. **Cancellations and refunds are not excluded from any production revenue
   figure.** `realisedValueOf` and `isRevenueRealised` exist in
   `lib/metrics/canonical.ts` and handle `CANCELLED` / `REFUNDED` / `NO_SHOW`
   plus partial refunds, but no call site supplies a `BookingResolver`, so every
   revenue total still counts cancelled bookings at full value. OTA "commission
   saved" is overstated by the same amount.

2. **`scripts/snippet.src.js` guesses conversion values.** `valueFromText()
   (~line 449)` still falls back to the LARGEST rupee figure on the page when no
   labelled total is found, and Strategy A takes the largest parsed
   `data-ht-value`. A page showing a room rate, a tax line and a loyalty balance
   can book the wrong number, silently.

3. **42 entry points under `prisma/` and `scripts/` import `"dotenv/config"`,**
   which reads `.env` — a file this repo does not have; configuration lives in
   `.env.local`. Every one of them fails without manually exported env vars
   (`npm run seed` dies with `P1003 DatabaseDoesNotExist`). `tests/setup-env.ts`
   fixed this for vitest only. The fix is a shared loader reading `.env.local`
   then `.env`, swapped in for `import "dotenv/config"`.
