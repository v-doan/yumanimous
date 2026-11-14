import { z } from 'zod';
import {
  evaluateCard,
  matchRules,
  type Card,
  type MatchRuleId,
  type Swipe,
} from '@yumanimous/shared';

/** One card in a finished session with no match, with its votes. */
export interface Contender {
  cardId: string;
  title: string;
  yums: number;
}

/** What the mediator hands in (structured output). Checked by `checkPick`. */
export const MediatorPickSchema = z.object({
  cardId: z.string().max(64),
  reason: z.string().max(600),
});

export type MediatorPick = z.infer<typeof MediatorPickSchema>;

/** How far below the most-yummed card a compromise may be. */
export const MAX_YUMS_BEHIND = 1;
export const MAX_REASON = 280;

/** Every card with its yum count, most yums first, then deck order. */
export function contenders(
  deck: Card[],
  swipes: Swipe[],
  memberIds: string[],
  matchRule: MatchRuleId,
): Contender[] {
  const rule = matchRules[matchRule];
  return deck
    .map((card, index) => ({
      cardId: card.id,
      title: card.title,
      yums: evaluateCard(rule, card.id, swipes, memberIds).tally.likes.length,
      index,
    }))
    .sort((a, b) => b.yums - a.yums || a.index - b.index)
    .map(({ index: _index, ...c }) => c);
}

// Control characters and bidi overrides, as for card blurbs.
const UNSAFE = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

/**
 * AI suggests, code enforces. The pick must be a card from this deck, and no more
 * than one yum behind the top card: the mediator may break a tie or favour a
 * near-miss that suits everyone better, but it can't overrule the votes. The reason
 * is cleaned and must fit. null means "use the fallback".
 */
export function checkPick(
  pick: MediatorPick,
  candidates: Contender[],
): { cardId: string; reason: string } | null {
  const top = candidates[0]?.yums ?? 0;
  const card = candidates.find((c) => c.cardId === pick.cardId);
  if (!card || card.yums < top - MAX_YUMS_BEHIND) return null;
  const reason = pick.reason.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  if (reason.length < 10 || reason.length > MAX_REASON) return null;
  return { cardId: card.cardId, reason };
}

/** The non-AI compromise: the card with the most yums (deck order breaks ties). */
export function fallbackPick(
  candidates: Contender[],
  memberCount: number,
): { cardId: string; reason: string } | null {
  const top = candidates[0];
  if (!top) return null;
  const reason =
    top.yums === 0
      ? `Nobody said yum to anything, so here's the first card to get you started: ${top.title}.`
      : `${top.title} got the most yums (${top.yums} of ${memberCount}). Nothing won everyone over, so it's the closest thing to a group pick.`;
  return { cardId: top.cardId, reason: reason.slice(0, MAX_REASON) };
}
