import { describe, expect, it } from 'vitest';
import { summarizeRounds, withHistory, type PastRound } from './rounds.js';

const card = (id: string, ...tags: string[]) => ({ id, title: `Dish ${id}`, tags });
const vy = { id: 'vy', name: 'Vy' };
const sam = { id: 'sam', name: 'Sam' };

const round1: PastRound = {
  round: 1,
  cards: [
    card('a', '30 min', 'Thai'),
    card('b', 'vegetarian', 'Italian'),
    card('c', 'Italian'),
    card('d', 'Mexican'),
  ],
  swipes: [
    { memberId: 'vy', cardId: 'a', direction: 'like' },
    { memberId: 'vy', cardId: 'b', direction: 'skip' },
    { memberId: 'vy', cardId: 'c', direction: 'skip' },
    { memberId: 'vy', cardId: 'd', direction: 'skip' },
    { memberId: 'sam', cardId: 'a', direction: 'like' },
    { memberId: 'sam', cardId: 'b', direction: 'like' },
    { memberId: 'gone', cardId: 'd', direction: 'like' },
  ],
  decision: { cardId: 'a', title: 'Dish a', how: 'match' },
};

describe('summarizeRounds', () => {
  it('finds cuisines each member said yum to, and ones they never did', () => {
    const history = summarizeRounds([round1], [vy, sam]);
    expect(history.members).toEqual([
      { memberId: 'vy', name: 'Vy', yumTags: ['Thai'], neverTags: ['Italian'] },
      { memberId: 'sam', name: 'Sam', yumTags: ['Italian', 'Thai'], neverTags: [] },
    ]);
  });

  it('needs two skips before a cuisine counts as "never"', () => {
    // Vy skipped Mexican once: not enough to say they never like it.
    expect(summarizeRounds([round1], [vy]).members[0]!.neverTags).not.toContain('Mexican');
  });

  it('ignores time and diet tags: a diet is never inferred from swipes', () => {
    const tags = summarizeRounds([round1], [vy, sam]).members.flatMap((m) => [
      ...m.yumTags,
      ...m.neverTags,
    ]);
    expect(tags).not.toContain('30 min');
    expect(tags).not.toContain('vegetarian');
  });

  it('ignores votes from people who left', () => {
    const history = summarizeRounds([round1], [vy]);
    expect(history.members).toHaveLength(1);
    expect(history.members[0]!.yumTags).not.toContain('Mexican');
  });

  it('lists every card already shown and what each round decided', () => {
    const round2: PastRound = {
      round: 2,
      cards: [card('a', 'Thai'), card('e', 'Greek')],
      swipes: [],
      decision: null,
    };
    const history = summarizeRounds([round1, round2], [vy]);
    expect(history.roundsPlayed).toBe(2);
    expect(history.shownCardIds).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(history.picks).toEqual([{ round: 1, title: 'Dish a', how: 'match' }]);
  });

  it('is empty in round 1', () => {
    expect(summarizeRounds([], [vy])).toEqual({
      roundsPlayed: 0,
      shownCardIds: [],
      picks: [],
      members: [{ memberId: 'vy', name: 'Vy', yumTags: [], neverTags: [] }],
    });
  });
});

describe('withHistory', () => {
  it('nudges cuisine scores at half the weight of a stated preference', () => {
    const history = summarizeRounds([round1], [vy, sam]);
    expect(withHistory({ Thai: 1 }, history)).toEqual({ Thai: 2, Italian: 0 });
  });
});
