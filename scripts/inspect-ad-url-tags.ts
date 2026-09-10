import "./load-env";
import { prisma } from "../lib/prisma";
import { decryptToken } from "../lib/encryption";

// READ-ONLY: check (1) whether the stored Meta token has ads_management (write)
// or only ads_read, and (2) what url_tags the account's active ads currently
// carry. Changes nothing. Token is only ever sent in the Authorization header.

const GRAPH_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION ?? "v19.0"}`;

async function graphGet(path: string, token: string, params: Record<string, string>) {
  const url = new URL(`${GRAPH_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: { message?: string; code?: number };
  };
  if (json.error) throw new Error(`Graph error ${json.error.code}: ${json.error.message}`);
  return json;
}

async function main() {
  const hotel = await prisma.hotelClient.findFirst({
    where: { metaAdAccountId: { not: null } },
    select: { id: true, agencyId: true, metaAdAccountId: true, name: true },
  });
  if (!hotel) throw new Error("No hotel with ad account.");
  const tokenRow = await prisma.metaToken.findFirst({
    where: { agencyId: hotel.agencyId, hotelClientId: hotel.id, status: "connected" },
    select: { id: true },
  });
  if (!tokenRow) throw new Error("No connected token.");
  const raw = await prisma.$queryRawUnsafe<Array<{ ct: string }>>(
    'SELECT "encryptedToken" AS ct FROM "MetaToken" WHERE "id" = $1',
    tokenRow.id,
  );
  const token = decryptToken(raw[0].ct).reveal();

  // 1) Token scopes.
  const debug = (await graphGet("debug_token", token, { input_token: token })) as {
    data?: { scopes?: string[] };
  };
  const scopes = debug.data?.scopes ?? [];
  console.log("Token scopes:", scopes.join(", "));
  console.log("Has ads_management (can WRITE ads):", scopes.includes("ads_management"));

  // 2) Active ads + their current URL tags (sample up to 50).
  const act = hotel.metaAdAccountId!;
  const ads = (await graphGet(`${act}/ads`, token, {
    fields:
      "id,name,status,effective_status,campaign{name},creative{id,url_tags}",
    limit: "50",
    filtering: JSON.stringify([
      { field: "effective_status", operator: "IN", value: ["ACTIVE"] },
    ]),
  })) as {
    data?: Array<{
      id: string;
      name?: string;
      effective_status?: string;
      campaign?: { name?: string };
      creative?: { id?: string; url_tags?: string };
    }>;
    paging?: { next?: string };
  };

  const list = ads.data ?? [];
  console.log(`\nACTIVE ads (first ${list.length}${ads.paging?.next ? "+, more pages exist" : ""}):`);
  let withTags = 0;
  let withUtmCampaign = 0;
  for (const ad of list) {
    const tags = ad.creative?.url_tags ?? "";
    if (tags) withTags++;
    if (/utm_campaign=/i.test(tags)) withUtmCampaign++;
    console.log(
      `  [${ad.campaign?.name ?? "?"}] ${ad.name ?? ad.id}\n    url_tags: ${tags || "(none)"}`,
    );
  }
  console.log(
    `\nSummary: ${list.length} active ads sampled — ${withTags} have url_tags, ${withUtmCampaign} already include utm_campaign.`,
  );
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
