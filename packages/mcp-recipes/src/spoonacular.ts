import { z } from 'zod';
import { CardSchema, type Card } from '@yumanimous/shared';

/**
 * Only the fields we use. Unknown fields are ignored, and each recipe is validated
 * on its own, so one odd recipe is skipped instead of failing the whole response.
 */
export const SpoonacularRecipeSchema = z.object({
  id: z.number().int(),
  title: z.string().min(1),
  image: z.string().optional(),
  readyInMinutes: z.number().int().positive().optional(),
  servings: z.number().int().positive().optional(),
  sourceUrl: z.string().nullish(),
  sourceName: z.string().nullish(),
  spoonacularSourceUrl: z.string().nullish(),
  license: z.string().nullish(),
  vegetarian: z.boolean().default(false),
  vegan: z.boolean().default(false),
  glutenFree: z.boolean().default(false),
  dairyFree: z.boolean().default(false),
  cuisines: z.array(z.string()).default([]),
  dishTypes: z.array(z.string()).default([]),
  diets: z.array(z.string()).default([]),
});

export type SpoonacularRecipe = z.infer<typeof SpoonacularRecipeSchema>;

/** /recipes/{id}/information adds ingredients and steps on top of the search fields. */
export const SpoonacularRecipeDetailsSchema = SpoonacularRecipeSchema.extend({
  extendedIngredients: z
    .array(
      z.object({
        name: z.string(),
        original: z.string(),
        amount: z.number(),
        unit: z.string(),
        aisle: z.string().nullish(),
      }),
    )
    .default([]),
  analyzedInstructions: z
    .array(
      z.object({
        name: z.string().default(''),
        steps: z.array(
          z.object({
            number: z.number().int(),
            step: z.string(),
            ingredients: z.array(z.object({ name: z.string() })).default([]),
            equipment: z.array(z.object({ name: z.string() })).default([]),
          }),
        ),
      }),
    )
    .default([]),
});

export type SpoonacularRecipeDetails = z.infer<typeof SpoonacularRecipeDetailsSchema>;

const SearchResponseSchema = z.object({ results: z.array(z.unknown()) });

// Allowed filter values, straight from Spoonacular's docs. Enums (not free text) so a
// model can only ask for filters the API understands.
export const DIETS = [
  'gluten free',
  'ketogenic',
  'vegetarian',
  'lacto-vegetarian',
  'ovo-vegetarian',
  'vegan',
  'pescetarian',
  'paleo',
  'primal',
  'low fodmap',
  'whole30',
] as const;

export const INTOLERANCES = [
  'dairy',
  'egg',
  'gluten',
  'grain',
  'peanut',
  'seafood',
  'sesame',
  'shellfish',
  'soy',
  'sulfite',
  'tree nut',
  'wheat',
] as const;

export const CUISINES = [
  'African',
  'American',
  'Asian',
  'British',
  'Cajun',
  'Caribbean',
  'Chinese',
  'Eastern European',
  'European',
  'French',
  'German',
  'Greek',
  'Indian',
  'Irish',
  'Italian',
  'Japanese',
  'Jewish',
  'Korean',
  'Latin American',
  'Mediterranean',
  'Mexican',
  'Middle Eastern',
  'Nordic',
  'Southern',
  'Spanish',
  'Thai',
  'Vietnamese',
] as const;

export const MEAL_TYPES = [
  'main course',
  'side dish',
  'dessert',
  'appetizer',
  'salad',
  'bread',
  'breakfast',
  'soup',
  'beverage',
  'sauce',
  'marinade',
  'fingerfood',
  'snack',
  'drink',
] as const;

/**
 * Search filters. This one schema is both the client's input and the
 * `search_recipes` MCP tool's input, so the tool can't accept anything the client
 * wouldn't send. `.describe()` texts are what the model reads.
 */
export const RecipeSearchSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe('Free-text dish search, e.g. "pasta" or "chicken curry".'),
  cuisine: z.enum(CUISINES).optional(),
  diets: z
    .array(z.enum(DIETS))
    .max(4)
    .optional()
    .describe('Every listed diet must be satisfied (AND). Use for hard dietary rules.'),
  intolerances: z
    .array(z.enum(INTOLERANCES))
    .max(12)
    .optional()
    .describe('Recipes containing any of these are excluded.'),
  maxReadyMinutes: z.number().int().min(5).max(600).optional(),
  type: z.enum(MEAL_TYPES).default('main course'),
  count: z.number().int().min(1).max(20).default(10).describe('How many recipes (1-20).'),
});

export type RecipeSearch = z.input<typeof RecipeSearchSchema>;

/** Spoonacular bills in "points" per request; it reports usage in response headers. */
export interface QuotaUsage {
  request: number | null;
  used: number | null;
  left: number | null;
}

export class RecipeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RecipeApiError';
  }
}

