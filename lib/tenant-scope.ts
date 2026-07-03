import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Pure agency-scoping logic — NO session, NO Clerk, NO "server-only".
//
// Kept separate from lib/tenant.ts so it can be imported by the isolation tests
// and smoke scripts (which run under plain Node/tsx/vitest, where "server-only"
// throws). lib/tenant.ts re-exports the public bits, so app code imports from
// "@/lib/tenant" as usual.
//
// The `Agency` model is the tenant ROOT — it has no agencyId column, so it is
// scoped by its own `id`. Everything else is scoped by `agencyId`.
// ─────────────────────────────────────────────────────────────────────────────

function scopeKeyFor(model: unknown): "id" | "agencyId" {
  return model === prisma.agency ? "id" : "agencyId";
}

// Read operations that should default to active (non-soft-deleted) hotels only.
// Writes (update/delete/upsert/create) are intentionally excluded so the
// soft-delete and restore paths can still target deleted rows.
const HOTEL_READ_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

// For HotelClient reads, default-exclude soft-deleted rows (deletedAt: null)
// unless the caller passes { includeDeleted: true } or already constrains
// deletedAt themselves. The flag is stripped before the args reach Prisma.
function withSoftDeleteFilter(prop: string, args: AnyArgs): AnyArgs {
  if (!HOTEL_READ_OPS.has(prop)) return args;
  const { includeDeleted, ...rest } = args as AnyArgs & { includeDeleted?: boolean };
  if (includeDeleted) return rest;
  const where = (rest.where ?? {}) as Record<string, unknown>;
  if ("deletedAt" in where) return rest;
  return { ...rest, where: { ...where, deletedAt: null } };
}

type AnyArgs = Record<string, unknown> & {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Record<string, unknown>[];
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
};

function withScopedWhere(args: AnyArgs, key: string, agencyId: string): AnyArgs {
  return { ...args, where: { ...(args.where ?? {}), [key]: agencyId } };
}

function withScopedData(args: AnyArgs, key: string, agencyId: string): AnyArgs {
  // Agency (key === "id") is never created/updated through the scoped wrapper.
  if (key === "id") return args;
  const data = args.data;
  if (Array.isArray(data)) {
    return { ...args, data: data.map((d) => ({ ...d, [key]: agencyId })) };
  }
  return { ...args, data: { ...(data ?? {}), [key]: agencyId } };
}

function withScopedUpsert(args: AnyArgs, key: string, agencyId: string): AnyArgs {
  if (key === "id") return args;
  return {
    ...args,
    // NOTE: upsert's `where` must be a tenant-SAFE unique key (e.g. a column that
    // is unique per hotel, where the hotel was already ownership-checked). We
    // cannot add agencyId to a unique where, so we stamp it onto the written rows.
    create: { ...(args.create ?? {}), [key]: agencyId },
    update: { ...(args.update ?? {}), [key]: agencyId },
  };
}

/**
 * Wrap a Prisma model delegate so every call is filtered/stamped by `agencyId`.
 * Use this when you already hold the agencyId (a shared lib that received it as
 * a param, the public /share pages that resolved it from a token, or inside an
 * interactive `$transaction((tx) => …)` on `tx.model`).
 *
 * Injection rules per method:
 *   findMany / findFirst(/OrThrow) / count / aggregate / groupBy / update /
 *   updateMany / delete / deleteMany  → merge { agencyId } into `where`
 *   findUnique / findUniqueOrThrow     → rerouted to findFirst(/OrThrow) so the
 *                                        non-unique agencyId can be added safely
 *   create                             → merge { agencyId } into `data`
 *   createMany                         → merge { agencyId } into each `data` item
 *   upsert                             → merge { agencyId } into `create`+`update`
 *
 * For `update`/`delete`, Prisma applies the extra non-unique `agencyId` as an
 * additional filter: a cross-tenant id throws P2025 (record not found) instead
 * of mutating another agency's row. (Verified — see scripts/smoke-tenant.ts.)
 */
export function agencyScopedFor<D>(agencyId: string, model: D): D {
  const key = scopeKeyFor(model);
  const isHotelClient = model === prisma.hotelClient;
  const target = model as Record<string, unknown>;

  return new Proxy(target, {
    get(t, prop: string) {
      const orig = t[prop];
      if (typeof orig !== "function") return orig;
      const fn = orig as (args?: unknown) => unknown;

      return (rawArgs: AnyArgs = {}) => {
        // HotelClient reads default to active hotels only (soft-delete aware).
        const args = isHotelClient ? withSoftDeleteFilter(prop, rawArgs) : rawArgs;
        switch (prop) {
          // Unique lookups can't carry a non-unique filter — reroute to findFirst.
          case "findUnique":
            return (t.findFirst as typeof fn)(withScopedWhere(args, key, agencyId));
          case "findUniqueOrThrow":
            return (t.findFirstOrThrow as typeof fn)(
              withScopedWhere(args, key, agencyId),
            );
          case "findFirst":
          case "findFirstOrThrow":
          case "findMany":
          case "count":
          case "aggregate":
          case "groupBy":
          case "update":
          case "updateMany":
          case "delete":
          case "deleteMany":
            return fn.call(t, withScopedWhere(args, key, agencyId));
          case "create":
          case "createMany":
            return fn.call(t, withScopedData(args, key, agencyId));
          case "upsert":
            return fn.call(t, withScopedUpsert(args, key, agencyId));
          default:
            return fn.call(t, args);
        }
      };
    },
  }) as D;
}

// The full list of multi-tenant models (every table with an agencyId column).
// `agency` itself is the tenant root (scoped by id) and is intentionally absent.
// Single source of truth for the isolation tests and MULTITENANCY.md.
export const MULTI_TENANT_MODELS = [
  "agencyMember",
  "hotelClient",
  "contentPiece",
  "trackingEvent",
  "touchpoint",
  "session",
  "pageView",
  "stageReached",
  "metaToken",
  "adSnapshot",
  "couponRedemption",
  "report",
  "alert",
  "shareLink",
  "instagramConnection",
  "socialSnapshot",
  "postSnapshot",
  "storySnapshot",
  "instagramAudience",
  "googleAnalyticsConnection",
  "gaSnapshot",
  "gaSourceBreakdown",
  "tokenAuditLog",
  "backfillJob",
  "backfillLog",
  "syncFailure",
  "guideDownload",
  "hotelShareAccess",
  "budgetAlert",
  "ga4Connection",
  "ga4Snapshot",
  "googleAdsConnection",
  "googleAdsCampaignSnapshot",
  "clickEvent",
  "formFieldEvent",
  "visitorIdentity",
  "influencer",
  "couponCode",
  "influencerRedemption",
  "hotelInvite",
  "influencerInstagramPost",
  "unattributedMention",
] as const;
