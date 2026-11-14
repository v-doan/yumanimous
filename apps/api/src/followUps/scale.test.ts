import { describe, expect, it } from 'vitest';
import type { RecipeIngredient } from '@yumanimous/shared';
import { lineQuantity, roundAmount, scaleFactor } from './scale.js';

const ing = (amount: number, unit: string, name = 'x'): RecipeIngredient => ({
  name,
  amount,
  unit,
  aisle: null,
});

describe('scaleFactor', () => {
  it('scales by servings over what the recipe serves', () => {
    expect(scaleFactor(6, 4)).toBe(1.5);
  });
  it('leaves amounts alone when the recipe does not say what it serves', () => {
    expect(scaleFactor(6, null)).toBe(1);
  });
});

describe('roundAmount', () => {
  it('rounds things you count up to whole ones (you can’t buy 1.5 onions)', () => {
    expect(roundAmount(1.5, 'count')).toBe(2);
    expect(roundAmount(0.2, 'count')).toBe(1);
  });
  it('does not round 3 × ⅓ up to 2 because of floating point', () => {
    expect(roundAmount((1 / 3) * 3, 'count')).toBe(1);
  });
  it('rounds cups and spoons to the nearest quarter, at least ¼', () => {
    expect(roundAmount(1.3, 'measure')).toBe(1.25);
    expect(roundAmount(0.05, 'measure')).toBe(0.25);
  });
  it('rounds grams to the nearest 5 from 20 up, whole numbers below', () => {
    expect(roundAmount(453.6, 'metric', 'g')).toBe(455);
    expect(roundAmount(7.4, 'metric', 'g')).toBe(7);
    expect(roundAmount(1.26, 'metric', 'kg')).toBe(1.3);
  });
});

describe('lineQuantity', () => {
  it('scales and formats with fractions and plurals', () => {
    expect(lineQuantity([ing(1, 'cup')], 1.5)).toBe('1½ cups');
    expect(lineQuantity([ing(2, 'cloves')], 1.5)).toBe('3 cloves');
    expect(lineQuantity([ing(0.5, 'tsp')], 1)).toBe('½ tsp');
  });

  it('sums the same unit across spellings before rounding', () => {
    expect(lineQuantity([ing(1, 'Tbsp'), ing(2, 'tablespoons')], 1)).toBe('3 tbsp');
    expect(lineQuantity([ing(1 / 3, 'cup'), ing(1 / 3, 'cup'), ing(1 / 3, 'cups')], 1)).toBe(
      '1 cup',
    );
  });

  it('reads cookbook shorthand: T is a tablespoon, t a teaspoon, c a cup', () => {
    expect(lineQuantity([ing(2, 'T')], 1)).toBe('2 tbsp');
    expect(lineQuantity([ing(0.75, 't')], 1)).toBe('¾ tsp');
    expect(lineQuantity([ing(1.25, 'c'), ing(0.5, 'C.')], 1)).toBe('1¾ cups');
    // Same unit, different spellings: merged.
    expect(lineQuantity([ing(1, 'T'), ing(1, 'Tbsp')], 1)).toBe('2 tbsp');
  });

  it('joins different units instead of converting them', () => {
    expect(lineQuantity([ing(1, 'cup'), ing(2, 'tbsp')], 1)).toBe('1 cup + 2 tbsp');
  });

  it('treats sizes as a plain count', () => {
    expect(lineQuantity([ing(1, 'large'), ing(1, '')], 2)).toBe('4');
    // Spoonacular's "servings" unit is kept: "2" alone would read as 2 packets.
    expect(lineQuantity([ing(2, 'servings')], 1)).toBe('2 servings');
  });

  it('gives no quantity for "to taste" (amount 0)', () => {
    expect(lineQuantity([ing(0, '')], 2)).toBe('');
  });

  it('keeps unknown units as written', () => {
    expect(lineQuantity([ing(1, 'packet')], 2)).toBe('2 packet');
  });
});
