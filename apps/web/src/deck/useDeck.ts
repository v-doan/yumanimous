import { useCallback, useReducer } from 'react';
import type { Card, SwipeDirection } from '@yumanimous/shared';
import { deckReducer, initDeck, isDeckDone, likedCards } from './deckReducer';

export function useDeck(cards: Card[]) {
  const [state, dispatch] = useReducer(deckReducer, cards, initDeck);

  const swipe = useCallback(
    (direction: SwipeDirection) => dispatch({ type: 'swipe', direction }),
    [],
  );
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return {
    state,
    // The top card plus the next two: rendering them also preloads their images.
    visibleCards: state.cards.slice(state.index, state.index + 3),
    done: isDeckDone(state),
    liked: likedCards(state),
    swipe,
    reset,
  };
}
