import { z } from 'zod';
import { CUISINES } from './food.js';
import { SwipeSchema, type Swipe } from './swipe.js';

/**
 * Phase 8: "Play again". A session can run several rounds with the same people;
 * each finished round is archived here so the next deck can learn from it. Nothing
 * outlives the session: link sessions are one-time by design (no saved groups).
 */

/** Only the last few rounds are kept: enough to learn from, small to store. */
export const MAX_PAST_ROUNDS = 5;

export const PastRoundSchema = z.object({
  round: z.number().int().positive(),
  cards: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        title: z.string().min(1).max(80),
        tags: z.array(z.string().max(24)).max(6),
      }),
    )
    .max(60),
  swipes: z.array(SwipeSchema).max(600),
  /** What the round settled on: a match, or the compromise the group accepted. */
  decision: z
    .object({
      cardId: z.string().min(1).max(64),
      title: z.string().min(1).max(80),
      how: z.enum(['match', 'compromise']),
    })
    .nullable(),
});

export type PastRound = z.infer<typeof PastRoundSchema>;

export interface MemberTaste {
  memberId: string;
  name: string;
  /** Cuisines this member said yum to in earlier rounds, most first. */
  yumTags: string[];
  /** Cuisines they skipped at least twice and never said yum to. */
  neverTags: string[];
}

export interface RoundHistory {
  /** Rounds played before the current one. */
  roundsPlayed: number;
  /** Every card already shown: the next deck avoids them. */
  shownCardIds: string[];
  /** What each earlier round decided, oldest first. */
  picks: { round: number; title: string; how: 'match' | 'compromise' }[];
  members: MemberTaste[];
}

/** How many skips, with no yum, make a cuisine "never" for someone. */
const NEVER_AFTER_SKIPS = 2;

// Only cuisines count as taste. Time tags ("30 min") say nothing about taste, and
// diet tags ("vegetarian") must never be inferred from swipes: diets are hard rules
// that only the member themselves states.
const CUISINE_TAGS = new Map(CUISINES.map((c) => [c.toLowerCase(), c]));
const cuisineOf = (tag: string) => CUISINE_TAGS.get(tag.toLowerCase());

/**
 * What earlier rounds say about each current member. Pure, and shared by the API
 * (code-side ranking) and mcp-session (what the curator reads), so both agree.
 * Members who left are not in `members`, and their votes are ignored.
 */
export function summarizeRounds(
  pastRounds: PastRound[],
  members: { id: string; name: string }[],
): RoundHistory {
  const tally = new Map<string, Map<string, { yum: number; skip: number }>>();
  for (const m of members) tally.set(m.id, new Map());

  for (const round of pastRounds) {
    const cuisinesOf = new Map(
      round.cards.map((c) => [c.id, c.tags.map(cuisineOf).filter((t) => t !== undefined)]),
    );
    for (const swipe of round.swipes) count(tally, swipe, cuisinesOf.get(swipe.cardId) ?? []);
  }

  return {
    roundsPlayed: pastRounds.length,
    shownCardIds: [...new Set(pastRounds.flatMap((r) => r.cards.map((c) => c.id)))],
    picks: pastRounds.flatMap((r) =>
      r.decision ? [{ round: r.round, title: r.decision.title, how: r.decision.how }] : [],
    ),
    members: members.map((m) => {
      const byTag = [...(tally.get(m.id) ?? new Map())];
      return {
        memberId: m.id,
        name: m.name,
        yumTags: byTag
          .filter(([, t]) => t.yum > 0)
          .sort((a, b) => b[1].yum - a[1].yum || a[0].localeCompare(b[0]))
          .map(([tag]) => tag),
        neverTags: byTag
          .filter(([, t]) => t.yum === 0 && t.skip >= NEVER_AFTER_SKIPS)
          .map(([tag]) => tag)
          .sort(),
      };
    }),
  };
}

function count(
  tally: Map<string, Map<string, { yum: number; skip: number }>>,
  swipe: Swipe,
  cuisines: string[],
) {
  const own = tally.get(swipe.memberId);
  if (!own) return; // Someone who has left.
  for (const tag of cuisines) {
    const t = own.get(tag) ?? { yum: 0, skip: 0 };
    if (swipe.direction === 'like') t.yum++;
    else t.skip++;
    own.set(tag, t);
  }
}

/** History as a ranking nudge: half the weight of a stated like or dislike. */
export const HISTORY_WEIGHT = 0.5;

/** Adds each member's history to the group's cuisine scores (a new object). */
export function withHistory(
  cuisineScores: Record<string, number>,
  history: RoundHistory,
): Record<string, number> {
  const scores = { ...cuisineScores };
  for (const m of history.members) {
    for (const tag of m.yumTags) scores[tag] = (scores[tag] ?? 0) + HISTORY_WEIGHT;
    for (const tag of m.neverTags) scores[tag] = (scores[tag] ?? 0) - HISTORY_WEIGHT;
  }
  return scores;
}
