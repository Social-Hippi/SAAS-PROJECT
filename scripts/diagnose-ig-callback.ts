import "./load-env";
import { prisma } from "../lib/prisma";

// READ-ONLY: where did the Instagram OAuth callback die? It writes a
// TokenAuditLog (encrypt) at the LAST step before the DB upsert, so:
//   - audit row present, no connection  → failed between encrypt and upsert
//   - no audit row                       → failed earlier (code exchange / getProfile)
// Also dumps any instagram token-audit + sync-failure history.

const iso = (d: Date) => d.toISOString();

async function main() {
  const total = await prisma.instagramConnection.count();
  console.log("InstagramConnection rows (all agencies):", total);

  const igAudits = await prisma.tokenAuditLog.findMany({
    where: { tokenType: "instagram" },
    orderBy: { createdAt: "desc" },
    take: 15,
    select: { createdAt: true, action: true, success: true, source: true, errorReason: true, hotelClientId: true },
  });
  console.log(`\nInstagram TokenAuditLog rows (${igAudits.length}):`);
  if (igAudits.length === 0) {
    console.log("  NONE — the callback never reached encryptWithAudit (failed at code exchange or getProfile, OR callback never ran).");
  }
  for (const a of igAudits) {
    console.log(
      `  ${iso(a.createdAt)} action=${a.action} success=${a.success} source=${a.source}` +
        (a.errorReason ? ` reason="${a.errorReason}"` : "") +
        ` hotel=${a.hotelClientId ?? "-"}`,
    );
  }

  const igFails = await prisma.syncFailure.findMany({
    where: { tokenType: "instagram" },
    orderBy: { failedAt: "desc" },
    take: 10,
    select: { failedAt: true, reason: true, resolvedAt: true, hotelClientId: true },
  });
  console.log(`\nInstagram SyncFailure rows (${igFails.length}):`);
  if (igFails.length === 0) console.log("  none");
  for (const f of igFails) {
    console.log(`  ${iso(f.failedAt)} resolved=${f.resolvedAt ? "yes" : "NO"} hotel=${f.hotelClientId ?? "-"} — ${f.reason}`);
  }

  // OAuth env presence (values redacted) — a missing one makes oauthEnv() throw
  // inside exchange, which the callback swallows into ig_error=exchange_failed.
  console.log("\nOAuth env configured (locally):");
  for (const k of ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "INSTAGRAM_REDIRECT_URI"]) {
    const v = process.env[k];
    console.log(`  ${k}: ${v ? `set (${k === "INSTAGRAM_REDIRECT_URI" ? v : `${v.length} chars`})` : "MISSING"}`);
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
