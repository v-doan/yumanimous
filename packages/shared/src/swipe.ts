import { z } from 'zod';

export const SwipeDirectionSchema = z.enum(['like', 'skip']);
export type SwipeDirection = z.infer<typeof SwipeDirectionSchema>;

/**
 * One member's decision on one card. Phase 2 adds `memberId` and `sessionId`;
 * match rules will be pure functions over a list of these.
 */
export const SwipeSchema = z.object({
  cardId: z.string().min(1).max(64),
  direction: SwipeDirectionSchema,
});

export type Swipe = z.infer<typeof SwipeSchema>;
