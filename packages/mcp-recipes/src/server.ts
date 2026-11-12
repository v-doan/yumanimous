import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CardSchema } from '@yumanimous/shared';
import type { ApiCache } from '@yumanimous/db';
import {
  RecipeApiError,
  RecipeFactsSchema,
  RecipeSearchSchema,
  toCard,
  type QuotaUsage,
  type SpoonacularClient,
  type SpoonacularRecipeDetails,
} from './spoonacular.js';

const DAY = 24 * 60 * 60_000;
const SEARCH_TTL_MS = 7 * DAY;
const RECIPE_TTL_MS = 30 * DAY;

// ---- Tool output shapes. Declared as schemas so clients can validate results. ----

export const RecipeResultSchema = z.object({
  recipeId: z.number().int(),
  card: CardSchema,
  facts: RecipeFactsSchema,
});

const SearchOutputSchema = z.object({
  recipes: z.array(RecipeResultSchema),
  /** True when served from the cache (no quota spent). */
  cached: z.boolean(),
});

export const RecipeDetailsSchema = z.object({
  recipeId: z.number().int(),
  cardId: z.string(),
  title: z.string(),
  servings: z.number().int().nullable(),
  readyInMinutes: z.number().int().nullable(),
  facts: RecipeFactsSchema,
  ingredients: z.array(
    z.object({
      name: z.string(),
      amount: z.number(),
      unit: z.string(),
      /** As written in the recipe, e.g. "2 cloves garlic, minced". */
      original: z.string(),
      /** Supermarket aisle; groups the shopping list in Phase 7. */
      aisle: z.string().nullable(),
    }),
  ),
  steps: z.array(
    z.object({
      number: z.number().int(),
      text: z.string(),
      ingredients: z.array(z.string()),
      equipment: z.array(z.string()),
    }),
  ),
  sourceUrl: z.string().nullable(),
});

export type RecipeDetails = z.infer<typeof RecipeDetailsSchema>;

const GetRecipeOutputSchema = z.object({ recipe: RecipeDetailsSchema, cached: z.boolean() });

/**
 * The tool's input: the client's filters, with a lower result cap. A model asking
 * for 100 recipes would burn quota and context for no benefit.
 */
const ToolSearchSchema = RecipeSearchSchema.extend({
  count: z.number().int().min(1).max(20).default(10).describe('How many recipes (1-20).'),
});

export interface RecipesServerDeps {
  /** null when no API key is configured: cached results still work. */
  client: SpoonacularClient | null;
  cache: ApiCache;
  /** stdio servers must never write to stdout (it's the protocol stream). */
  log?: (message: string) => void;
}

/**
 * The recipes MCP server, independent of transport. `stdio.ts` serves it to Claude
 * Desktop / Claude Code; Phase 6's orchestrator can connect to it in-process.
 */
