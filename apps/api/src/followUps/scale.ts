import type { RecipeIngredient } from '@yumanimous/shared';

/**
 * Quantities for the shopping list. All arithmetic lives here, in code: the model
 * only groups and names lines, it never computes an amount (models are unreliable
 * at "1⅓ cups × 6/4").
 */

type Kind = 'metric' | 'count' | 'measure';

interface Unit {
  /** Merge key: "Tbsp", "tablespoons" and "tbsp" are the same unit. */
  key: string;
  kind: Kind;
  singular: string;
  plural: string;
}

const SYNONYMS: Record<string, Unit> = {};
function unit(names: string[], kind: Kind, singular: string, plural = singular) {
  for (const name of names) SYNONYMS[name] = { key: singular, kind, singular, plural };
}
unit(['g', 'gram', 'grams', 'gr'], 'metric', 'g');
unit(['kg', 'kilogram', 'kilograms'], 'metric', 'kg');
unit(['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'], 'metric', 'ml');
unit(['l', 'liter', 'liters', 'litre', 'litres'], 'metric', 'l');
unit(['tbsp', 'tbsps', 'tablespoon', 'tablespoons', 'tbs', 'tbl', 'tb'], 'measure', 'tbsp');
unit(['tsp', 'tsps', 'teaspoon', 'teaspoons'], 'measure', 'tsp');
// "c" is the old cookbook shorthand for cup ("1 c. flour").
unit(['cup', 'cups', 'c'], 'measure', 'cup', 'cups');
unit(['oz', 'ounce', 'ounces'], 'measure', 'oz');
unit(['lb', 'lbs', 'pound', 'pounds'], 'measure', 'lb');
unit(['clove', 'cloves'], 'count', 'clove', 'cloves');
unit(['can', 'cans'], 'count', 'can', 'cans');
unit(['slice', 'slices'], 'count', 'slice', 'slices');
unit(['piece', 'pieces'], 'count', 'piece', 'pieces');
unit(['bunch', 'bunches'], 'count', 'bunch', 'bunches');
unit(['head', 'heads'], 'count', 'head', 'heads');
unit(['stalk', 'stalks'], 'count', 'stalk', 'stalks');
unit(['sprig', 'sprigs'], 'count', 'sprig', 'sprigs');
unit(['pinch', 'pinches'], 'count', 'pinch', 'pinches');
unit(['handful', 'handfuls'], 'count', 'handful', 'handfuls');
// Kept as written: "2 servings" of pasta is not "2" pastas.
unit(['serving', 'servings'], 'count', 'serving', 'servings');
// Sizes describe a count of the thing itself ("2 large eggs").
for (const size of ['', 'large', 'medium', 'small', 'whole']) {
  SYNONYMS[size] = { key: '', kind: 'count', singular: '', plural: '' };
}

/** Unknown units ("packet", "knob") are kept as written and merged only with themselves. */
function unitOf(raw: string): Unit {
  const exact = raw.trim().replace(/\.$/, '');
  // Cookbook shorthand where case is the whole meaning: capital T is a tablespoon,
  // small t a teaspoon. Checked before lowercasing, which would make them the same.
  if (exact === 'T') return SYNONYMS.tbsp!;
  if (exact === 't') return SYNONYMS.tsp!;
  const name = exact.toLowerCase();
  return SYNONYMS[name] ?? { key: name, kind: 'count', singular: name, plural: name };
}

/** servings / recipeServings, or 1 when the recipe doesn't say what it serves. */
export function scaleFactor(servings: number, recipeServings: number | null): number {
  return recipeServings && recipeServings > 0 ? servings / recipeServings : 1;
}

const FRACTIONS: Record<number, string> = { 0.25: '¼', 0.5: '½', 0.75: '¾' };

/** 1.5 -> "1½", 0.25 -> "¼". */
function fraction(value: number): string {
  const whole = Math.floor(value);
  const part = FRACTIONS[Math.round((value - whole) * 100) / 100] ?? '';
  return whole === 0 && part ? part : `${whole}${part}`;
}

/**
 * Rounded for a shop, not a lab:
 * - grams and millilitres: whole numbers, to the nearest 5 from 20 up;
 * - cups and spoons: the nearest quarter, never less than ¼;
 * - things you count: whole numbers, rounded up (you can't buy 1.5 onions).
 */
export function roundAmount(amount: number, kind: Kind, unitKey = ''): number {
  if (amount <= 0) return 0;
  if (kind === 'metric') {
    if (unitKey === 'kg' || unitKey === 'l') return Math.max(0.1, Math.round(amount * 10) / 10);
    return amount >= 20 ? Math.round(amount / 5) * 5 : Math.max(1, Math.round(amount));
  }
  if (kind === 'measure') return Math.max(0.25, Math.round(amount * 4) / 4);
  // Tiny tolerance: 3 × ⅓ is 1.0000000000000002 in floating point, which is 1, not 2.
  return Math.max(1, Math.ceil(amount - 1e-9));
}

function formatOne(amount: number, u: Unit): string {
  const rounded = roundAmount(amount, u.kind, u.key);
  const number = u.kind === 'measure' ? fraction(rounded) : String(rounded);
  const name = rounded > 1 ? u.plural : u.singular;
  return name ? `${number} ${name}` : number;
}

/**
 * The quantity for one shopping line: its ingredients scaled, summed per unit (before
 * rounding, so 3 × ⅓ cup is 1 cup) and joined when units differ ("1 cup + 2 tbsp").
 * Amounts of 0 ("salt, to taste") add nothing; a line of only those has no quantity.
 */
export function lineQuantity(ingredients: RecipeIngredient[], factor: number): string {
  const totals = new Map<string, { unit: Unit; amount: number }>();
  for (const ingredient of ingredients) {
    if (ingredient.amount <= 0) continue;
    const u = unitOf(ingredient.unit);
    const entry = totals.get(u.key) ?? { unit: u, amount: 0 };
    entry.amount += ingredient.amount * factor;
    totals.set(u.key, entry);
  }
  return [...totals.values()].map(({ unit: u, amount }) => formatOne(amount, u)).join(' + ');
}
