import "server-only";

import { prisma } from "@/lib/prisma";
import { agencyScoped } from "@/lib/tenant";
import { ok, notTraceable, ratio, type MetricValue } from "@/lib/metrics/metric-value";

// Instagram performance broken down by CONTENT TYPE.
//
// The existing social section answers "how is the account doing"; this answers
// the question a hotel actually acts on — "should we make more reels or more
// carousels?" — by putting the formats side by side on the same measures.
//
// ADAPTIVE, because the Instagram API is. lib/instagram.ts already drops metrics
// a Graph version rejects (impressions became views; engagement became
// total_interactions), so a column is included ONLY when at least one row can
// populate it. Nothing here is invented to fill a table:
//
//   • Reach, likes, comments, saves, shares, engagement — per-post, real.
//   • Impressions — often absent on v22+; the column disappears when it is.
//   • Profile visits and link clicks — ACCOUNT-level only. Instagram does not
//     attribute either to an individual post, so they are deliberately absent
//     from a per-content table rather than being split by some invented share.
//   • DMs — not exposed at all (see lib/metrics/intent.ts).

export type SocialContentRow = {
  type: string;
  label: string;
  posts: MetricValue<number>;
  reach: MetricValue<number>;
  impressions: MetricValue<number>;
  likes: MetricValue<number>;
  comments: MetricValue<number>;
  saves: MetricValue<number>;
  shares: MetricValue<number>;
  engagementRate: MetricValue<number>;
};

export type SocialPerformance = {
  connected: boolean;
  rows: SocialContentRow[];
  /** Columns worth rendering — the API does not always supply impressions. */
  hasImpressions: boolean;
  stories: SocialContentRow | null;
};

const TYPE_LABEL: Record<string, string> = {
  IMAGE: "Image",
  VIDEO: "Video",
  REELS: "Reel",
  CAROUSEL_ALBUM: "Carousel",
  STORY: "Story",
};

function labelFor(t: string): string {
  return TYPE_LABEL[t.toUpperCase()] ?? t;
}

export async function loadSocialPerformance(
  hotelClientId: string,
  range: { since: Date; until: Date },
): Promise<SocialPerformance> {
  const [connection, posts, stories] = await Promise.all([
    agencyScoped(prisma.instagramConnection).findFirst({
      where: { hotelClientId, tokenType: "igaa_direct" },
      select: { status: true },
    }),
    agencyScoped(prisma.postSnapshot).findMany({
      where: { hotelClientId, postedAt: { gte: range.since, lte: range.until } },
      select: {
        mediaType: true, reach: true, impressions: true, likes: true,
        comments: true, saves: true, shares: true, engagement: true,
      },
    }),
    agencyScoped(prisma.storySnapshot).findMany({
      where: { hotelClientId, postedAt: { gte: range.since, lte: range.until } },
      select: { reach: true, impressions: true, replies: true },
    }),
  ]);

  const byType = new Map<
    string,
    { posts: number; reach: number; impressions: number; likes: number; comments: number; saves: number; shares: number; engagement: number }
  >();
  let anyImpressions = false;

  for (const p of posts) {
    const key = (p.mediaType ?? "OTHER").toUpperCase();
    const e = byType.get(key) ?? {
      posts: 0, reach: 0, impressions: 0, likes: 0, comments: 0, saves: 0, shares: 0, engagement: 0,
    };
    e.posts += 1;
    e.reach += p.reach;
    e.impressions += p.impressions;
    e.likes += p.likes;
    e.comments += p.comments;
    e.saves += p.saves;
    e.shares += p.shares;
    e.engagement += p.engagement;
    if (p.impressions > 0) anyImpressions = true;
    byType.set(key, e);
  }

  const rows: SocialContentRow[] = [...byType.entries()]
    .map(([type, e]) => ({
      type,
      label: labelFor(type),
      posts: ok(e.posts),
      reach: ok(e.reach),
      // A zero here means "this Graph version stopped returning it", which is a
      // gap rather than a measurement — so it is only ever a number when some
      // row in the window actually carried one.
      impressions: anyImpressions
        ? ok(e.impressions)
        : notTraceable("Instagram no longer reports impressions for this account."),
      likes: ok(e.likes),
      comments: ok(e.comments),
      saves: ok(e.saves),
      shares: ok(e.shares),
      engagementRate: ratio(ok(e.engagement), ok(e.reach), {
        zeroDenominatorReason: "These posts recorded no reach in this period.",
      }),
    }))
    .sort((a, b) => (b.reach.state === "ok" ? b.reach.value : 0) - (a.reach.state === "ok" ? a.reach.value : 0));

  const storyRow: SocialContentRow | null =
    stories.length === 0
      ? null
      : {
          type: "STORY",
          label: "Story",
          posts: ok(stories.length),
          reach: ok(stories.reduce((s, x) => s + x.reach, 0)),
          impressions: ok(stories.reduce((s, x) => s + x.impressions, 0)),
          // Instagram exposes none of these for stories; replies are the only
          // interaction, and they are not likes.
          likes: notTraceable("Instagram doesn't report likes on stories."),
          comments: ok(stories.reduce((s, x) => s + x.replies, 0)),
          saves: notTraceable("Instagram doesn't report saves on stories."),
          shares: notTraceable("Instagram doesn't report shares on stories."),
          engagementRate: notTraceable(
            "Stories don't carry the interaction counts an engagement rate needs.",
          ),
        };

  return {
    connected: Boolean(connection),
    rows,
    hasImpressions: anyImpressions,
    stories: storyRow,
  };
}
