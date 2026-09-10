import "./load-env";
import { prisma } from "../lib/prisma";
import { decryptToken } from "../lib/encryption";
import { refreshCampaignPerformance } from "../lib/campaign-attribution";

// One-off / on-demand: backfill campaign-level Meta insights (AdCampaignSnapshot)
// for every hotel with a mapped ad account, then recompute CampaignPerformance.
// The daily cron only re-syncs a trailing window — this fills history after the
// feature ships (or after a gap).
//
//   npx tsx scripts/backfill-campaign-snapshots.ts [days]   # default 90, max 365
//
// Graph access mirrors scripts/verify-meta-data.ts (lib/meta.ts is server-only
// and can't be imported from a script). The token is decrypted via the same
// raw-read path and ONLY ever placed in the Authorization header — never logged.

const GRAPH_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION ?? "v19.0"}`;
const DAY_MS = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

type Action = { action_type?: string; value?: string };
type RawRow = {
  date_start?: string;
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: Action[];
  action_values?: Action[];
};

const PURCHASE = ["offsite_conversion.fb_pixel_purchase", "purchase", "omni_purchase"];
const firstMatch = (actions: Action[] | undefined, types: string[]) => {
  for (const t of types) {
    const hit = actions?.find((a) => a.action_type === t);
    if (hit) return Number(hit.value ?? 0);
  }
  return 0;
};

async function graphGet(path: string, token: string, params: Record<string, string>) {
  const url = new URL(`${GRAPH_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number };
    data?: RawRow[];
    paging?: { cursors?: { after?: string }; next?: string };
  };
  if (json.error) throw new Error(`Graph error ${json.error.code}: ${json.error.message}`);
  return json;
}

async function main() {
  const daysArg = Number(process.argv[2]);
  const days = Number.isFinite(daysArg) ? Math.min(Math.max(Math.trunc(daysArg), 1), 365) : 90;
  const now = new Date();
  const range = {
    since: ymd(new Date(now.getTime() - (days - 1) * DAY_MS)),
    until: ymd(now),
  };
  console.log(`Backfilling campaign insights ${range.since} → ${range.until} (${days} days)\n`);

  const hotels = await prisma.hotelClient.findMany({
    where: { metaAdAccountId: { not: null } },
    select: { id: true, name: true, agencyId: true, metaAdAccountId: true },
  });

  for (const hotel of hotels) {
    const tokenRow = await prisma.metaToken.findFirst({
      where: { agencyId: hotel.agencyId, hotelClientId: hotel.id, status: "connected" },
      select: { id: true },
    });
    if (!tokenRow) {
      console.log(`× ${hotel.name}: no connected Meta token — skipped`);
      continue;
    }
    const raw = await prisma.$queryRawUnsafe<Array<{ ct: string }>>(
      'SELECT "encryptedToken" AS ct FROM "MetaToken" WHERE "id" = $1',
      tokenRow.id,
    );
    const token = decryptToken(raw[0].ct).reveal();
    const act = hotel.metaAdAccountId!.startsWith("act_")
      ? hotel.metaAdAccountId!
      : `act_${hotel.metaAdAccountId}`;

    // Long ranges trip Meta's "reduce the amount of data" limit (error code 1),
    // so fetch in 30-day chunks; each chunk still pages through its rows.
    const rows: RawRow[] = [];
    const CHUNK_DAYS = 30;
    const rangeStart = new Date(`${range.since}T00:00:00.000Z`);
    const rangeEnd = new Date(`${range.until}T00:00:00.000Z`);
    for (
      let chunkStart = rangeStart;
      chunkStart <= rangeEnd;
      chunkStart = new Date(chunkStart.getTime() + CHUNK_DAYS * DAY_MS)
    ) {
      const chunkEnd = new Date(
        Math.min(chunkStart.getTime() + (CHUNK_DAYS - 1) * DAY_MS, rangeEnd.getTime()),
      );
      const chunk = { since: ymd(chunkStart), until: ymd(chunkEnd) };
      let params: Record<string, string> = {
        fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values",
        time_range: JSON.stringify(chunk),
        time_increment: "1",
        level: "campaign",
        limit: "500",
      };
      for (let page = 0; page < 20; page++) {
        const res = await graphGet(`${act}/insights`, token, params);
        rows.push(...(res.data ?? []));
        const after = res.paging?.cursors?.after;
        if (!after || !res.paging?.next) break;
        params = { ...params, after };
      }
      console.log(`  fetched ${chunk.since} → ${chunk.until} (${rows.length} rows so far)`);
    }

    let written = 0;
    for (const row of rows) {
      if (!row.campaign_id || !row.date_start) continue;
      const date = new Date(`${row.date_start}T00:00:00.000Z`);
      const data = {
        campaignName: row.campaign_name ?? row.campaign_id,
        spend: Number(row.spend ?? 0).toFixed(2),
        impressions: Math.round(Number(row.impressions ?? 0)),
        clicks: Math.round(Number(row.clicks ?? 0)),
        conversions: Math.round(firstMatch(row.actions, PURCHASE)),
        purchaseValue: firstMatch(row.action_values, PURCHASE).toFixed(2),
      };
      await prisma.adCampaignSnapshot.upsert({
        where: {
          hotelClientId_metaCampaignId_date: {
            hotelClientId: hotel.id,
            metaCampaignId: row.campaign_id,
            date,
          },
        },
        create: {
          agencyId: hotel.agencyId,
          hotelClientId: hotel.id,
          metaCampaignId: row.campaign_id,
          date,
          ...data,
        },
        update: data,
      });
      written += 1;
    }

    const res = await refreshCampaignPerformance(
      hotel.agencyId,
      hotel.id,
      new Date(`${range.since}T00:00:00.000Z`),
      now,
    );
    console.log(
      `✓ ${hotel.name}: ${written} campaign-day rows from Meta; ` +
        `CampaignPerformance: ${res.rowsWritten} rows ` +
        `(${res.conversionsAttributed} attributed, ${res.conversionsUnattributed} unattributed conversions)`,
    );
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
