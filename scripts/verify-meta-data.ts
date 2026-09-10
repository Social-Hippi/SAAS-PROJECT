import "./load-env";
import { prisma } from "../lib/prisma";
import { decryptToken } from "../lib/encryption";

// Verifies that stored AdSnapshot rows match what Meta's Graph API actually
// returns: decrypts the agency's token (same raw-read path as
// smoke-token-access.ts), pulls the last 7 days of daily insights live, and
// prints them next to the DB rows. Also prints the ad account's name/currency
// so we know what currency the spend figures are denominated in.
//
// SECURITY: the token is only ever placed in the Authorization header and is
// never logged.
//
// Run: npx tsx scripts/verify-meta-data.ts

const GRAPH_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION ?? "v19.0"}`;
const DAY_MS = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function graphGet(path: string, token: string, params: Record<string, string>) {
  const url = new URL(`${GRAPH_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; type?: string; code?: number };
    data?: unknown[];
  };
  if (json.error) {
    throw new Error(`Graph error ${json.error.code}: ${json.error.message}`);
  }
  return json;
}

type Action = { action_type?: string; value?: string };
const firstMatch = (actions: Action[] | undefined, types: string[]) => {
  for (const t of types) {
    const hit = actions?.find((a) => a.action_type === t);
    if (hit) return Number(hit.value ?? 0);
  }
  return 0;
};

async function main() {
  const hotel = await prisma.hotelClient.findFirst({
    where: { metaAdAccountId: { not: null } },
    select: { id: true, name: true, agencyId: true, metaAdAccountId: true, lastSyncedAt: true },
  });
  if (!hotel?.metaAdAccountId) throw new Error("No hotel with a mapped ad account.");
  console.log(`Hotel: ${hotel.name} | acct=${hotel.metaAdAccountId} | lastSyncedAt=${hotel.lastSyncedAt?.toISOString() ?? "never"}`);

  const tokenRow = await prisma.metaToken.findFirst({
    where: { agencyId: hotel.agencyId, hotelClientId: hotel.id },
    select: { id: true, status: true, tokenExpiresAt: true },
  });
  if (!tokenRow) throw new Error("No MetaToken for this hotel.");
  console.log(`Token: status=${tokenRow.status} expires=${tokenRow.tokenExpiresAt?.toISOString() ?? "?"}`);

  const raw = await prisma.$queryRawUnsafe<Array<{ ct: string }>>(
    'SELECT "encryptedToken" AS ct FROM "MetaToken" WHERE "id" = $1',
    tokenRow.id,
  );
  const secret = decryptToken(raw[0].ct);
  const token = secret.reveal();

  const act = hotel.metaAdAccountId.startsWith("act_")
    ? hotel.metaAdAccountId
    : `act_${hotel.metaAdAccountId}`;

  // 1) Account identity + currency.
  const acct = (await graphGet(act, token, {
    fields: "name,account_id,account_status,currency,timezone_name",
  })) as { name?: string; account_id?: string; account_status?: number; currency?: string; timezone_name?: string };
  console.log(`\nLIVE account: name="${acct.name}" id=${acct.account_id} status=${acct.account_status} currency=${acct.currency} tz=${acct.timezone_name}`);

  // 2) Last 7 days of daily insights, live.
  const now = new Date();
  const range = { since: ymd(new Date(now.getTime() - 6 * DAY_MS)), until: ymd(now) };
  const insights = (await graphGet(`${act}/insights`, token, {
    fields: "spend,impressions,reach,clicks,actions,action_values",
    time_range: JSON.stringify(range),
    time_increment: "1",
    level: "account",
    limit: "500",
  })) as { data?: Array<{ date_start?: string; spend?: string; impressions?: string; clicks?: string; actions?: Action[]; action_values?: Action[] }> };

  const PURCHASE = ["offsite_conversion.fb_pixel_purchase", "purchase", "omni_purchase"];
  const live = new Map(
    (insights.data ?? []).map((r) => [
      r.date_start ?? "?",
      {
        spend: Number(r.spend ?? 0),
        impressions: Number(r.impressions ?? 0),
        clicks: Number(r.clicks ?? 0),
        purchases: Math.round(firstMatch(r.actions, PURCHASE)),
        purchaseValue: firstMatch(r.action_values, PURCHASE),
      },
    ]),
  );

  // 3) Same days from the DB.
  const dbRows = await prisma.adSnapshot.findMany({
    where: {
      agencyId: hotel.agencyId,
      hotelClientId: hotel.id,
      date: { gte: new Date(`${range.since}T00:00:00.000Z`) },
    },
    orderBy: { date: "asc" },
    select: { date: true, spend: true, impressions: true, clicks: true, conversions: true },
  });

  console.log(`\nLIVE Meta rows returned: ${live.size} (range ${range.since} → ${range.until})`);
  console.log("date        | LIVE spend/impr/clicks/purch        | DB spend/impr/clicks/conv");
  const allDates = new Set([...live.keys(), ...dbRows.map((r) => ymd(r.date))]);
  for (const d of [...allDates].sort()) {
    const l = live.get(d);
    const db = dbRows.find((r) => ymd(r.date) === d);
    const ls = l ? `${l.spend} / ${l.impressions} / ${l.clicks} / ${l.purchases}` : "— no data —";
    const ds = db ? `${db.spend} / ${db.impressions} / ${db.clicks} / ${db.conversions}` : "— no row —";
    const match = l && db && Math.abs(l.spend - Number(db.spend)) < 0.01 ? "✅" : "❌";
    console.log(`${d} | ${ls.padEnd(36)}| ${ds}  ${match}`);
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
