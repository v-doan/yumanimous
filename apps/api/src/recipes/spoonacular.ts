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

const SearchResponseSchema = z.object({ results: z.array(z.unknown()) });

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

/** Plain HTTP client. Phase 4 wraps the same calls in the `mcp-recipes` server. */
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

  /** Popular main courses with full recipe info (diet flags, timing, credits). */
  async searchMainCourses(
    count: number,
  ): Promise<{ recipes: SpoonacularRecipe[]; quota: QuotaUsage }> {
    const params = new URLSearchParams({
      type: 'main course',
      sort: 'popularity',
      number: String(count),
      addRecipeInformation: 'true',
      instructionsRequired: 'true',
    });

    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}/recipes/complexSearch?${params}`, {
        // Header, not a query parameter, so the key never ends up in URL logs.
        headers: { 'x-api-key': this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RecipeApiError(0, `Recipe API unreachable: ${(err as Error).message}`);
    }
    // 402 = daily quota used up, 401 = bad key. Callers fall back either way.
    if (!res.ok) throw new RecipeApiError(res.status, `Recipe API responded ${res.status}`);

    const body = SearchResponseSchema.parse(await res.json());
    const recipes = body.results.flatMap((raw) => {
      const parsed = SpoonacularRecipeSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
    return { recipes, quota: readQuota(res.headers) };
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
export interface RecipeFacts {
  vegetarian: boolean;
  vegan: boolean;
  glutenFree: boolean;
  dairyFree: boolean;
  diets: string[];
  cuisines: string[];
  readyInMinutes: number | null;
  servings: number | null;
  license: string | null;
}

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
