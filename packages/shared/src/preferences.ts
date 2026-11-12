import { z } from 'zod';
import {
  CRAVINGS,
  CUISINES,
  DIETS,
  INTOLERANCES,
  UNSUPPORTED_RULES,
  type Diet,
  type Intolerance,
} from './food.js';

/** An ingredient someone avoids. Lowercase words only, so it's safe in a search query. */
export const IngredientNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z ]{1,29}$/, 'Ingredients are 2-30 letters');

/**
 * One member's food rules, after they confirmed the parsed chips. Everything is an
 * enum or a tightly validated short string: there's no free text a later agent
 * could mistake for an instruction.
 *
 * Hard rules filter the whole group's deck; soft ones only nudge the ranking.
 */
export const MemberPreferencesSchema = z.object({
  // ---- hard ----
  diets: z.array(z.enum(DIETS)).max(6).default([]),
  intolerances: z.array(z.enum(INTOLERANCES)).max(12).default([]),
  /**
   * "cannot-eat" is hard (allergy, religion, ethics: excluded from the search);
   * "dislike" is soft (ranked down).
   */
  avoidIngredients: z
    .array(
      z.object({
        name: IngredientNameSchema,
        reason: z.enum(['cannot-eat', 'dislike']),
      }),
    )
    .max(10)
    .default([]),
  /** Hard: the person can't cook or wait longer than this. */
  maxReadyMinutes: z.number().int().min(5).max(600).nullable().default(null),
  // ---- soft ----
  cuisinesLiked: z.array(z.enum(CUISINES)).max(10).default([]),
  cuisinesDisliked: z.array(z.enum(CUISINES)).max(10).default([]),
  cravings: z.array(z.enum(CRAVINGS)).max(9).default([]),
  // ---- stated but not filterable ----
  unsupported: z.array(z.enum(UNSUPPORTED_RULES)).max(7).default([]),
});

export type MemberPreferences = z.infer<typeof MemberPreferencesSchema>;

export const emptyPreferences = (): MemberPreferences => MemberPreferencesSchema.parse({});

/** What the deck search must satisfy. Every member's hard rules, combined. */
export const HardFiltersSchema = z.object({
  diets: z.array(z.enum(DIETS)),
  intolerances: z.array(z.enum(INTOLERANCES)),
  excludeIngredients: z.array(IngredientNameSchema),
  maxReadyMinutes: z.number().int().nullable(),
});

export type HardFilters = z.infer<typeof HardFiltersSchema>;

/** A rule plus who stated it, for messages like "Sam: halal (not filtered)". */
export const AttributedRuleSchema = z.object({
  rule: z.string(),
  members: z.array(z.string()),
});

export type AttributedRule = z.infer<typeof AttributedRuleSchema>;

export interface GroupPreferences {
  hard: HardFilters;
  soft: {
    /** +1 per member who likes a cuisine, -1 per member who dislikes it. */
    cuisineScores: Record<string, number>;
    dislikedIngredients: string[];
    cravings: string[];
  };
  /** Rules nobody can filter for, with who asked. */
  unsupported: AttributedRule[];
}

// A vegan dish is also vegetarian, lacto- and ovo-vegetarian and pescetarian, so the
// weaker diets add nothing to the search once a stronger one is present.
const IMPLIED_BY: Partial<Record<Diet, Diet[]>> = {
  vegan: ['vegetarian', 'lacto-vegetarian', 'ovo-vegetarian', 'pescetarian'],
  vegetarian: ['pescetarian'],
  'lacto-vegetarian': ['pescetarian'],
  'ovo-vegetarian': ['pescetarian'],
};

// A gluten-free diet already excludes the gluten intolerance's recipes.
const DIET_COVERS_INTOLERANCE: Partial<Record<Diet, Intolerance[]>> = {
  'gluten free': ['gluten'],
};

const sorted = <T extends string>(values: Iterable<T>) => [...new Set(values)].sort();

/**
 * Combines every member's rules. Pure: same members in, same filters out.
 *
 * Hard rules are unions: if anyone is vegan, the deck is vegan; if anyone is allergic
 * to peanuts, there are no peanuts. Dietary restrictions from ANY member constrain the
 * whole group, never just that member. The time limit is the smallest one stated.
 */