export interface SpoonacularClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Plain HTTP client, used by the API's deck source and by the MCP tools. */
export class SpoonacularClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor({
    apiKey,
    baseUrl = 'https://api.spoonacular.com',
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = 10_000,
  }: SpoonacularClientOptions) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /** Filtered search with full recipe info (diet flags, timing, credits). */
  async searchRecipes(
    search: RecipeSearch,
  ): Promise<{ recipes: SpoonacularRecipe[]; quota: QuotaUsage }> {
    const f = RecipeSearchSchema.parse(search);
    const params = new URLSearchParams({
      type: f.type,
      sort: 'popularity',
      number: String(f.count),
      addRecipeInformation: 'true',
      instructionsRequired: 'true',
    });
    if (f.query) params.set('query', f.query);
    if (f.cuisine) params.set('cuisine', f.cuisine);
    // Spoonacular reads a comma as AND for diets and as "exclude any" for intolerances.
    if (f.diets?.length) params.set('diet', f.diets.join(','));
    if (f.intolerances?.length) params.set('intolerances', f.intolerances.join(','));
    if (f.maxReadyMinutes) params.set('maxReadyTime', String(f.maxReadyMinutes));

    const { body, quota } = await this.get(`/recipes/complexSearch?${params}`);
    const results = SearchResponseSchema.parse(body).results;
    const recipes = results.flatMap((raw) => {
      const parsed = SpoonacularRecipeSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
    return { recipes, quota };
  }

  /** Popular main courses: the deck source's pool. */
  searchMainCourses(count: number) {
    return this.searchRecipes({ type: 'main course', count });
  }

  /** One recipe with ingredients and steps (about 1 quota point). */
  async getRecipe(
    recipeId: number,
  ): Promise<{ recipe: SpoonacularRecipeDetails; quota: QuotaUsage }> {
    const { body, quota } = await this.get(
      `/recipes/${encodeURIComponent(recipeId)}/information?includeNutrition=false`,
    );
    return { recipe: SpoonacularRecipeDetailsSchema.parse(body), quota };
  }

  private async get(path: string): Promise<{ body: unknown; quota: QuotaUsage }> {
    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        // Header, not a query parameter, so the key never ends up in URL logs.
        headers: { 'x-api-key': this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RecipeApiError(0, `Recipe API unreachable: ${(err as Error).message}`);
    }
    // 402 = daily quota used up, 401 = bad key, 404 = no such recipe.
    if (!res.ok) throw new RecipeApiError(res.status, `Recipe API responded ${res.status}`);
    return { body: await res.json(), quota: readQuota(res.headers) };
  }
}

function readQuota(headers: Headers): QuotaUsage {
  const num = (name: string) => {
    const value = Number.parseFloat(headers.get(name) ?? '');
    return Number.isFinite(value) ? value : null;
  };
  return {
    request: num('x-api-quota-request'),
    used: num('x-api-quota-used'),
    left: num('x-api-quota-left'),
  };
}

/** Facts kept next to each card for later phases (diet filters are hard rules in Phase 5). */
export const RecipeFactsSchema = z.object({
  vegetarian: z.boolean(),
  vegan: z.boolean(),
  glutenFree: z.boolean(),
  dairyFree: z.boolean(),
  diets: z.array(z.string()),
  cuisines: z.array(z.string()),
  readyInMinutes: z.number().int().nullable(),
  servings: z.number().int().nullable(),
  license: z.string().nullable(),
});

export type RecipeFacts = z.infer<typeof RecipeFactsSchema>;

export interface MappedRecipe {
  card: Card;
  facts: RecipeFacts;
}

const https = (url: string | null | undefined) =>
  url && url.startsWith('https://') ? url : undefined;

/** 25 -> "25 min", 90 -> "1 h 30 min", 120 -> "2 h". Slow-cooker recipes run to hours. */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/**
 * Spoonacular recipe -> our Card. Returns null if the result can't satisfy
 * CardSchema (e.g. no usable title), so bad data never reaches a deck.
 */
export function toCard(recipe: SpoonacularRecipe): MappedRecipe | null {
  const cuisine = recipe.cuisines[0];
  const minutes = recipe.readyInMinutes;

  // Search results carry a small 312x231 image; the same photo exists at 636x393,
  // which stays sharp on a phone-width card.
  const image = https(recipe.image)?.replace(/-\d+x\d+\.(\w+)$/, '-636x393.$1');
  const creditUrl = https(recipe.sourceUrl) ?? https(recipe.spoonacularSourceUrl);

  let dietTag: string | undefined;
  if (recipe.vegan) dietTag = 'vegan';
  else if (recipe.vegetarian) dietTag = 'vegetarian';
  else if (recipe.glutenFree) dietTag = 'gluten-free';

  const tags = [
    dietTag,
    minutes && formatDuration(minutes),
    cuisine && truncate(cuisine, 24),
  ].filter((t): t is string => Boolean(t));

  // Template text until the writer agent (Phase 6) writes proper blurbs.
  const what = [cuisine, recipe.dishTypes.includes('main course') ? 'main course' : 'dish']
    .filter(Boolean)
    .join(' ');
  const timing = minutes ? ` ready in ${formatDuration(minutes)}` : '';
  const serves = recipe.servings ? ` Serves ${recipe.servings}.` : '';
  const blurb = `${what.charAt(0).toUpperCase()}${what.slice(1)}${timing}.${serves}`;

  const card = CardSchema.safeParse({
    id: `spoonacular:${recipe.id}`,
    title: truncate(recipe.title, 80),
    imageUrl: image,
    imageAlt: image ? truncate(recipe.title, 160) : undefined,
    imageCredit: creditUrl
      ? { name: truncate(recipe.sourceName || 'Spoonacular', 80), url: creditUrl }
      : undefined,
    tags,
    blurb: truncate(blurb, 160),
  });
  if (!card.success) return null;

  return {
    card: card.data,
    facts: {
      vegetarian: recipe.vegetarian,
      vegan: recipe.vegan,
      glutenFree: recipe.glutenFree,
      dairyFree: recipe.dairyFree,
      diets: recipe.diets,
      cuisines: recipe.cuisines,
      readyInMinutes: minutes ?? null,
      servings: recipe.servings ?? null,
      license: recipe.license ?? null,
    },
  };
}
