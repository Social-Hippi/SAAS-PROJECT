"use server";

import type { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { saltedHash } from "@/lib/pii";

// Customer Journey Lookup (Part 6) — the "VIP customer view". An agency searches
// by name or (client-hashed) email/phone and gets a specific visitor's COMPLETE
// history with the hotel: every session, page, click, and form interaction.
//
// PRIVACY: the raw email/phone NEVER reaches the server — the client hashes it
// (lib/pii-client) and sends the hash; we apply the salted server layer
// (lib/pii) and match VisitorIdentity.emailHash/phoneHash. Names are less
// sensitive and matched directly (case-insensitive, agency-scoped).
//
// Every query is agencyScoped AND hotelClientId-filtered — no cross-tenant leak.

export type LookupQuery = {
  emailHash?: string; // client-side SHA-256 hex
  phoneHash?: string; // client-side SHA-256 hex
  name?: string;
};

export type LookupSession = {
  id: string;
  startedAtISO: string;
  durationMs: number;
  pageViewCount: number;
  landingPath: string;
  exitPath: string | null;
  converted: boolean;
  pages: { pagePath: string; enteredAt: string; timeOnPageMs: number | null; exitReason: string | null }[];
  clicks: { clickTarget: string; pagePath: string; occurredAt: string }[];
  forms: { fieldName: string; action: string; hasValue: boolean | null; occurredAt: string }[];
};

export type LookupResult = {
  found: boolean;
  matchCount: number; // how many distinct visitors matched (we show the first)
  name: string | null;
  customerId: string | null;
  visitorId: string | null;
  sessionCount: number;
  sessions: LookupSession[];
};

const EMPTY: LookupResult = {
  found: false,
  matchCount: 0,
  name: null,
  customerId: null,
  visitorId: null,
  sessionCount: 0,
  sessions: [],
};

const MAX_SESSIONS = 50;

export async function lookupVisitorJourneys(
  hotelId: string,
  query: LookupQuery,
): Promise<LookupResult> {
  // ADMIN-only: this returns a specific visitor's complete session/page/click/form
  // history (customer-level PII). Enforced server-side here, not just in the UI —
  // a non-admin (analyst) gets the empty result and never reaches the data below.
  const admin = await requireAdmin();
  if (!admin) return EMPTY;

  // Ownership: the hotel must belong to the caller's agency (scoped findFirst).
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelId },
    select: { id: true },
  });
  if (!hotel) return EMPTY;

  // Build the identity match from exactly one provided key.
  const emailHash = query.emailHash ? saltedHash(query.emailHash) : null;
  const phoneHash = query.phoneHash ? saltedHash(query.phoneHash) : null;
  const name = query.name?.trim();

  const identityWhere: Prisma.VisitorIdentityWhereInput = { hotelClientId: hotelId };
  if (emailHash) identityWhere.emailHash = emailHash;
  else if (phoneHash) identityWhere.phoneHash = phoneHash;
  else if (name) identityWhere.name = { contains: name, mode: "insensitive" };
  else return EMPTY;

  const identities = await agencyScoped(prisma.visitorIdentity).findMany({
    where: identityWhere,
    orderBy: { identifiedAt: "desc" },
    take: 10,
    select: { visitorId: true, name: true, customerId: true },
  });
  if (identities.length === 0) return EMPTY;

  // Show the most recently identified match (note the count so the UI can hint
  // if several people share a name).
  const primary = identities[0];
  const visitorId = primary.visitorId;

  const sessions = await agencyScoped(prisma.session).findMany({
    where: { hotelClientId: hotelId, visitorId },
    orderBy: { startedAt: "desc" },
    take: MAX_SESSIONS,
    select: {
      id: true,
      startedAt: true,
      totalTimeMs: true,
      pageViewCount: true,
      landingPath: true,
      exitPath: true,
    },
  });
  const sessionIds = sessions.map((s) => s.id);

  if (sessionIds.length === 0) {
    return {
      found: true,
      matchCount: identities.length,
      name: primary.name,
      customerId: primary.customerId,
      visitorId,
      sessionCount: 0,
      sessions: [],
    };
  }

  const [pageRows, clickRows, formRows, convRows] = await Promise.all([
    agencyScoped(prisma.pageView).findMany({
      where: { hotelClientId: hotelId, sessionId: { in: sessionIds } },
      orderBy: { enteredAt: "asc" },
      select: { sessionId: true, pagePath: true, enteredAt: true, timeOnPageMs: true, exitReason: true },
    }),
    agencyScoped(prisma.clickEvent).findMany({
      where: { hotelClientId: hotelId, sessionId: { in: sessionIds } },
      orderBy: { occurredAt: "asc" },
      select: { sessionId: true, clickTarget: true, pagePath: true, occurredAt: true },
    }),
    agencyScoped(prisma.formFieldEvent).findMany({
      where: { hotelClientId: hotelId, sessionId: { in: sessionIds } },
      orderBy: { occurredAt: "asc" },
      select: { sessionId: true, fieldName: true, action: true, hasValue: true, occurredAt: true },
    }),
    agencyScoped(prisma.trackingEvent).findMany({
      where: { hotelClientId: hotelId, eventType: "conversion", sessionId: { in: sessionIds } },
      select: { sessionId: true },
    }),
  ]);

  const convertedIds = new Set(convRows.map((c) => c.sessionId));
  const pagesBy = new Map<string, LookupSession["pages"]>();
  for (const p of pageRows) {
    (pagesBy.get(p.sessionId) ?? pagesBy.set(p.sessionId, []).get(p.sessionId)!).push({
      pagePath: p.pagePath,
      enteredAt: p.enteredAt.toISOString(),
      timeOnPageMs: p.timeOnPageMs,
      exitReason: p.exitReason,
    });
  }
  const clicksBy = new Map<string, LookupSession["clicks"]>();
  for (const c of clickRows) {
    (clicksBy.get(c.sessionId) ?? clicksBy.set(c.sessionId, []).get(c.sessionId)!).push({
      clickTarget: c.clickTarget,
      pagePath: c.pagePath,
      occurredAt: c.occurredAt.toISOString(),
    });
  }
  const formsBy = new Map<string, LookupSession["forms"]>();
  for (const f of formRows) {
    (formsBy.get(f.sessionId) ?? formsBy.set(f.sessionId, []).get(f.sessionId)!).push({
      fieldName: f.fieldName,
      action: f.action,
      hasValue: f.hasValue,
      occurredAt: f.occurredAt.toISOString(),
    });
  }

  return {
    found: true,
    matchCount: identities.length,
    name: primary.name,
    customerId: primary.customerId,
    visitorId,
    sessionCount: sessions.length,
    sessions: sessions.map((s) => ({
      id: s.id,
      startedAtISO: s.startedAt.toISOString(),
      durationMs: s.totalTimeMs,
      pageViewCount: s.pageViewCount,
      landingPath: s.landingPath,
      exitPath: s.exitPath,
      converted: convertedIds.has(s.id),
      pages: pagesBy.get(s.id) ?? [],
      clicks: clicksBy.get(s.id) ?? [],
      forms: formsBy.get(s.id) ?? [],
    })),
  };
}
