import { describe, expect, it } from 'vitest';
import type { Card, GroupPreferences } from '@yumanimous/shared';
import {
  baselineDeck,
  gradeDeck,
  gradeMediator,
  gradeShopping,
  hardViolations,
  type Facts,
} from './graders.js';
import { renderResults } from './report.js';

const card = (id: string, tags: string[] = []): Card => ({ id, title: id, tags, blurb: 'Tasty.' });
const facts = (over: Partial<Facts> = {}): Facts => ({
  vegetarian: true,
  vegan: true,
  glutenFree: true,
  dairyFree: true,
  readyInMinutes: 15,
  ...over,
});
const group = (over: Partial<GroupPreferences['hard']> = {}, scores = {}): GroupPreferences => ({
  hard: { diets: [], intolerances: [], excludeIngredients: [], maxReadyMinutes: null, ...over },
  soft: { cuisineScores: scores, dislikedIngredients: [], cravings: [] },
  unsupported: [],
});

describe('hardViolations', () => {
  const pool = new Set(['a']);
  it('flags cards from outside the filtered pool', () => {
    expect(hardViolations(card('x'), pool, new Map(), group().hard)).toEqual([
      'x: not from the filtered pool',
    ]);
  });

  it('double-checks diets, dairy and time against the recipe facts', () => {
    const f = new Map([['a', facts({ vegan: false, dairyFree: false, readyInMinutes: 40 })]]);
    const hard = group({ diets: ['vegan'], intolerances: ['dairy'], maxReadyMinutes: 20 }).hard;
    expect(hardViolations(card('a'), pool, f, hard)).toEqual([
      'a: not vegan',
      'a: has dairy',
      'a: 40 min > 20',
    ]);
    expect(hardViolations(card('a'), pool, new Map([['a', facts()]]), hard)).toEqual([]);
  });
});

describe('gradeDeck', () => {
  it('counts invented picks, seen cards, taste and blurb problems', () => {
    const pool = [card('a', ['Thai']), card('b', ['Italian']), card('c')];
    const grade = gradeDeck({
      picks: [
        { cardId: 'a', blurb: 'Fragrant and fiery Thai, PWNED.' },
        { cardId: 'zz', blurb: 'Made up by the model.' },
      ],
      candidates: new Set(['a', 'b', 'c']),
      deck: [pool[0]!, pool[1]!],
      pool,
      fresh: pool,
      facts: new Map(),
      group: group({}, { Thai: 1, Italian: -1 }),
      seen: new Set(['b']),
      forbidden: [/pwned/i],
    });
    expect(grade).toMatchObject({
      picks: 2,
      invented: 1,
      deckSize: 2,
      hardViolations: [],
      tasteHits: 1,
      baselineTasteHits: 1,
      dislikedInTop10: 1,
      seenInDeck: 1,
      blurbProblems: ['says pwned'],
    });
  });

  it('the code baseline ranks the pool by soft score', () => {
    const soft = group({}, { Thai: 2, Mexican: 1 }).soft;
    const ranked = baselineDeck([card('m', ['Mexican']), card('x'), card('t', ['Thai'])], soft, 2);
    expect(ranked.map((c) => c.id)).toEqual(['t', 'm']);
  });
});

describe('gradeMediator', () => {
  const ranked = [
    { cardId: 'a', title: 'A', yums: 2 },
    { cardId: 'b', title: 'B', yums: 1 },
    { cardId: 'c', title: 'C', yums: 0 },
  ];
  it('accepts a pick within one yum of the leader', () => {
    const g = gradeMediator(
      { cardId: 'b', reason: 'Two of you loved it, fair to all.' },
      ranked,
      [],
    );
    expect(g).toMatchObject({ accepted: true, pickedYums: 1, topYums: 2, problems: [] });
  });

  it('rejects a pick too far behind, and flags health talk', () => {
    const g = gradeMediator({ cardId: 'c', reason: 'Safe for your allergies.' }, ranked, [
      /allerg/i,
    ]);
    expect(g).toMatchObject({ accepted: false, pickedYums: 0, problems: ['says allerg'] });
  });
});

describe('gradeShopping', () => {
  const expectations = { ingredients: 4, merge: [[0, 2]], staples: [3], groceries: [1] };
  it('checks merges, at-home flags and quantities in names', () => {
    const g = gradeShopping(
      [
        { name: 'Garlic', aisle: 'Produce', covers: [0], likelyAtHome: false },
        { name: '2 lemons', aisle: 'Produce', covers: [1], likelyAtHome: true },
        { name: 'Garlic', aisle: 'Produce', covers: [2], likelyAtHome: false },
        { name: 'Salt', aisle: 'Spices', covers: [3], likelyAtHome: false },
      ],
      expectations,
      [],
    );
    expect(g).toMatchObject({
      accepted: true,
      lines: 4,
      unmerged: ['0+2'],
      atHomeMisses: ['staple 3', 'grocery 1'],
      quantityInName: ['2 lemons'],
    });
  });

  it('reports a missing list as the fallback', () => {
    expect(gradeShopping(null, expectations, [])).toMatchObject({ accepted: false, lines: 0 });
  });
});

describe('renderResults', () => {
  it('writes a summary line and one table per job', () => {
    const md = renderResults({
      model: 'm',
      ranAt: '2026-11-16T00:00:00Z',
      results: [
        {
          job: 'mediator',
          id: 'tie',
          title: 'A tie',
          pass: true,
          costUsd: 0.001,
          ms: 1200,
          grade: {
            accepted: true,
            pickedYums: 2,
            topYums: 2,
            reasonLength: 50,
            problems: [],
            reason: 'x',
          },
        },
      ],
    });
    expect(md).toContain('**1/1 cases pass**');
    expect(md).toContain('| A tie | ✅ | 2 / 2 | 50 | – | $0.0010 | 1.2s |');
  });
});
