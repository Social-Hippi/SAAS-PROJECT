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
 * THE HASH IS THE ROW'S OWN `phoneHash`, not one recomputed from the plaintext.
 *
 * That is deliberate, and it is the opposite of what this script did first. The
 * value has to match what a future ingest will write for this row, and the
 * ingest builds it from the `phoneHash` it has just looked the row up by
 * (`findFirst where phoneHash` — the unique key on this table). Aligning to the
 * stored hash therefore guarantees the match. Recomputing from the plaintext
 * could only introduce a disagreement: `normalizePhone` has been corrected once
 * already, so an old row's plaintext may normalise differently today than when
 * its hash was written — and in that case the stored hash is the one the whole
 * system joins on, and the fresh one would be the wrong answer.
 *
 * It also means this script needs NO PII salt, and so cannot repeat the failure
 * where a local run without the real salt wrote rows nobody could match.
 *
 * Idempotent: a row already carrying a hashed id is left alone, so a re-run
 * after a partial failure is safe.
 *
 * DRY RUN BY DEFAULT. Pass --write to apply.
 *
 *   npx tsx scripts/redact-kraya-lead-phones.ts
 *   npx tsx scripts/redact-kraya-lead-phones.ts --write
 */
import "./load-env";
import { prisma } from "@/lib/prisma";

const PREFIX = "export:";
const WRITE = process.argv.includes("--write");

async function main() {
  const rows = await prisma.whatsAppConversation.findMany({
    where: { krayaLeadId: { startsWith: PREFIX } },
    select: { id: true, krayaLeadId: true, phoneHash: true, phoneLast4: true },
  });

  let rewritten = 0;
  let alreadyHashed = 0;
  let unusable = 0;

  for (const r of rows) {
    const raw = (r.krayaLeadId ?? "").slice(PREFIX.length);

    // Only a value that is ALL DIGITS is a phone number. Anything else is
    // already a hash from a previous run.
    if (!/^[0-9]+$/.test(raw)) {
      alreadyHashed += 1;
      continue;
    }

    // The row's own hash: the value the ingest looks this row up by, and so the
    // value a future re-import will rebuild the id from.
    const hash = r.phoneHash;
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) {
      unusable += 1;
      console.warn(`  ${r.id}: no usable phoneHash on the row — skipped for inspection`);
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
      `\n  no usable phoneHash (skipped): ${unusable}` +
      (WRITE ? "" : "\n\nDry run — pass --write to apply."),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
