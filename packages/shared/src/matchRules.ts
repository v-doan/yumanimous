import { z } from 'zod';
import type { Swipe } from './swipe.js';

export const MatchRuleIdSchema = z.enum(['everyone', 'majority']);
export type MatchRuleId = z.infer<typeof MatchRuleIdSchema>;

/**
 * - match: the rule is satisfied; it stays a match even if members join later.
 * - no-match: the rule can no longer be satisfied with the current members.
 * - undecided: still waiting on votes.
 */
export type CardOutcome = 'match' | 'no-match' | 'undecided';

/** Who voted which way on one card, counting only current members. */
export interface CardTally {
  cardId: string;
  likes: string[];
  skips: string[];
  /** Current members who have not swiped this card yet. */
  pending: string[];
}

export interface MatchRule {
  id: MatchRuleId;
  label: string;
  description: string;
  /** Pure: same tally in, same outcome out. No clocks, no I/O. */
  decide: (tally: CardTally) => CardOutcome;
}

/**
 * Builds a tally for one card. Swipes from people who are no longer members are
 * ignored, which is how "member leaves mid-session" is handled: their votes stop
 * counting and the denominator shrinks.
 */
export function tallyCard(cardId: string, swipes: Swipe[], memberIds: string[]): CardTally {
  const members = new Set(memberIds);
  const likes: string[] = [];
  const skips: string[] = [];
  const voted = new Set<string>();

  for (const swipe of swipes) {
    if (swipe.cardId !== cardId || !members.has(swipe.memberId) || voted.has(swipe.memberId)) {
      continue;
    }
    voted.add(swipe.memberId);
    (swipe.direction === 'like' ? likes : skips).push(swipe.memberId);
  }

  return { cardId, likes, skips, pending: memberIds.filter((id) => !voted.has(id)) };
}

const memberCount = (t: CardTally) => t.likes.length + t.skips.length + t.pending.length;

export const everyoneRule: MatchRule = {
  id: 'everyone',
  label: 'Everyone',
  description: 'A match when every member says yum.',
  decide: (t) => {
    if (memberCount(t) === 0) return 'undecided';
    // One skip is enough to rule a card out, so the group never waits on a lost cause.
    if (t.skips.length > 0) return 'no-match';
    return t.pending.length === 0 ? 'match' : 'undecided';
  },
};

export const majorityRule: MatchRule = {
  id: 'majority',
  label: 'Majority',
  description: 'A match when more than half of members say yum.',
  decide: (t) => {
    const half = memberCount(t) / 2;
    if (memberCount(t) === 0) return 'undecided';
    // Decided early in both directions: a match as soon as likes pass half, and out
    // as soon as even all pending votes could not push it past half.
    if (t.likes.length > half) return 'match';
    if (t.likes.length + t.pending.length <= half) return 'no-match';
    return 'undecided';
  },
};

export const matchRules: Record<MatchRuleId, MatchRule> = {
  everyone: everyoneRule,
  majority: majorityRule,
};

/** Convenience for the common case: (swipes, members) -> outcome for one card. */
export function evaluateCard(
  rule: MatchRule,
  cardId: string,
  swipes: Swipe[],
  memberIds: string[],
): { tally: CardTally; outcome: CardOutcome } {
  const tally = tallyCard(cardId, swipes, memberIds);
  return { tally, outcome: rule.decide(tally) };
}
