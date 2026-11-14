import { z } from 'zod';
import { MemberIdSchema } from './member.js';

/**
 * Phase 7: what happens after the group decides.
 * - Cook in, match: a shopping list for the recipe (the "sous-chef").
 * - No match: a suggested compromise (the "mediator").
 */

export const MIN_SERVINGS = 1;
export const MAX_SERVINGS = 20;
export const ServingsSchema = z.number().int().min(MIN_SERVINGS).max(MAX_SERVINGS);

/** One recipe ingredient, as the recipe API gave it (unscaled). */
export const RecipeIngredientSchema = z.object({
  name: z.string().min(1).max(120),
  amount: z.number().nonnegative(),
  unit: z.string().max(40),
  aisle: z.string().max(80).nullable(),
});

export type RecipeIngredient = z.infer<typeof RecipeIngredientSchema>;

export const ShoppingLineSchema = z.object({
  /** Stable within a list, so "we have it" survives a servings change. */
  id: z.string().min(1).max(16),
  name: z.string().min(1).max(60),
  aisle: z.string().min(1).max(40),
  /** Computed by code from the ingredients this line covers, e.g. "2 cups + 1 tbsp". */
  quantity: z.string().max(80),
  /** Indexes into the list's `ingredients`. Every ingredient is covered exactly once. */
  covers: z.array(z.number().int().nonnegative()).min(1).max(40),
  /** Salt, oil, water...: shown under "Probably at home", ticked to start with. */
  likelyAtHome: z.boolean(),
  /** "We have it": shared by the whole group. */
  have: z.boolean(),
});

export type ShoppingLine = z.infer<typeof ShoppingLineSchema>;

export const ShoppingListStatusSchema = z.enum(['building', 'ready', 'failed']);

export const ShoppingListSchema = z.object({
  cardId: z.string().min(1).max(64),
  title: z.string().min(1).max(80),
  servings: ServingsSchema,
  /** What the recipe was written for; quantities scale by servings / recipeServings. */
  recipeServings: z.number().int().positive().nullable(),
  status: ShoppingListStatusSchema,
  /** ai: grouped and named by the sous-chef. fallback: one line per ingredient. */
  source: z.enum(['ai', 'fallback']).nullable(),
  createdBy: MemberIdSchema,
  ingredients: z.array(RecipeIngredientSchema).max(60),
  lines: z.array(ShoppingLineSchema).max(60),
  /** Shown when status is 'failed'; safe for clients. */
  error: z.string().max(200).nullable(),
});

export type ShoppingList = z.infer<typeof ShoppingListSchema>;

export const SuggestionSchema = z.object({
  cardId: z.string().min(1).max(64),
  reason: z.string().min(1).max(280),
  source: z.enum(['ai', 'fallback']),
  /** Who tapped "Go with it", or null while it's only a suggestion. */
  acceptedBy: MemberIdSchema.nullable(),
});

export type Suggestion = z.infer<typeof SuggestionSchema>;

// ---- Socket payloads ----

const CardIdSchema = z.string().min(1).max(64);

export const CreateShoppingListSchema = z.object({
  cardId: CardIdSchema,
  servings: ServingsSchema,
});
export type CreateShoppingList = z.infer<typeof CreateShoppingListSchema>;

export const ToggleShoppingLineSchema = z.object({
  cardId: CardIdSchema,
  lineId: z.string().min(1).max(16),
  have: z.boolean(),
});
export type ToggleShoppingLine = z.infer<typeof ToggleShoppingLineSchema>;

export const SetShoppingServingsSchema = CreateShoppingListSchema;
export type SetShoppingServings = CreateShoppingList;

/**
 * Only recipe cards from the recipe API have ingredients. Shared so the button and
 * the server agree on when a list can be made.
 */
export const hasRecipeDetails = (cardId: string) => /^spoonacular:\d+$/.test(cardId);

/** A list can be made for a matched card, or for the compromise the group accepted. */
export function canMakeShoppingList(
  view: { matches: { cardId: string }[]; suggestion: Suggestion | null },
  cardId: string,
): boolean {
  if (!hasRecipeDetails(cardId)) return false;
  if (view.matches.some((m) => m.cardId === cardId)) return true;
  return view.suggestion?.cardId === cardId && view.suggestion.acceptedBy !== null;
}

/** Plain text for "Copy list": what still needs buying, by aisle. */
export function shoppingListText(list: ShoppingList): string {
  const toBuy = list.lines.filter((l) => !l.have);
  const byAisle = new Map<string, ShoppingLine[]>();
  for (const line of toBuy) byAisle.set(line.aisle, [...(byAisle.get(line.aisle) ?? []), line]);
  const sections = [...byAisle].map(
    ([aisle, lines]) =>
      `${aisle}\n${lines.map((l) => `- ${l.quantity ? `${l.quantity} ` : ''}${l.name}`).join('\n')}`,
  );
  return [`${list.title} (serves ${list.servings})`, ...sections].join('\n\n');
}
