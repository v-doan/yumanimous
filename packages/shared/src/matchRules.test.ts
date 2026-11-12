import { describe, expect, it } from 'vitest';
import {
  evaluateCard,
  everyoneRule,
  majorityRule,
  matchRules,
  tallyCard,
  type CardOutcome,
  type MatchRule,
} from './matchRules.js';
import type { Swipe, SwipeDirection } from './swipe.js';

const CARD = 'pizza';

/** votes('like', 'skip', null) -> swipes for members m0..m2, null = not swiped yet. */
function scenario(...votes: (SwipeDirection | null)[]) {
  const memberIds = votes.map((_, i) => `m${i}`);
  const swipes: Swipe[] = votes.flatMap((direction, i) =>
    direction ? [{ cardId: CARD, memberId: `m${i}`, direction }] : [],
  );
  return { memberIds, swipes };
}

const outcome = (rule: MatchRule, ...votes: (SwipeDirection | null)[]): CardOutcome => {
  const { memberIds, swipes } = scenario(...votes);
  return evaluateCard(rule, CARD, swipes, memberIds).outcome;
};

describe('tallyCard', () => {
  it('splits members into likes, skips and pending', () => {
    const { memberIds, swipes } = scenario('like', 'skip', null);
    expect(tallyCard(CARD, swipes, memberIds)).toEqual({
      cardId: CARD,
      likes: ['m0'],
      skips: ['m1'],
      pending: ['m2'],
    });
  });

  it('ignores swipes on other cards', () => {
    const swipes: Swipe[] = [{ cardId: 'tacos', memberId: 'm0', direction: 'like' }];
    expect(tallyCard(CARD, swipes, ['m0']).pending).toEqual(['m0']);
  });

  it('ignores swipes from people who are no longer members (left mid-session)', () => {
    const swipes: Swipe[] = [{ cardId: CARD, memberId: 'gone', direction: 'skip' }];
    expect(tallyCard(CARD, swipes, ['m0'])).toMatchObject({ skips: [], pending: ['m0'] });
  });

  it('counts only the first swipe per member', () => {
    const swipes: Swipe[] = [
      { cardId: CARD, memberId: 'm0', direction: 'like' },
      { cardId: CARD, memberId: 'm0', direction: 'skip' },
    ];
    expect(tallyCard(CARD, swipes, ['m0'])).toMatchObject({ likes: ['m0'], skips: [] });
  });
});

describe('everyone rule', () => {
  it.each<[string, (SwipeDirection | null)[], CardOutcome]>([
    ['all like (2 members)', ['like', 'like'], 'match'],
    ['all like (5 members)', ['like', 'like', 'like', 'like', 'like'], 'match'],
    ['one skip rules it out immediately', ['skip', null, null], 'no-match'],
    ['one skip among likes', ['like', 'like', 'skip'], 'no-match'],
    ['still waiting on someone', ['like', 'like', null], 'undecided'],
    ['nobody has swiped', [null, null], 'undecided'],
    ['single member likes', ['like'], 'match'],
    ['no members at all', [], 'undecided'],
  ])('%s', (_name, votes, expected) => {
    expect(outcome(everyoneRule, ...votes)).toBe(expected);
  });

  it('a late joiner turns a complete card back into undecided', () => {
    const { swipes } = scenario('like', 'like');
    expect(evaluateCard(everyoneRule, CARD, swipes, ['m0', 'm1']).outcome).toBe('match');
    expect(evaluateCard(everyoneRule, CARD, swipes, ['m0', 'm1', 'late']).outcome).toBe(
      'undecided',
    );
  });

  it('the only skipper leaving makes the card a match', () => {
    const { swipes } = scenario('like', 'like', 'skip');
    expect(evaluateCard(everyoneRule, CARD, swipes, ['m0', 'm1', 'm2']).outcome).toBe('no-match');
    expect(evaluateCard(everyoneRule, CARD, swipes, ['m0', 'm1']).outcome).toBe('match');
  });
});

describe('majority rule', () => {
  it.each<[string, (SwipeDirection | null)[], CardOutcome]>([
    ['2 of 3 like', ['like', 'like', 'skip'], 'match'],
    ['2 of 3 like, decided before the third swipes', ['like', 'like', null], 'match'],
    ['exactly half is not a majority (2 of 4)', ['like', 'like', 'skip', 'skip'], 'no-match'],
    ['3 of 4 like', ['like', 'like', 'like', 'skip'], 'match'],
    ['can no longer reach a majority', ['skip', 'skip', null], 'no-match'],
    ['could still go either way', ['like', 'skip', null], 'undecided'],
    ['2 members behave like "everyone": both like', ['like', 'like'], 'match'],
    ['2 members behave like "everyone": one skip', ['like', 'skip'], 'no-match'],
    ['nobody has swiped', [null, null, null], 'undecided'],
    ['no members at all', [], 'undecided'],
  ])('%s', (_name, votes, expected) => {
    expect(outcome(majorityRule, ...votes)).toBe(expected);
  });

  it('a member leaving can push a card over the majority line', () => {
    // 2 likes of 4 is not a majority; once a skipper leaves it is 2 of 3.
    const { swipes } = scenario('like', 'like', 'skip', 'skip');
    expect(evaluateCard(majorityRule, CARD, swipes, ['m0', 'm1', 'm2', 'm3']).outcome).toBe(
      'no-match',
    );
    expect(evaluateCard(majorityRule, CARD, swipes, ['m0', 'm1', 'm2']).outcome).toBe('match');
  });
});

describe('matchRules registry', () => {
  it('maps every rule id to its rule', () => {
    for (const [id, rule] of Object.entries(matchRules)) expect(rule.id).toBe(id);
  });
});
