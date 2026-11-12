import type { Card, Swipe, SwipeDirection } from '@yumanimous/shared';

/**
 * Pure deck state. No animation, network or timing concerns live here, which keeps
 * it trivially testable and lets Phase 2 feed the same swipes to the server.
 */
export interface DeckState {
  cards: Card[];
  /** Index of the card currently on top; equals cards.length when the deck is done. */
  index: number;
  swipes: Swipe[];
}

export type DeckAction = { type: 'swipe'; direction: SwipeDirection } | { type: 'reset' };

export function initDeck(cards: Card[]): DeckState {
  return { cards, index: 0, swipes: [] };
}

export function deckReducer(state: DeckState, action: DeckAction): DeckState {
  switch (action.type) {
    case 'swipe': {
      const card = state.cards[state.index];
      // Ignore swipes after the last card (e.g. a stray key press on the end screen).
      if (!card) return state;
      return {
        ...state,
        index: state.index + 1,
        swipes: [...state.swipes, { cardId: card.id, direction: action.direction }],
      };
    }
    case 'reset':
      return initDeck(state.cards);
  }
}

export const isDeckDone = (state: DeckState) => state.index >= state.cards.length;

export const likedCards = (state: DeckState): Card[] => {
  const liked = new Set(state.swipes.filter((s) => s.direction === 'like').map((s) => s.cardId));
  return state.cards.filter((c) => liked.has(c.id));
};
