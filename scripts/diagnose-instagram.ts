import "./load-env";
import { prisma } from "../lib/prisma";
import { decryptToken } from "../lib/encryption";

// READ-ONLY diagnosis of the Instagram data chain. Writes nothing.
// CHECK 1/2 (connection row), CHECK 4 (live IG API call), CHECK 5 (snapshot rows).
// Token only ever goes in the Authorization header; never printed.

const IG_GRAPH = "https://graph.instagram.com";
const IG_API_VERSION = process.env.INSTAGRAM_API_VERSION ?? "v21.0";
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "null");

async function igGet(path: string, token: string, fields: string) {
  const url = new URL(`${IG_GRAPH}/${IG_API_VERSION}/${path}`);
  url.searchParams.set("fields", fields);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

async function main() {
  // CHECK 1 + 2 — the most recently created connection.
  const conn = await prisma.instagramConnection.findFirst({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      hotelClientId: true,
      agencyId: true,
      igUserId: true,
      username: true,
      igAccountType: true,
      tokenType: true,
      status: true,
      errorMessage: true,
      tokenExpiresAt: true,
      lastSyncedAt: true,
      lastRefreshedAt: true,
      createdAt: true,
      encryptedToken: true,
    },
  });
  if (!conn) {
    console.log("CHECK 1: No InstagramConnection rows exist at all.");
    return;
  }

  const hotel = await prisma.hotelClient.findUnique({
    where: { id: conn.hotelClientId },
    select: { name: true },
  });

  console.log("══ CHECK 1 — Connection row (most recent) ══");
  console.log("  hotel:           ", hotel?.name, `(${conn.hotelClientId})`);
  console.log("  igUserId:        ", conn.igUserId);
  console.log("  username:        ", conn.username);
  console.log("  igAccountType:   ", conn.igAccountType);
  console.log("  tokenType:       ", conn.tokenType);
  console.log("  status:          ", conn.status, conn.status !== "active" ? "  <-- NOT active" : "");
  console.log("  errorMessage:    ", conn.errorMessage ?? "(none)");
  console.log("  tokenExpiresAt:  ", iso(conn.tokenExpiresAt));
  console.log("  lastRefreshedAt: ", iso(conn.lastRefreshedAt));
  console.log("  createdAt:       ", iso(conn.createdAt));
  console.log("  encryptedToken:  ", conn.encryptedToken ? `non-empty (${conn.encryptedToken.length} chars)` : "EMPTY");

  console.log("\n══ CHECK 2 — Has the sync ever run? ══");
  console.log("  lastSyncedAt:    ", iso(conn.lastSyncedAt), conn.lastSyncedAt ? "" : "  <-- NEVER SYNCED");

  // CHECK 4 — live IG API call with this connection's token.
  console.log("\n══ CHECK 4 — Live graph.instagram.com call ══");
  if (conn.tokenType !== "igaa_direct") {
    console.log("  Skipped: tokenType is not igaa_direct (this is a deprecated EAA row).");
  } else if (!conn.encryptedToken) {
    console.log("  Skipped: encryptedToken is empty.");
  } else {
    let token: string;
    try {
      // Same out-of-band raw read as the other diagnostics (model query strips it).
      const raw = await prisma.$queryRawUnsafe<Array<{ ct: string }>>(
        'SELECT "encryptedToken" AS ct FROM "InstagramConnection" WHERE "id" = $1',
        conn.id,
      );
      token = decryptToken(raw[0].ct).reveal();
      console.log("  Decrypt: OK (token decrypted, length hidden)");
    } catch (e) {
      console.log("  Decrypt FAILED:", e instanceof Error ? e.message : e);
      return;
    }

    // (a) the exact call CHECK 4 asked for, on the igUserId node
    const byId = await igGet(conn.igUserId, token, "username,account_type,followers_count,media_count");
    console.log(`  GET /${conn.igUserId}?fields=username,account_type,followers_count,media_count`);
    console.log(`    HTTP ${byId.status} ${byId.ok ? "OK" : "ERROR"} →`, JSON.stringify(byId.json));

    // (b) what the sync's getProfile actually calls ("me" node)
    const me = await igGet("me", token, "user_id,username,account_type,followers_count");
    console.log(`  GET /me?fields=user_id,username,account_type,followers_count`);
    console.log(`    HTTP ${me.status} ${me.ok ? "OK" : "ERROR"} →`, JSON.stringify(me.json));
  }

  // CHECK 5 — snapshot tables for this hotel.
  console.log("\n══ CHECK 5 — SocialSnapshot / PostSnapshot rows ══");
  const [socialCount, postCount, latestSocial, latestPost] = await Promise.all([
    prisma.socialSnapshot.count({ where: { hotelClientId: conn.hotelClientId } }),
    prisma.postSnapshot.count({ where: { hotelClientId: conn.hotelClientId } }),
    prisma.socialSnapshot.findFirst({
      where: { hotelClientId: conn.hotelClientId },
      orderBy: { date: "desc" },
      select: { date: true, followers: true, reach: true, impressions: true, profileViews: true },
    }),
    prisma.postSnapshot.findFirst({
      where: { hotelClientId: conn.hotelClientId },
      orderBy: { fetchedAt: "desc" },
      select: { mediaId: true, mediaType: true, postedAt: true, likes: true, comments: true, reach: true, fetchedAt: true },
    }),
  ]);
  console.log("  SocialSnapshot rows:", socialCount);
  if (latestSocial) console.log("    latest:", JSON.stringify(latestSocial));
  console.log("  PostSnapshot rows:  ", postCount);
  if (latestPost) console.log("    latest:", JSON.stringify(latestPost));

  // Bonus: any recorded SyncFailure for this connection.
  const fails = await prisma.syncFailure.findMany({
    where: { hotelClientId: conn.hotelClientId, tokenType: "instagram" },
    orderBy: { failedAt: "desc" },
    take: 3,
    select: { failedAt: true, reason: true, resolvedAt: true },
  });
  console.log("\n══ Bonus — recorded Instagram SyncFailures ══");
  if (fails.length === 0) console.log("  none");
  for (const f of fails) {
    console.log(`  ${iso(f.failedAt)} resolved=${f.resolvedAt ? "yes" : "NO"} — ${f.reason}`);
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
