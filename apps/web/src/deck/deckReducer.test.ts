import { describe, expect, it } from 'vitest';
import type { Card } from '@yumanimous/shared';
import { deckReducer, initDeck, isDeckDone, likedCards } from './deckReducer';

const card = (id: string): Card => ({ id, title: id, tags: [], blurb: `${id} blurb` });
const cards = [card('a'), card('b'), card('c')];

describe('deckReducer', () => {
  it('starts on the first card with no swipes', () => {
    const state = initDeck(cards);
    expect(state.index).toBe(0);
    expect(state.swipes).toEqual([]);
    expect(isDeckDone(state)).toBe(false);
  });

  it('records a like and advances', () => {
    const state = deckReducer(initDeck(cards), { type: 'swipe', direction: 'like' });
    expect(state.index).toBe(1);
    expect(state.swipes).toEqual([{ cardId: 'a', direction: 'like' }]);
  });

  it('records a skip and advances', () => {
    const state = deckReducer(initDeck(cards), { type: 'swipe', direction: 'skip' });
    expect(state.index).toBe(1);
    expect(state.swipes).toEqual([{ cardId: 'a', direction: 'skip' }]);
  });

  it('is done after the last card and lists liked cards in deck order', () => {
    let state = initDeck(cards);
    state = deckReducer(state, { type: 'swipe', direction: 'like' });
    state = deckReducer(state, { type: 'swipe', direction: 'skip' });
    state = deckReducer(state, { type: 'swipe', direction: 'like' });
    expect(isDeckDone(state)).toBe(true);
    expect(likedCards(state).map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('ignores swipes once the deck is done', () => {
    let state = initDeck([card('a')]);
    state = deckReducer(state, { type: 'swipe', direction: 'like' });
    const after = deckReducer(state, { type: 'swipe', direction: 'like' });
    expect(after).toBe(state);
  });

  it('reset returns to the first card and clears swipes', () => {
    let state = deckReducer(initDeck(cards), { type: 'swipe', direction: 'like' });
    state = deckReducer(state, { type: 'reset' });
    expect(state).toEqual(initDeck(cards));
  });

  it('does not mutate the previous state', () => {
    const before = initDeck(cards);
    deckReducer(before, { type: 'swipe', direction: 'like' });
    expect(before.index).toBe(0);
    expect(before.swipes).toEqual([]);
  });
});
