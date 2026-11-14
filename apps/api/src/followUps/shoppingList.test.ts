import { describe, expect, it } from 'vitest';
import type { RecipeIngredient } from '@yumanimous/shared';
import { buildLines, checkCoverage, fallbackPlan, rescaleLines } from './shoppingList.js';

const ingredients: RecipeIngredient[] = [
  { name: 'garlic', amount: 2, unit: 'cloves', aisle: 'Produce' },
  { name: 'olive oil', amount: 1, unit: 'tbsp', aisle: 'Oil, Vinegar, Salad Dressing' },
  { name: 'garlic', amount: 1, unit: 'clove', aisle: 'Produce' },
  { name: 'salt', amount: 0, unit: '', aisle: 'Spices and Seasonings;Baking' },
];

const line = (covers: number[], name = 'Line') => ({
  name,
  aisle: 'Produce',
  covers,
  likelyAtHome: false,
});

describe('checkCoverage', () => {
  it('accepts a plan that covers every ingredient exactly once', () => {
    expect(checkCoverage([line([0, 2]), line([1]), line([3])], 4)).toEqual([]);
  });

  it('reports a missing ingredient', () => {
    expect(checkCoverage([line([0, 2]), line([1])], 4)).toEqual(['Not covered by any line: 3.']);
  });

  it('reports an ingredient on two lines', () => {
    expect(checkCoverage([line([0, 2]), line([1, 2]), line([3])], 4)).toEqual([
      'Covered by more than one line: 2.',
    ]);
  });

  it('reports an invented ingredient', () => {
    expect(checkCoverage([line([0, 1, 2, 3]), line([7])], 4)).toEqual([
      'Ingredient 7 does not exist.',
    ]);
  });

  it('does not count the same index twice within one line', () => {
    expect(checkCoverage([line([0, 0, 1, 2, 3])], 4)).toEqual([]);
  });
});

describe('buildLines', () => {
  it('computes each line’s quantity from what it covers, scaled', () => {
    const lines = buildLines([line([0, 2], 'Garlic'), line([1]), line([3])], ingredients, 4, 2);
    expect(lines[0]).toMatchObject({ id: 'l1', name: 'Garlic', quantity: '6 cloves', have: false });
    expect(lines[1]!.quantity).toBe('2 tbsp');
    expect(lines[2]!.quantity).toBe('');
  });

  it('ticks lines that are probably at home', () => {
    const [l] = buildLines([{ ...line([0, 1, 2, 3]), likelyAtHome: true }], ingredients, 2, 2);
    expect(l).toMatchObject({ likelyAtHome: true, have: true });
  });

  it('cleans control characters out of model-written names', () => {
    const [l] = buildLines([line([0, 1, 2, 3], 'Gar\u202Elic\n')], ingredients, 2, 2);
    expect(l!.name).toBe('Gar lic');
  });
});

describe('fallbackPlan', () => {
  it('makes one line per ingredient, by the API’s first aisle, staples at home', () => {
    const plan = fallbackPlan(ingredients);
    expect(plan).toHaveLength(4);
    expect(checkCoverage(plan, 4)).toEqual([]);
    expect(plan[1]).toMatchObject({ name: 'Olive oil', likelyAtHome: true });
    expect(plan[3]).toMatchObject({ aisle: 'Spices and Seasonings', likelyAtHome: true });
    expect(plan[0]).toMatchObject({ name: 'Garlic', likelyAtHome: false });
  });
});

describe('rescaleLines', () => {
  it('recomputes quantities and keeps the "we have it" ticks', () => {
    const lines = buildLines([line([0, 2], 'Garlic'), line([1, 3])], ingredients, 2, 2);
    lines[1]!.have = true;
    const rescaled = rescaleLines(lines, ingredients, 4, 2);
    expect(rescaled[0]!.quantity).toBe('6 cloves');
    expect(rescaled[1]).toMatchObject({ quantity: '2 tbsp', have: true });
  });
});
