/**
 * The result of a team-management server action.
 *
 * PURE and separate from lib/hotel-team.ts so the client form can import the
 * type without pulling "server-only" (and the Prisma client, and the mailer)
 * into the browser bundle. Two action modules — one for the agency surface, one
 * for the hotel's own — return this same shape, so one form component drives
 * both without knowing which authorization path it is behind.
 */
export type TeamActionState = {
  ok: boolean;
  /** Shown to the person who submitted. Never contains an id or a raw token. */
  error?: string;
  notice?: string;
};
