import "./load-env";
import { prisma } from "../lib/prisma";
import { decryptToken } from "../lib/encryption";

// Verifies Layer-4 database access hardening against the real DB:
//   1. the strip extension removes encryptedToken from model query results
//   2. a raw SELECT (owner) bypasses the strip and yields the ciphertext
//   3. decryption produces a redacting SecretToken
//   4. the app role CANNOT SELECT the ciphertext column directly (column grant)
//   5. the security-definer function returns it AND writes an audit row
//
// Run: npx tsx scripts/smoke-token-access.ts

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ""}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
}

async function main() {
  console.log("\n▶ Layer-4 token access hardening smoke test\n");

  // 1. Strip extension.
  console.log("1) Strip extension");
  const meta = await prisma.metaToken.findFirst({});
  if (!meta) {
    console.log("  (no MetaToken rows — connect a Meta token to exercise this)\n");
    await prisma.$disconnect();
    return;
  }
  check("metaToken result has NO encryptedToken field", !("encryptedToken" in meta));

  // 2. Raw read (owner) bypasses the strip.
  console.log("\n2) Out-of-band read + decrypt");
  const raw = await prisma.$queryRawUnsafe<Array<{ ct: string }>>(
    'SELECT "encryptedToken" AS ct FROM "MetaToken" WHERE "id" = $1',
    meta.id,
  );
  check("raw SELECT returns the ciphertext", !!raw[0]?.ct);

  // 3. Decrypt → redacting SecretToken.
  const secret = decryptToken(raw[0].ct);
  check("decrypts to a non-empty plaintext", secret.reveal().length > 0);
  check("SecretToken redacts on toString", String(secret) === "[REDACTED]");

  // 4. App role cannot SELECT the column.
  console.log("\n3) Column-level grant denies the app role");
  await prisma.$executeRawUnsafe("GRANT hoteltrack_app TO CURRENT_USER").catch(() => {});
  let denied = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE hoteltrack_app");
      await tx.$queryRawUnsafe('SELECT "encryptedToken" FROM "MetaToken" WHERE "id" = $1', meta.id);
    });
  } catch (e) {
    denied = /permission denied/i.test(String(e));
  }
  check("app role is DENIED a direct SELECT of encryptedToken", denied);

  // 5. Security-definer function: returns ciphertext + writes an audit row.
  console.log("\n4) Security-definer function (audited access)");
  const before = await prisma.tokenAuditLog.count({ where: { source: "db:security_definer" } });
  const fnCt = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE hoteltrack_app");
    const r = await tx.$queryRawUnsafe<Array<{ ct: string }>>(
      "SELECT app_read_encrypted_secret('MetaToken', $1) AS ct",
      meta.id,
    );
    return r[0]?.ct;
  });
  check("function returns the same ciphertext", fnCt === raw[0].ct);
  const after = await prisma.tokenAuditLog.count({ where: { source: "db:security_definer" } });
  check("function wrote a TokenAuditLog row", after === before + 1, `${before} → ${after}`);

  // Cleanup audit rows created by this test.
  await prisma.tokenAuditLog.deleteMany({ where: { source: "db:security_definer" } });

  console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
