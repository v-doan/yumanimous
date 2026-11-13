import type { Card, Swipe } from '@yumanimous/shared';

/** Re-ranking only pays off on a deck with enough cards left to reorder. */
export const RERANK_MIN_DECK = 16;
/** Every member must have swiped at least this many cards first. */
export const RERANK_AFTER_SWIPES = 8;
/** And this many cards must still be unswiped by everyone. */
const RERANK_MIN_REMAINING = 4;

/**
 * Pure: should this session's remaining deck be re-ranked now? Once per session,
 * after every member has swiped enough to show the group's taste.
 */
export function shouldRerank(session: {
  status: string;
  rerankedAt: number | null;
  deck: Card[];
  members: { id: string }[];
  swipes: Swipe[];
}): boolean {
  if (session.status !== 'swiping' || session.rerankedAt !== null) return false;
  if (session.deck.length < RERANK_MIN_DECK || session.members.length === 0) return false;

  const deckIds = new Set(session.deck.map((c) => c.id));
  const enoughSwipes = session.members.every(
    (m) =>
      session.swipes.filter((s) => s.memberId === m.id && deckIds.has(s.cardId)).length >=
      RERANK_AFTER_SWIPES,
  );
  return (
    enoughSwipes && unswipedByAnyone(session.deck, session.swipes).length >= RERANK_MIN_REMAINING
  );
}

/** Cards nobody has swiped yet, in deck order. Only these may move. */
export function unswipedByAnyone(deck: Card[], swipes: Swipe[]): Card[] {
  const swiped = new Set(swipes.map((s) => s.cardId));
  return deck.filter((c) => !swiped.has(c.id));
}

/**
 * Pure: the deck with its unswiped cards in `order`. Every card someone has already
 * swiped keeps its exact position, so nobody's place in the deck changes (each
 * member's position is "the first card I haven't swiped"). Cards swiped while the
 * re-rank was running are treated as fixed too.
 */
export function applyRerank(deck: Card[], swipes: Swipe[], order: string[]): Card[] {
  const movable = unswipedByAnyone(deck, swipes);
  const movableIds = new Set(movable.map((c) => c.id));
  const byId = new Map(movable.map((c) => [c.id, c]));

  const queue = [
    ...order.filter((id) => byId.has(id)),
    ...movable.map((c) => c.id).filter((id) => !order.includes(id)),
  ].map((id) => byId.get(id)!);

  return deck.map((card) => (movableIds.has(card.id) ? queue.shift()! : card));
}
