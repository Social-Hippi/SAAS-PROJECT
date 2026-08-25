"use server";

import { revalidatePath } from "next/cache";
import { getCurrentMember } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { agencyScoped, agencyScopedFor } from "@/lib/tenant";
import { buildUtmLink, normalizeUrl } from "@/lib/utm";

// Allowed values mirror the Prisma enums (ContentType / Platform). Kept as
// local string tuples — same pattern as the hotel action — so we validate
// untrusted form input before it ever reaches the database.
const CONTENT_TYPES = ["organic", "paid_ad", "influencer", "story"] as const;
type ContentTypeValue = (typeof CONTENT_TYPES)[number];
const PLATFORMS = ["instagram", "facebook", "youtube"] as const;
type PlatformValue = (typeof PLATFORMS)[number];

export type CreateContentState = {
  error: string | null;
  result: { id: string; title: string; utmLink: string } | null;
};

export async function createContentPiece(
  _prev: CreateContentState,
  formData: FormData,
): Promise<CreateContentState> {
  const fail = (error: string): CreateContentState => ({ error, result: null });

  const member = await getCurrentMember();
  if (!member) return fail("Your session has expired — please sign in again.");

  const get = (k: string) => ((formData.get(k) as string | null) ?? "").trim();
  const hotelClientId = get("hotelClientId");
  const title = get("title");
  const contentType = get("contentType");
  const platform = get("platform");
  const influencerName = get("influencerName");
  // Track A: the DETERMINISTIC influencer link. Optional so existing callers and
  // non-influencer content keep working; when supplied it is verified to belong
  // to this agency before it is stored.
  const influencerId = get("influencerId");
  const couponCode = get("couponCode");

  if (!hotelClientId) return fail("Please choose a hotel client.");
  if (!title) return fail("Please enter a title.");
  if (!CONTENT_TYPES.includes(contentType as ContentTypeValue)) {
    return fail("Please choose a content type.");
  }
  if (!PLATFORMS.includes(platform as PlatformValue)) {
    return fail("Please choose a platform.");
  }

  const destinationUrl = normalizeUrl(get("destinationUrl"));
  if (!destinationUrl) {
    return fail("Enter a valid destination URL (e.g. https://hotel.com/rooms).");
  }

  const isInfluencer = contentType === "influencer";
  // A picked influencer supplies the name itself, so only demand the typed name
  // when there is no registered influencer behind the piece.
  if (isInfluencer && !influencerId && !influencerName) {
    return fail("Influencer content needs an influencer name.");
  }
  if (isInfluencer && !couponCode) {
    return fail("Influencer content needs a coupon code.");
  }

  // Multi-tenant guard: never trust the submitted hotelClientId. Confirm the
  // hotel belongs to THIS agency before attaching content to it.
  const hotel = await agencyScoped(prisma.hotelClient).findFirst({
    where: { id: hotelClientId },
    select: { id: true },
  });
  if (!hotel) return fail("That hotel client wasn't found for your agency.");

  // Multi-tenant guard, same shape as the hotel check above: never trust a
  // submitted influencerId. An id from another agency resolves to nothing and is
  // rejected rather than silently stored.
  let linkedInfluencerId: string | null = null;
  let linkedInfluencerName: string | null = null;
  if (influencerId) {
    const influencer = await agencyScoped(prisma.influencer).findFirst({
      where: { id: influencerId },
      select: { id: true, name: true, hotelClientId: true },
    });
    if (!influencer) return fail("That influencer wasn't found for your agency.");
    // An influencer tied to one hotel must not be attached to another's content.
    if (influencer.hotelClientId && influencer.hotelClientId !== hotel.id) {
      return fail("That influencer belongs to a different hotel client.");
    }
    linkedInfluencerId = influencer.id;
    // Store the influencer's own name, not the submitted string, so the label
    // can never drift from the row it points at.
    linkedInfluencerName = influencer.name;
  }

  // The link's utm_content is `ht-<contentPieceId>`, so we need the id before we
  // can build the link. Create the row, build the link from its id, then write
  // the link back — wrapped in a transaction so a row never lingers without one.
  const piece = await prisma.$transaction(async (tx) => {
    // agencyScopedFor stamps/filters agencyId on the transaction's delegate.
    const txContent = agencyScopedFor(member.agencyId, tx.contentPiece);
    const created = await txContent.create({
      data: {
        agencyId: member.agencyId,
        hotelClientId: hotel.id,
        title,
        contentType: contentType as ContentTypeValue,
        platform: platform as PlatformValue,
        destinationUrl,
        utmLink: "", // populated immediately below, once the id exists
        influencerName: isInfluencer ? (linkedInfluencerName ?? influencerName) : null,
        influencerId: linkedInfluencerId,
        couponCode: isInfluencer ? couponCode : null,
      },
      select: { id: true, title: true },
    });

    const utmLink = buildUtmLink({
      destinationUrl,
      source: platform,
      medium: contentType,
      title,
      contentPieceId: created.id,
      agencyId: member.agencyId,
    });

    await txContent.update({
      where: { id: created.id },
      data: { utmLink },
    });

    return { id: created.id, title: created.title, utmLink };
  });

  revalidatePath("/agency/content");
  return { error: null, result: piece };
}
