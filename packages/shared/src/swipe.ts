import { z } from 'zod';
import { MemberIdSchema } from './member.js';

export const SwipeDirectionSchema = z.enum(['like', 'skip']);
export type SwipeDirection = z.infer<typeof SwipeDirectionSchema>;

/** What a client sends: the server adds who swiped from the authenticated socket. */
export const SwipeInputSchema = z.object({
  cardId: z.string().min(1).max(64),
  direction: SwipeDirectionSchema,
});

export type SwipeInput = z.infer<typeof SwipeInputSchema>;

/** One member's decision on one card. Match rules are pure functions over a list of these. */
export const SwipeSchema = SwipeInputSchema.extend({
  memberId: MemberIdSchema,
});

export type Swipe = z.infer<typeof SwipeSchema>;
