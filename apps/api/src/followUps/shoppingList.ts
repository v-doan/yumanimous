import { z } from 'zod';
import type { RecipeIngredient, ShoppingLine } from '@yumanimous/shared';
import { lineQuantity, scaleFactor } from './scale.js';

/**
 * What the sous-chef hands in: how to group the recipe's ingredients into lines.
 * No quantities: code computes those from the ingredients each line covers.
 */
export const LinePlanSchema = z.object({
  name: z.string().trim().min(1).max(60),
  aisle: z.string().trim().min(1).max(40),
  covers: z.array(z.number().int().nonnegative()).min(1).max(40),
  likelyAtHome: z.boolean(),
});

export type LinePlan = z.infer<typeof LinePlanSchema>;

export const ShoppingPlanSchema = z.object({ lines: z.array(LinePlanSchema).min(1).max(60) });

/**
 * Every ingredient covered exactly once, and nothing else. Returns readable problems
 * (empty when the plan is valid), which go back to the model so it can fix them.
 */
export function checkCoverage(lines: LinePlan[], ingredientCount: number): string[] {
  const problems: string[] = [];
  const seen = new Map<number, number>(); // ingredient -> how many lines cover it
  for (const line of lines) {
    for (const i of new Set(line.covers)) {
      if (i >= ingredientCount) problems.push(`Ingredient ${i} does not exist.`);
      else seen.set(i, (seen.get(i) ?? 0) + 1);
    }
  }
  const missing: number[] = [];
  const duplicated: number[] = [];
  for (let i = 0; i < ingredientCount; i++) {
    const count = seen.get(i) ?? 0;
    if (count === 0) missing.push(i);
    if (count > 1) duplicated.push(i);
  }
  if (missing.length) problems.push(`Not covered by any line: ${missing.join(', ')}.`);
  if (duplicated.length) problems.push(`Covered by more than one line: ${duplicated.join(', ')}.`);
  return problems;
}

// Control characters and bidi overrides, as for card blurbs.
const UNSAFE = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;
const clean = (text: string, max: number) =>
  text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const titleCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Things nearly every kitchen has. Only used by the non-AI list. */
const STAPLES = new Set([
  'water',
  'salt',
  'pepper',
  'black pepper',
  'salt and pepper',
  'sea salt',
  'kosher salt',
  'olive oil',
  'vegetable oil',
  'oil',
  'cooking oil',
  'sugar',
  'ice',
]);

/** Turns a checked plan into lines with code-computed quantities. */
export function buildLines(
  plan: LinePlan[],
  ingredients: RecipeIngredient[],
  servings: number,
  recipeServings: number | null,
): ShoppingLine[] {
  const factor = scaleFactor(servings, recipeServings);
  return plan.map((line, index) => {
    const covered = line.covers.map((i) => ingredients[i]!);
    const name = clean(line.name, 60) || titleCase(clean(covered[0]!.name, 60));
    const aisle = clean(line.aisle, 40) || 'Other';
    return {
      id: `l${index + 1}`,
      name,
      aisle,
      quantity: lineQuantity(covered, factor),
      covers: [...new Set(line.covers)],
      likelyAtHome: line.likelyAtHome,
      // Probably at home: starts ticked, so it's left off the copied list.
      have: line.likelyAtHome,
    };
  });
}

/**
 * The non-AI list: one line per ingredient, grouped by the recipe API's aisle, with
 * a short list of staples assumed to be at home. Used when the AI is over budget,
 * fails, or keeps handing in lists that don't add up.
 */
export function fallbackPlan(ingredients: RecipeIngredient[]): LinePlan[] {
  return ingredients.map((ingredient, i) => ({
    name: titleCase(clean(ingredient.name, 60)) || `Ingredient ${i + 1}`,
    // Spoonacular aisles can be "Spices and Seasonings;Ethnic Foods": keep the first.
    aisle: clean(ingredient.aisle?.split(';')[0] ?? '', 40) || 'Other',
    covers: [i],
    likelyAtHome: STAPLES.has(ingredient.name.trim().toLowerCase()),
  }));
}

/** A new servings count: quantities recomputed, "we have it" ticks kept. */
export function rescaleLines(
  lines: ShoppingLine[],
  ingredients: RecipeIngredient[],
  servings: number,
  recipeServings: number | null,
): ShoppingLine[] {
  const factor = scaleFactor(servings, recipeServings);
  return lines.map((line) => ({
    ...line,
    quantity: lineQuantity(
      line.covers.map((i) => ingredients[i]!),
      factor,
    ),
  }));
}
