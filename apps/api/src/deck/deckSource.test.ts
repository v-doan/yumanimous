import { describe, expect, it } from 'vitest';
import type { Card } from '@yumanimous/shared';
import { MIN_FRESH_CARDS, preferUnseen, seenLast } from './deckSource.js';

const cards = (n: number): Card[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, title: `C${i}`, tags: [], blurb: 'x' }));

describe('preferUnseen', () => {
  it('drops cards shown in earlier rounds while enough fresh ones remain', () => {
    const pool = cards(MIN_FRESH_CARDS + 2);
    expect(preferUnseen(pool, new Set(['c0', 'c1'])).map((c) => c.id)).not.toContain('c0');
  });

  it('keeps everything when dropping them would leave too few for a round', () => {
    const pool = cards(MIN_FRESH_CARDS + 1);
    expect(preferUnseen(pool, new Set(['c0', 'c1']))).toHaveLength(MIN_FRESH_CARDS + 1);
  });
});

describe('seenLast', () => {
  it('moves seen cards to the back, keeping the order otherwise', () => {
    expect(seenLast(cards(4), new Set(['c1'])).map((c) => c.id)).toEqual(['c0', 'c2', 'c3', 'c1']);
  });
});
