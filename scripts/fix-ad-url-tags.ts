import "./load-env";
import { prisma } from "../lib/prisma";
import { decryptToken } from "../lib/encryption";

// Fixes active ads whose url_tags are missing or don't carry
// utm_campaign={{campaign.name}} (so HotelTrack's campaign attribution can
// match their clicks). Meta creatives are immutable, so for each ad we:
//   1. create a NEW creative referencing the SAME post (effective_object_story_id
//      — keeps the post's likes/comments) with corrected url_tags, then
//   2. point the ad at the new creative (the ad re-enters Meta review briefly).
//
//   npx tsx scripts/fix-ad-url-tags.ts            # dry run: list what would change
//   npx tsx scripts/fix-ad-url-tags.ts canary     # fix ONE simple ad, then verify
//   npx tsx scripts/fix-ad-url-tags.ts all        # fix everything non-conforming
//
// Catalog/dynamic ads (object_story_spec with template_data) are recreated from
// their full spec; if Meta rejects the copy, the ad is reported for manual fix.
// Token is only ever sent in the Authorization header. Run authorized by the
// account owner (agency) on 2026-06-06.

const GRAPH_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION ?? "v19.0"}`;
const WANT = "utm_campaign={{campaign.name}}";

type GraphErr = { error?: { message?: string; code?: number; error_user_msg?: string } };

async function graphGet<T>(path: string, token: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${GRAPH_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as T & GraphErr;
  if (json.error) throw new Error(`Graph ${json.error.code}: ${json.error.error_user_msg ?? json.error.message}`);
  return json;
}

async function graphPost<T>(path: string, token: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${GRAPH_BASE}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & GraphErr;
  if (json.error) throw new Error(`Graph ${json.error.code}: ${json.error.error_user_msg ?? json.error.message}`);
  return json;
}

type AdRow = {
  id: string;
  name?: string;
  effective_status?: string;
  campaign?: { name?: string };
  creative?: {
    id?: string;
    url_tags?: string;
    effective_object_story_id?: string;
    object_story_spec?: Record<string, unknown>;
    product_set_id?: string;
  };
};

/** Corrected tags: keep the ad's existing utm_source value, standard otherwise. */
function fixedTags(existing: string | undefined): string {
  const m = existing?.match(/utm_source=([^&]+)/);
  const source = m ? m[1] : "NS_Meta";
  return `utm_source=${source}&utm_medium={{adset.name}}&${WANT}&utm_content={{ad.name}}`;
}

async function main() {
  const mode = process.argv[2] ?? "dry";
  const hotel = await prisma.hotelClient.findFirst({
    where: { metaAdAccountId: { not: null } },
    select: { id: true, agencyId: true, metaAdAccountId: true },
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
  const act = hotel.metaAdAccountId!;

  // ── Inventory ALL active ads (follow pagination) ──
  const ads: AdRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await graphGet<{ data?: AdRow[]; paging?: { cursors?: { after?: string }; next?: string } }>(
      `${act}/ads`,
      token,
      {
        fields:
          "id,name,effective_status,campaign{name},creative{id,url_tags,effective_object_story_id,object_story_spec,product_set_id}",
        limit: "100",
        filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
        ...(after ? { after } : {}),
      },
    );
    ads.push(...(res.data ?? []));
    after = res.paging?.cursors?.after;
    if (!after || !res.paging?.next) break;
  }

  const broken = ads.filter((a) => !(a.creative?.url_tags ?? "").includes(WANT));
  console.log(`Active ads: ${ads.length}; non-conforming: ${broken.length}\n`);
  for (const ad of broken) {
    const isCatalog = !ad.creative?.effective_object_story_id && !!ad.creative?.object_story_spec;
    console.log(
      `  [${ad.campaign?.name}] ${ad.name} (${ad.id})${isCatalog ? " [catalog/spec]" : ""}\n` +
        `    current: ${ad.creative?.url_tags || "(none)"}\n` +
        `    fixed:   ${fixedTags(ad.creative?.url_tags)}`,
    );
  }
  if (mode === "dry") {
    console.log("\nDry run — nothing changed. Rerun with 'canary' or 'all'.");
    return;
  }

  // Fetch each broken ad's creative FULLY (the ads-edge expansion omits
  // product_set_id and parts of the spec on dynamic creatives).
  type FullCreative = {
    id: string;
    url_tags?: string;
    effective_object_story_id?: string;
    object_story_spec?: Record<string, unknown> & { template_data?: unknown };
    asset_feed_spec?: Record<string, unknown>;
    product_set_id?: string;
    instagram_user_id?: string;
  };
  const fullCreatives = new Map<string, FullCreative>();
  for (const ad of broken) {
    if (!ad.creative?.id || fullCreatives.has(ad.creative.id)) continue;
    fullCreatives.set(
      ad.creative.id,
      await graphGet<FullCreative>(ad.creative.id, token, {
        fields:
          "id,url_tags,effective_object_story_id,object_story_spec,asset_feed_spec,product_set_id,instagram_user_id",
      }),
    );
  }
  const isDynamic = (c: FullCreative | undefined) =>
    !!c?.product_set_id || !!c?.object_story_spec?.template_data;

  // Canary = first PLAIN post ad (simplest, lowest risk).
  const targets =
    mode === "canary"
      ? broken
          .filter((a) => {
            const c = a.creative?.id ? fullCreatives.get(a.creative.id) : undefined;
            return !!c?.effective_object_story_id && !isDynamic(c) && !c?.asset_feed_spec;
          })
          .slice(0, 1)
      : broken;
  if (targets.length === 0) {
    console.log("Nothing to fix in this mode.");
    return;
  }

  // Ads sharing a creative reuse one replacement (create once per old creative id).
  const replacement = new Map<string, string>(); // old creative id -> new creative id
  let fixed = 0;
  const failures: string[] = [];

  for (const ad of targets) {
    const cre = ad.creative?.id ? fullCreatives.get(ad.creative.id) : undefined;
    const tags = fixedTags(cre?.url_tags ?? ad.creative?.url_tags);
    try {
      if (!cre) throw new Error("could not load full creative");
      let newId = replacement.get(cre.id);
      if (!newId) {
        const body: Record<string, unknown> = {
          name: `HT-tagfix ${ad.name ?? ad.id}`.slice(0, 90),
          url_tags: tags,
        };
        if (isDynamic(cre)) {
          // Catalog/dynamic ad: recreate from the full story spec + product set.
          if (!cre.object_story_spec) throw new Error("dynamic creative without object_story_spec");
          body.object_story_spec = cre.object_story_spec;
          if (cre.product_set_id) body.product_set_id = cre.product_set_id;
        } else if (cre.asset_feed_spec) {
          // Dynamic-creative (DCO) ad: copy the asset feed + story spec shell.
          body.asset_feed_spec = cre.asset_feed_spec;
          if (cre.object_story_spec) body.object_story_spec = cre.object_story_spec;
        } else if (cre.effective_object_story_id) {
          // Post-based ad: reference the same post — engagement is preserved.
          body.object_story_id = cre.effective_object_story_id;
        } else {
          throw new Error("creative has neither story id nor story spec");
        }
        if (cre.instagram_user_id) body.instagram_user_id = cre.instagram_user_id;
        const created = await graphPost<{ id: string }>(`${act}/adcreatives`, token, body);
        newId = created.id;
        replacement.set(cre.id, newId);
      }
      await graphPost(`${ad.id}`, token, { creative: { creative_id: newId } });

      // Verify by reading back.
      const check = await graphGet<{ creative?: { url_tags?: string } }>(ad.id, token, {
        fields: "creative{url_tags}",
      });
      const now = check.creative?.url_tags ?? "";
      const ok = now.includes(WANT);
      console.log(`${ok ? "✅" : "❌"} ${ad.name}: url_tags now "${now}"`);
      if (ok) fixed += 1;
      else failures.push(`${ad.name}: readback mismatch`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`❌ ${ad.name}: ${msg}`);
      failures.push(`${ad.name}: ${msg}`);
    }
  }

  console.log(`\nDone: ${fixed}/${targets.length} fixed.`);
  if (failures.length) {
    console.log("Failed (fix manually in Ads Manager):");
    for (const f of failures) console.log(`  - ${f}`);
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
