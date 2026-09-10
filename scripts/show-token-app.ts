import "./load-env";
import { prisma } from "../lib/prisma";
import { decryptToken } from "../lib/encryption";

// READ-ONLY: print which Meta app the stored EAA token belongs to (debug_token
// returns app id + name). Token only ever goes in the Authorization header.

const GRAPH_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION ?? "v19.0"}`;

async function main() {
  const tokenRow = await prisma.metaToken.findFirst({
    where: { status: "connected" },
    select: { id: true },
  });
  if (!tokenRow) throw new Error("No connected token.");
  const raw = await prisma.$queryRawUnsafe<Array<{ ct: string }>>(
    'SELECT "encryptedToken" AS ct FROM "MetaToken" WHERE "id" = $1',
    tokenRow.id,
  );
  const token = decryptToken(raw[0].ct).reveal();

  const url = new URL(`${GRAPH_BASE}/debug_token`);
  url.searchParams.set("input_token", token);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json()) as {
    data?: { app_id?: string; application?: string; type?: string; expires_at?: number };
    error?: { message?: string };
  };
  if (json.error) throw new Error(json.error.message);
  console.log("App name:", json.data?.application);
  console.log("App id:  ", json.data?.app_id);
  console.log("Token type:", json.data?.type);
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
