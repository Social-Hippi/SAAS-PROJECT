import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma 7 connects through a driver adapter rather than a built-in engine, so
// we pass a node-postgres adapter built from DATABASE_URL.
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

// ── LAYER 4: strip secret columns from every query result ────────────────────
// Defense in depth: the encrypted-secret columns are removed from the result of
// EVERY model query, so a ciphertext can never ride along into an API response,
// a log, or a client prop by accident. The only sanctioned way to read a secret
// is getTokenForApiCall() (lib/token-access.ts), which reads it out of band via
// raw SQL / the security-definer function — both of which bypass this extension.
function scrub<T>(value: T, field: string): T {
  if (Array.isArray(value)) return value.map((v) => scrub(v, field)) as T;
  if (value !== null && typeof value === "object" && field in value) {
    const clone: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    delete clone[field];
    return clone as T;
  }
  return value;
}

function createPrismaClient() {
  return new PrismaClient({ adapter }).$extends({
    name: "strip-secret-columns",
    query: {
      metaToken: {
        async $allOperations({ args, query }) {
          return scrub(await query(args), "encryptedToken");
        },
      },
      instagramConnection: {
        async $allOperations({ args, query }) {
          return scrub(await query(args), "encryptedToken");
        },
      },
      googleAnalyticsConnection: {
        async $allOperations({ args, query }) {
          return scrub(await query(args), "encryptedCredentials");
        },
      },
      ga4Connection: {
        async $allOperations({ args, query }) {
          // Two ciphertext columns on this model — strip both.
          return scrub(scrub(await query(args), "accessToken"), "refreshToken");
        },
      },
      googleAdsConnection: {
        async $allOperations({ args, query }) {
          // Two ciphertext columns on this model — strip both (like Ga4Connection).
          return scrub(scrub(await query(args), "accessToken"), "refreshToken");
        },
      },
    },
  });
}

// Reuse a single client across hot reloads in development to avoid exhausting
// the connection pool. In production a fresh client is created per server.
const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
