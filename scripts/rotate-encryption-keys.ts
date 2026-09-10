import "./load-env";
import { prisma } from "../lib/prisma";
import {
  decryptToken,
  encryptToken,
  getCiphertextVersion,
  getCurrentKeyVersion,
} from "../lib/encryption";

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — encryption key rotation (see SECURITY.md / lib/encryption.ts).
//
// Re-encrypts every stored secret from its current key version to the CURRENT
// version (ENCRYPTION_KEY_VERSION). Rows already on the target version are
// skipped, so the script is idempotent and safe to re-run.
//
// No-downtime rotation flow (e.g. v1 -> v2):
//   1. ENCRYPTION_KEY_V2=$(openssl rand -hex 32)   # add the new key
//   2. ENCRYPTION_KEY_VERSION=v2                    # new writes use v2
//      (keep ENCRYPTION_KEY_V1 in place — the script needs it to read old rows)
//   3. npm run rotate:keys                          # re-encrypt everything to v2
//   4. once "0 remaining on old versions", retire ENCRYPTION_KEY_V1.
//
// Flags:  --dry-run   report what would change, write nothing.
//
// NOTE: the spec names MetaToken + SocialAccount. GoogleAnalyticsConnection also
// stores AES-encrypted credentials, so it is included — omitting it would make
// those rows undecryptable once an old key is retired.
//
// The ciphertext is read via RAW SQL because the Prisma client strips the
// encrypted columns from normal query results (Layer 4).
// ─────────────────────────────────────────────────────────────────────────────

type Target = {
  label: string;
  tokenType: string;
  table: string;
  column: string;
  hasHotel: boolean;
  save: (id: string, cipher: string) => Promise<unknown>;
};

const TARGETS: Target[] = [
  {
    label: "MetaToken.encryptedToken",
    tokenType: "meta_ads",
    table: "MetaToken",
    column: "encryptedToken",
    hasHotel: false,
    save: (id, cipher) =>
      prisma.metaToken.update({ where: { id }, data: { encryptedToken: cipher } }),
  },
  {
    label: "InstagramConnection.encryptedToken",
    tokenType: "instagram",
    table: "InstagramConnection",
    column: "encryptedToken",
    hasHotel: true,
    save: (id, cipher) =>
      prisma.instagramConnection.update({ where: { id }, data: { encryptedToken: cipher } }),
  },
  {
    label: "GoogleAnalyticsConnection.encryptedCredentials",
    tokenType: "ga_credentials",
    table: "GoogleAnalyticsConnection",
    column: "encryptedCredentials",
    hasHotel: true,
    save: (id, cipher) =>
      prisma.googleAnalyticsConnection.update({
        where: { id },
        data: { encryptedCredentials: cipher },
      }),
  },
];

type Row = { id: string; cipher: string; agencyId: string; hotelClientId: string | null };

async function loadRows(t: Target, agencyId?: string): Promise<Row[]> {
  const hotel = t.hasHotel ? '"hotelClientId"' : 'NULL AS "hotelClientId"';
  const where = agencyId ? 'WHERE "agencyId" = $1' : "";
  const sql = `SELECT "id", "${t.column}" AS cipher, "agencyId", ${hotel} FROM "${t.table}" ${where}`;
  return agencyId
    ? prisma.$queryRawUnsafe<Row[]>(sql, agencyId)
    : prisma.$queryRawUnsafe<Row[]>(sql);
}

export type RotateResult = { rotated: number; skipped: number; failed: number };

/**
 * Re-encrypt every stored secret to the current key version. Exported so tests
 * can run it scoped to one agency. `onLog` lets the CLI print per-row progress.
 */
export async function rotateAll(
  opts: { dryRun?: boolean; agencyId?: string; onLog?: (msg: string) => void } = {},
): Promise<RotateResult> {
  const targetVersion = getCurrentKeyVersion();
  const log = opts.onLog ?? (() => {});
  const result: RotateResult = { rotated: 0, skipped: 0, failed: 0 };

  for (const t of TARGETS) {
    const rows = await loadRows(t, opts.agencyId);
    let tRotated = 0;
    let tSkipped = 0;
    for (const row of rows) {
      const from = getCiphertextVersion(row.cipher) ?? "legacy";
      if (from === targetVersion) {
        tSkipped++;
        result.skipped++;
        continue;
      }
      try {
        // Decrypt with the old key (auto-detected), re-encrypt with the current
        // version. The plaintext lives only inside this loop iteration.
        const reencrypted = encryptToken(decryptToken(row.cipher));
        if (!opts.dryRun) {
          await t.save(row.id, reencrypted);
          await prisma.tokenAuditLog
            .create({
              data: {
                agencyId: row.agencyId,
                hotelClientId: row.hotelClientId,
                tokenType: t.tokenType,
                action: "rotated",
                success: true,
                source: "script:rotate-encryption-keys",
              },
            })
            .catch(() => {});
        }
        tRotated++;
        result.rotated++;
        log(`  ✓ ${t.label} ${row.id}  ${from} → ${targetVersion}`);
      } catch (err) {
        result.failed++;
        const reason = err instanceof Error ? err.message : "unknown error";
        log(`  ✗ ${t.label} ${row.id}  FAILED: ${reason}`);
      }
    }
    log(`  ${t.label}: ${tRotated} rotated, ${tSkipped} already on ${targetVersion}\n`);
  }

  return result;
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(
    `\n🔑 Rotating all stored secrets to ${getCurrentKeyVersion()}` +
      (dryRun ? "  (DRY RUN — no writes)" : "") +
      "\n",
  );
  const { rotated, skipped, failed } = await rotateAll({
    dryRun,
    onLog: (m) => console.log(m),
  });
  console.log(
    `Done — ${rotated} rotated, ${skipped} already current, ${failed} failed.` +
      (dryRun ? "  (dry run)" : ""),
  );
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

// Only run the CLI when executed directly (not when imported by a test).
if (process.argv[1] && /rotate-encryption-keys\.(ts|js)$/.test(process.argv[1])) {
  main().catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
}
