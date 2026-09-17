/**
 * Takes the raw phone numbers out of WhatsAppConversation.krayaLeadId.
 *
 * A spreadsheet export carries no Kraya lead id, so lib/kraya-import.ts
 * synthesised one from the phone — `export:919738722199`. Synthesising an id
 * from the guest's identity is sound; storing the number itself was not, and it
 * reached 4,002 rows before anyone looked at the field's contents.
 *
 * Each affected row is rewritten to:
 *
 *     krayaLeadId  export:<phoneHash>   deterministic, unique, no contact detail
 *     phoneLast4   the last four digits, and nothing more of the number
 *
 * The hash is recomputed from the plaintext in the column, NOT copied from
 * `phoneHash` on the row: if the two ever disagreed, copying would paper over
 * the disagreement, and a later re-import keyed on the recomputed value would
 * then fail to match. Rows where they disagree are reported and skipped.
 *
 * Idempotent: a row already carrying a hashed id is left alone, so a re-run
 * after a partial failure is safe.
 *
 * DRY RUN BY DEFAULT. Pass --write to apply.
 *
 *   npx tsx scripts/redact-kraya-lead-phones.ts
 *   npx tsx scripts/redact-kraya-lead-phones.ts --write
 *
 * REQUIRES the real PII_SALT / ENCRYPTION_KEY for the target database. Running
 * it against production with a dev fallback salt would mint hashes that match
 * nothing, silently detaching every rewritten lead from its bookings.
 */
import "./load-env";
import { prisma } from "@/lib/prisma";
import { hashGuestPhone } from "@/lib/booking-identity";

const PREFIX = "export:";
const WRITE = process.argv.includes("--write");

async function main() {
  const rows = await prisma.whatsAppConversation.findMany({
    where: { krayaLeadId: { startsWith: PREFIX } },
    select: { id: true, krayaLeadId: true, phoneHash: true, phoneLast4: true },
  });

  let rewritten = 0;
  let alreadyHashed = 0;
  let mismatched = 0;
  let unusable = 0;

  for (const r of rows) {
    const raw = (r.krayaLeadId ?? "").slice(PREFIX.length);

    // Only a value that is ALL DIGITS is a phone number. Anything else is
    // already a hash from a previous run.
    if (!/^[0-9]+$/.test(raw)) {
      alreadyHashed += 1;
      continue;
    }

    const hash = hashGuestPhone(raw);
    if (!hash) {
      unusable += 1;
      console.warn(`  unusable number on ${r.id} — left as it is for inspection`);
      continue;
    }
    if (hash !== r.phoneHash) {
      mismatched += 1;
      console.warn(`  ${r.id}: recomputed hash differs from phoneHash — skipped`);
      continue;
    }

    const last4 = raw.length >= 4 ? raw.slice(-4) : null;
    if (WRITE) {
      await prisma.whatsAppConversation.update({
        where: { id: r.id },
        data: { krayaLeadId: `${PREFIX}${hash}`, phoneLast4: r.phoneLast4 ?? last4 },
      });
    }
    rewritten += 1;
  }

  console.log(
    `\n${WRITE ? "Rewrote" : "Would rewrite"} ${rewritten} row(s).` +
      `\n  already hashed: ${alreadyHashed}` +
      `\n  hash mismatch (skipped): ${mismatched}` +
      `\n  unusable number (skipped): ${unusable}` +
      (WRITE ? "" : "\n\nDry run — pass --write to apply."),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
