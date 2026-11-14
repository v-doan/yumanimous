import { describe, expect, it } from 'vitest';
import type { Card, Swipe } from '@yumanimous/shared';
import { checkPick, contenders, fallbackPick, type Contender } from './mediator.js';

const ranked: Contender[] = [
  { cardId: 'curry', title: 'Curry', yums: 2 },
  { cardId: 'tacos', title: 'Tacos', yums: 1 },
  { cardId: 'soup', title: 'Soup', yums: 0 },
];
const reason = 'Two of you said yum and nobody skipped it outright.';

describe('contenders', () => {
  it('orders cards by yums, then by deck order', () => {
    const deck: Card[] = ['a', 'b', 'c'].map((id) => ({ id, title: id, tags: [], blurb: 'x' }));
    const swipes: Swipe[] = [
      { memberId: 'm1', cardId: 'c', direction: 'like' },
      { memberId: 'm1', cardId: 'b', direction: 'like' },
      { memberId: 'm2', cardId: 'c', direction: 'like' },
      { memberId: 'm2', cardId: 'a', direction: 'skip' },
    ];
    expect(contenders(deck, swipes, ['m1', 'm2', 'm3'], 'everyone')).toEqual([
      { cardId: 'c', title: 'c', yums: 2 },
      { cardId: 'b', title: 'b', yums: 1 },
      { cardId: 'a', title: 'a', yums: 0 },
    ]);
  });
});

describe('checkPick', () => {
  it('accepts the top card', () => {
    expect(checkPick({ cardId: 'curry', reason }, ranked)).toEqual({ cardId: 'curry', reason });
  });

  it('accepts a card one yum behind the top', () => {
    expect(checkPick({ cardId: 'tacos', reason }, ranked)?.cardId).toBe('tacos');
  });

  it('refuses a card two yums behind: the mediator can’t overrule the votes', () => {
    expect(checkPick({ cardId: 'soup', reason }, ranked)).toBeNull();
  });

  it('refuses a card that is not in the deck', () => {
    expect(checkPick({ cardId: 'pizza', reason }, ranked)).toBeNull();
  });

  it('refuses a reason that is too long or empty, and cleans control characters', () => {
    expect(checkPick({ cardId: 'curry', reason: 'x'.repeat(281) }, ranked)).toBeNull();
    expect(checkPick({ cardId: 'curry', reason: '  ' }, ranked)).toBeNull();
    expect(checkPick({ cardId: 'curry', reason: `${reason}\u202E\n` }, ranked)?.reason).toBe(
      reason,
    );
  });
});

describe('fallbackPick', () => {
  it('picks the card with the most yums', () => {
    expect(fallbackPick(ranked, 3)).toEqual({
      cardId: 'curry',
      reason: expect.stringContaining('Curry got the most yums (2 of 3)'),
    });
  });

  it('still suggests something when nobody said yum', () => {
    const none = ranked.map((c) => ({ ...c, yums: 0 }));
    expect(fallbackPick(none, 3)?.cardId).toBe('curry');
  });

  it('has nothing to suggest for an empty deck', () => {
    expect(fallbackPick([], 3)).toBeNull();
  });
});