export function mergePreferences(
  members: { name: string; preferences: MemberPreferences | null }[],
): GroupPreferences {
  const withPrefs = members.filter(
    (m): m is { name: string; preferences: MemberPreferences } => m.preferences !== null,
  );
  const all = withPrefs.map((m) => m.preferences);

  const diets = new Set(all.flatMap((p) => p.diets));
  for (const diet of [...diets]) {
    for (const weaker of IMPLIED_BY[diet] ?? []) diets.delete(weaker);
  }

  const intolerances = new Set(all.flatMap((p) => p.intolerances));
  for (const diet of diets) {
    for (const covered of DIET_COVERS_INTOLERANCE[diet] ?? []) intolerances.delete(covered);
  }

  const limits = all.map((p) => p.maxReadyMinutes).filter((m): m is number => m !== null);
  const allergies = all.flatMap((p) =>
    p.avoidIngredients.filter((a) => a.reason === 'cannot-eat').map((a) => a.name),
  );
  const dislikes = all.flatMap((p) =>
    p.avoidIngredients.filter((a) => a.reason === 'dislike').map((a) => a.name),
  );

  const cuisineScores: Record<string, number> = {};
  for (const p of all) {
    for (const c of p.cuisinesLiked) cuisineScores[c] = (cuisineScores[c] ?? 0) + 1;
    for (const c of p.cuisinesDisliked) cuisineScores[c] = (cuisineScores[c] ?? 0) - 1;
  }

  const unsupported = new Map<string, string[]>();
  for (const m of withPrefs) {
    for (const rule of m.preferences.unsupported) {
      unsupported.set(rule, [...(unsupported.get(rule) ?? []), m.name]);
    }
  }

  return {
    hard: {
      diets: sorted(diets),
      intolerances: sorted(intolerances),
      excludeIngredients: sorted(allergies),
      maxReadyMinutes: limits.length ? Math.min(...limits) : null,
    },
    soft: {
      cuisineScores,
      // An ingredient someone can't eat is already excluded; no need to rank it down.
      dislikedIngredients: sorted(dislikes.filter((d) => !allergies.includes(d))),
      cravings: sorted(all.flatMap((p) => p.cravings)),
    },
    unsupported: [...unsupported].map(([rule, names]) => ({ rule, members: names })),
  };
}

export const hasHardFilters = (h: HardFilters) =>
  h.diets.length > 0 ||
  h.intolerances.length > 0 ||
  h.excludeIngredients.length > 0 ||
  h.maxReadyMinutes !== null;

/**
 * Hard rules in `wanted` that a deck built with `deckFilters` does not guarantee.
 * Used when someone joins after the start: "this deck wasn't checked for peanuts".
 */
export function uncoveredRules(wanted: HardFilters, deckFilters: HardFilters): string[] {
  // A diet is covered if the deck has it, or a stronger diet that implies it.
  const deckDiets = new Set<string>(deckFilters.diets);
  for (const diet of deckFilters.diets) {
    for (const implied of IMPLIED_BY[diet] ?? []) deckDiets.add(implied);
  }
  const deckIntolerances = new Set<string>(deckFilters.intolerances);
  for (const diet of deckFilters.diets) {
    for (const covered of DIET_COVERS_INTOLERANCE[diet] ?? []) deckIntolerances.add(covered);
  }

  const missing = [
    ...wanted.diets.filter((d) => !deckDiets.has(d)),
    ...wanted.intolerances.filter((i) => !deckIntolerances.has(i)).map((i) => `no ${i}`),
    ...wanted.excludeIngredients
      .filter((i) => !deckFilters.excludeIngredients.includes(i))
      .map((i) => `no ${i}`),
  ];
  if (
    wanted.maxReadyMinutes !== null &&
    (deckFilters.maxReadyMinutes === null || deckFilters.maxReadyMinutes > wanted.maxReadyMinutes)
  ) {
    missing.push(`under ${wanted.maxReadyMinutes} min`);
  }
  return missing;
}

/** "vegan · no peanut · under 30 min", for chips and banners. */
export function describeHardFilters(h: HardFilters): string[] {
  return [
    ...h.diets,
    ...h.intolerances.map((i) => `no ${i}`),
    ...h.excludeIngredients.map((i) => `no ${i}`),
    ...(h.maxReadyMinutes !== null ? [`under ${h.maxReadyMinutes} min`] : []),
  ];
}
