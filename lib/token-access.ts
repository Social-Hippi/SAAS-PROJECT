import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptToken, type SecretToken } from "@/lib/encryption";
import {
  decryptWithAudit,
  recordDecryptFailure,
  type AuditContext,
} from "@/lib/token-audit";

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 4 — the ONE sanctioned path to a decrypted secret.
//
// The Prisma client (lib/prisma.ts) strips encryptedToken/encryptedCredentials
// from every model query result. The only way to obtain a plaintext secret is
// getTokenForApiCall(), which:
//   • reads the ciphertext OUT of band — a raw SELECT (owner) or the
//     security-definer DB function (once the app runs as the non-owner role,
//     whose direct column SELECT is revoked — see the add_token_secret_access
//     migration),
//   • decrypts it IN MEMORY and records the access in the audit log,
//   • returns a SecretToken whose plaintext exists only for this call's scope
//     (callers .reveal() it at the external API boundary and never persist it).
// ─────────────────────────────────────────────────────────────────────────────

// Fixed allowlist of secret-bearing tables + their ciphertext column. The
// table/column identifiers below are constants — never caller input.
const SECRET_SOURCES = {
  meta_ads: { table: "MetaToken", column: "encryptedToken" },
  instagram: { table: "InstagramConnection", column: "encryptedToken" },
  ga_credentials: { table: "GoogleAnalyticsConnection", column: "encryptedCredentials" },
  // GA4 OAuth: two ciphertext columns on one row (access + refresh tokens).
  // NOTE: if TOKEN_SECRET_ACCESS=definer is ever enabled, add GA4Connection's
  // columns to the app_read_encrypted_secret() function too.
  ga4_access: { table: "Ga4Connection", column: "accessToken" },
  ga4_refresh: { table: "Ga4Connection", column: "refreshToken" },
  // Google Ads OAuth: access + refresh ciphertext on one row (like GA4 above).
  // NOTE: if TOKEN_SECRET_ACCESS=definer is ever enabled, add GoogleAdsConnection's
  // columns to the app_read_encrypted_secret() function too.
  google_ads_access: { table: "GoogleAdsConnection", column: "accessToken" },
  google_ads_refresh: { table: "GoogleAdsConnection", column: "refreshToken" },
  // Booking provider shared secret / API key (Phase 1B). Read ONLY through
  // getTokenForApiCall so every access is audited, like every other secret.
  booking_provider: { table: "BookingConnection", column: "credentials" },
} as const;

export type SecretKind = keyof typeof SECRET_SOURCES;

// Once the app connects as hoteltrack_app (column SELECT revoked), set
// TOKEN_SECRET_ACCESS=definer so reads go through the security-definer function.
const VIA_DEFINER = process.env.TOKEN_SECRET_ACCESS === "definer";

async function readCiphertext(kind: SecretKind, id: string): Promise<string | null> {
  if (VIA_DEFINER) {
    // The function logs the access (DB-enforced auditing) and returns the value.
    const rows = await prisma.$queryRaw<Array<{ ct: string | null }>>`
      SELECT app_read_encrypted_secret(${SECRET_SOURCES[kind].table}, ${id}) AS ct`;
    return rows[0]?.ct ?? null;
  }
  const { table, column } = SECRET_SOURCES[kind];
  // table/column are from the constant allowlist; id is parameterized ($1).
  const rows = await prisma.$queryRawUnsafe<Array<{ ct: string | null }>>(
    `SELECT "${column}" AS ct FROM "${table}" WHERE id = $1`,
    id,
  );
  return rows[0]?.ct ?? null;
}

/**
 * Fetch + decrypt a stored secret for the duration of one API call. Returns a
 * SecretToken — `.reveal()` it only at the point you hand it to the external
 * service, and never assign the plaintext to anything that outlives the call.
 */
export async function getTokenForApiCall(
  kind: SecretKind,
  id: string,
  audit: Omit<AuditContext, "tokenType">,
): Promise<SecretToken> {
  const ct = await readCiphertext(kind, id);
  if (ct == null) throw new Error("Encrypted secret not found.");

  const ctx: AuditContext = { ...audit, tokenType: kind };

  if (VIA_DEFINER) {
    // The security-definer function already logged the successful access; here we
    // only need to log decryption FAILURES (tampering / wrong key).
    try {
      return decryptToken(ct);
    } catch (err) {
      await recordDecryptFailure(ctx, err);
      throw err;
    }
  }

  // Owner/direct mode: decryptWithAudit records success + failure + threshold.
  return decryptWithAudit(ct, ctx);
}
