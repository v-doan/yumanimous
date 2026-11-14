import { z } from 'zod';
import { CardSchema } from './card.js';
import { ShoppingListSchema, SuggestionSchema } from './followUps.js';
import { MatchRuleIdSchema } from './matchRules.js';
import { GuestNameSchema, MemberIdSchema, MemberSchema } from './member.js';
import { AttributedRuleSchema, HardFiltersSchema } from './preferences.js';
import { SwipeSchema } from './swipe.js';

/**
 * Session codes skip look-alike characters (0/O, 1/I/L) because people read them
 * aloud or type them from a screenshot. 31 symbols ^ 6 = ~887 million codes.
 */
export const SESSION_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const SESSION_CODE_LENGTH = 6;
export const MAX_MEMBERS = 10;

export const SessionCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/, 'Codes are 6 letters and numbers');

export type SessionCode = z.infer<typeof SessionCodeSchema>;

export const SessionModeSchema = z.enum(['cook-in']);
export type SessionMode = z.infer<typeof SessionModeSchema>;

/** lobby: waiting for the host to start. swiping: deck is live (late joiners welcome). */
export const SessionStatusSchema = z.enum(['lobby', 'swiping']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const MatchSchema = z.object({
  cardId: z.string(),
  matchedAt: z.number().int(),
});

export type Match = z.infer<typeof MatchSchema>;

/**
 * The full session as every member sees it. The server broadcasts this whole
 * object after each change: at <= 10 members and a small deck it's a few KB, and
 * clients can never drift out of sync the way they could with deltas.
 */
export const SessionViewSchema = z.object({
  code: SessionCodeSchema,
  mode: SessionModeSchema,
  matchRule: MatchRuleIdSchema,
  status: SessionStatusSchema,
  deck: z.array(CardSchema),
  members: z.array(MemberSchema),
  swipes: z.array(SwipeSchema),
  /** Sticky: once a card matches it stays matched, in the order matches happened. */
  matches: z.array(MatchSchema),
  /** True once every current member has swiped every card. */
  finished: z.boolean(),
  /** The hard filters the current deck was built with (null in the lobby). */
  deckFilters: HardFiltersSchema.nullable(),
  /**
   * Members' hard rules the current deck was NOT filtered for, e.g. a late joiner's
   * peanut allergy. Shown as a warning; the host can rebuild the deck.
   */
  uncovered: z.array(AttributedRuleSchema),
  /** Shopping lists made for matched (or accepted) recipes, one per card. */
  shoppingLists: z.array(ShoppingListSchema),
  /**
   * The mediator's compromise when everyone finished and nothing matched. null until
   * it has been worked out (and in every other case).
   */
  suggestion: SuggestionSchema.nullable(),
  /** True while the mediator is working on a suggestion. */
  mediating: z.boolean(),
});

export type SessionView = z.infer<typeof SessionViewSchema>;

// ---- REST contract ----

export const CreateSessionRequestSchema = z.object({
  hostName: GuestNameSchema,
  matchRule: MatchRuleIdSchema.default('everyone'),
});

export type CreateSessionRequest = z.input<typeof CreateSessionRequestSchema>;

export const JoinSessionRequestSchema = z.object({
  name: GuestNameSchema,
});

export type JoinSessionRequest = z.infer<typeof JoinSessionRequestSchema>;

/** Returned once, to the person who created or joined. The token is their rejoin key. */
export const MembershipSchema = z.object({
  code: SessionCodeSchema,
  memberId: MemberIdSchema,
  token: z.string().min(32).max(128),
});

export type Membership = z.infer<typeof MembershipSchema>;

/** What someone sees on the join screen before they pick a name. */
export const SessionPreviewSchema = z.object({
  code: SessionCodeSchema,
  mode: SessionModeSchema,
  matchRule: MatchRuleIdSchema,
  status: SessionStatusSchema,
  hostName: GuestNameSchema,
  memberCount: z.number().int(),
  full: z.boolean(),
});

export type SessionPreview = z.infer<typeof SessionPreviewSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
