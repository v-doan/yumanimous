import { describe, expect, it } from 'vitest';
import type { Card, Swipe } from '@yumanimous/shared';
import { applyRerank, RERANK_AFTER_SWIPES, shouldRerank, unswipedByAnyone } from './rerank.js';

const deck: Card[] = Array.from({ length: 20 }, (_, i) => ({
  id: `c${i}`,
  title: `Card ${i}`,
  tags: [],
  blurb: 'A card for testing.',
}));
const swipesFor = (memberId: string, count: number): Swipe[] =>
  deck.slice(0, count).map((c) => ({ cardId: c.id, memberId, direction: 'like' }));

const session = (overrides: Partial<Parameters<typeof shouldRerank>[0]> = {}) => ({
  status: 'swiping',
  rerankedAt: null,
  deck,
  members: [{ id: 'vy' }, { id: 'sam' }],
  swipes: [...swipesFor('vy', RERANK_AFTER_SWIPES), ...swipesFor('sam', RERANK_AFTER_SWIPES)],
  ...overrides,
});

describe('shouldRerank', () => {
  it('fires once every member has swiped enough', () => {
    expect(shouldRerank(session())).toBe(true);
  });

  it.each([
    ['someone is still behind', { swipes: [...swipesFor('vy', 8), ...swipesFor('sam', 7)] }],
    ['it already ran', { rerankedAt: 123 }],
    ['the deck is small (non-AI deck)', { deck: deck.slice(0, 10) }],
    ['the session is in the lobby', { status: 'lobby' }],
    [
      'almost nothing is left to reorder',
      { swipes: [...swipesFor('vy', 18), ...swipesFor('sam', 18)] },
    ],
  ])('does not fire when %s', (_why, overrides) => {
    expect(shouldRerank(session(overrides))).toBe(false);
  });
});

describe('applyRerank', () => {
  it('reorders only cards nobody swiped; swiped cards keep their positions', () => {
    const small = deck.slice(0, 5); // c0..c4
    const swipes: Swipe[] = [
      { cardId: 'c0', memberId: 'vy', direction: 'like' },
      { cardId: 'c2', memberId: 'sam', direction: 'skip' }, // Sam swiped further ahead.
    ];
    const result = applyRerank(small, swipes, ['c4', 'c3', 'c1']);
    expect(result.map((c) => c.id)).toEqual(['c0', 'c4', 'c2', 'c3', 'c1']);
  });

  it('keeps unmentioned unswiped cards, in their old order, after the ranked ones', () => {
    const small = deck.slice(0, 4);
    const result = applyRerank(small, [], ['c2']);
    expect(result.map((c) => c.id)).toEqual(['c2', 'c0', 'c1', 'c3']);
  });

  it('treats cards swiped during the AI run as fixed', () => {
    const small = deck.slice(0, 3);
    // The order was computed when nothing was swiped; c1 got swiped since.
    const result = applyRerank(
      small,
      [{ cardId: 'c1', memberId: 'vy', direction: 'like' }],
      ['c2', 'c1', 'c0'],
    );
    expect(result.map((c) => c.id)).toEqual(['c2', 'c1', 'c0']);
    expect(result[1]!.id).toBe('c1');
  });

  it('is always a permutation of the deck', () => {
    const result = applyRerank(deck, swipesFor('vy', 5), deck.map((c) => c.id).reverse());
    expect(result.map((c) => c.id).sort()).toEqual(deck.map((c) => c.id).sort());
  });
});

describe('unswipedByAnyone', () => {
  it('lists cards nobody has swiped, in deck order', () => {
    expect(unswipedByAnyone(deck.slice(0, 3), swipesFor('vy', 1)).map((c) => c.id)).toEqual([
      'c1',
      'c2',
    ]);
  });
});