export function createRecipesServer({ client, cache, log = console.error }: RecipesServerDeps) {
  const server = new McpServer({ name: 'yumanimous-recipes', version: '0.1.0' });

  server.registerTool(
    'search_recipes',
    {
      title: 'Search recipes',
      description:
        'Find recipes that fit the given filters. Dietary restrictions go in `diets` and ' +
        '`intolerances`: those are hard filters applied by the recipe API, not suggestions. ' +
        'Results are cached for a week, so repeating a search is free.',
      inputSchema: ToolSearchSchema.shape,
      outputSchema: SearchOutputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const search = ToolSearchSchema.parse(input);
      return cached(
        `spoonacular:search:v1:${stableKey(search)}`,
        SEARCH_TTL_MS,
        z.array(RecipeResultSchema),
        async () => {
          const { recipes, quota } = await requireClient().searchRecipes(search);
          logQuota('search_recipes', quota);
          return recipes.flatMap((r) => {
            const mapped = toCard(r);
            return mapped ? [{ recipeId: r.id, ...mapped }] : [];
          });
        },
        (recipes, wasCached) => ({ recipes, cached: wasCached }),
      );
    },
  );

  server.registerTool(
    'get_recipe',
    {
      title: 'Get recipe details',
      description:
        'Full ingredients (with amounts and supermarket aisle) and numbered steps for one ' +
        'recipe. Use the `recipeId` from search results; deck card ids look like ' +
        '"spoonacular:<recipeId>".',
      inputSchema: { recipeId: z.number().int().positive() },
      outputSchema: GetRecipeOutputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ recipeId }) =>
      cached(
        `spoonacular:recipe:v1:${recipeId}`,
        RECIPE_TTL_MS,
        RecipeDetailsSchema,
        async () => {
          const { recipe, quota } = await requireClient().getRecipe(recipeId);
          logQuota('get_recipe', quota);
          return toDetails(recipe);
        },
        (recipe, wasCached) => ({ recipe, cached: wasCached }),
      ),
  );

  /**
   * Cache-first wrapper shared by both tools. Fresh entry -> no API call. Otherwise
   * call the API; if that fails, a stale entry still beats an error.
   */
  async function cached<T, O extends Record<string, unknown>>(
    key: string,
    ttlMs: number,
    schema: z.ZodType<T>,
    fetchFresh: () => Promise<T>,
    toOutput: (value: T, wasCached: boolean) => O,
  ): Promise<CallToolResult> {
    const entry = await cache.get(key);
    const hit = entry && schema.safeParse(entry.value); // Cached JSON is re-validated.
    if (entry?.fresh && hit?.success) return result(toOutput(hit.data, true));

    try {
      const value = await fetchFresh();
      await cache.set(key, value, ttlMs);
      return result(toOutput(value, false));
    } catch (err) {
      if (hit?.success) return result(toOutput(hit.data, true));
      return toolError(err);
    }
  }

  function requireClient(): SpoonacularClient {
    if (!client) throw new RecipeApiError(0, 'No recipe API key configured');
    return client;
  }

  function logQuota(tool: string, quota: QuotaUsage) {
    log(`[mcp-recipes] ${tool}: ${quota.request} points, ${quota.left} left today`);
  }

  return server;
}

/** Same filters in any order -> same cache key. */
function stableKey(value: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
  return JSON.stringify(sorted);
}

/**
 * Structured output for clients that validate it, plus the same JSON as text for
 * clients that only read text. Untrusted strings (titles, ingredient names) stay
 * inside JSON values, never spliced into prose.
 */
function result(output: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

/** Tool errors are results the model can read and react to, not protocol failures. */
function toolError(err: unknown): CallToolResult {
  let message = 'Recipe lookup failed';
  if (err instanceof RecipeApiError) {
    if (err.status === 402) message = 'Recipe API daily quota is used up; try again tomorrow';
    else if (err.status === 404) message = 'No recipe with that id';
    else message = err.message;
  }
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function toDetails(recipe: SpoonacularRecipeDetails): RecipeDetails {
  const mapped = toCard(recipe);
  return {
    recipeId: recipe.id,
    cardId: `spoonacular:${recipe.id}`,
    title: recipe.title,
    servings: recipe.servings ?? null,
    readyInMinutes: recipe.readyInMinutes ?? null,
    facts: mapped?.facts ?? {
      vegetarian: recipe.vegetarian,
      vegan: recipe.vegan,
      glutenFree: recipe.glutenFree,
      dairyFree: recipe.dairyFree,
      diets: recipe.diets,
      cuisines: recipe.cuisines,
      readyInMinutes: recipe.readyInMinutes ?? null,
      servings: recipe.servings ?? null,
      license: recipe.license ?? null,
    },
    ingredients: recipe.extendedIngredients.map((i) => ({
      name: i.name,
      amount: i.amount,
      unit: i.unit,
      original: i.original,
      aisle: i.aisle ?? null,
    })),
    // Recipes can have several instruction groups ("For the sauce"); number them
    // continuously so the sous-chef can split one list of steps.
    steps: recipe.analyzedInstructions
      .flatMap((group) => group.steps)
      .map((step, index) => ({
        number: index + 1,
        text: step.step,
        ingredients: step.ingredients.map((i) => i.name),
        equipment: step.equipment.map((e) => e.name),
      })),
    sourceUrl: recipe.sourceUrl ?? recipe.spoonacularSourceUrl ?? null,
  };
}
