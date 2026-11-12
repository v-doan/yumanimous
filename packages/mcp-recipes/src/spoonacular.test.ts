import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CardSchema } from '@yumanimous/shared';
import {
  RecipeApiError,
  SpoonacularRecipeSchema,
  SpoonacularClient,
  formatDuration,
  toCard,
  type SpoonacularRecipe,
} from './spoonacular.js';

/** A real response (trimmed to 6 recipes) recorded once, so tests never hit the API. */
const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/complexSearch.json', import.meta.url), 'utf8'),
);

const okResponse = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

describe('SpoonacularClient', () => {
  it('sends the key as a header and parses recipes and quota', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        okResponse(fixture, { 'X-API-Quota-Request': '4.0', 'X-API-Quota-Left': '44.82' }),
      );
    const client = new SpoonacularClient({ apiKey: 'test-key', fetch });

    const { recipes, quota } = await client.searchMainCourses(6);

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toContain('/recipes/complexSearch?');
    expect(url).toContain('number=6');
    expect(url).not.toContain('test-key'); // Never in the URL (and so never in logs).
    expect(init.headers).toEqual({ 'x-api-key': 'test-key' });
    expect(recipes).toHaveLength(6);
    expect(quota).toEqual({ request: 4, used: null, left: 44.82 });
  });

  it('skips individual malformed recipes instead of failing the whole response', async () => {
    const body = { results: [fixture.results[0], { id: 'not-a-number' }] };
    const client = new SpoonacularClient({
      apiKey: 'k',
      fetch: vi.fn().mockResolvedValue(okResponse(body)),
    });
    expect((await client.searchMainCourses(2)).recipes).toHaveLength(1);
  });

  // Regression: the deck source's 50-recipe pool must not hit the MCP tool's 20 cap.
  it('allows large pools for the deck source and sends excluded ingredients', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request) => okResponse(fixture)); // A fresh body per call.
    const client = new SpoonacularClient({ apiKey: 'k', fetch });
    await client.searchMainCourses(50);
    await client.searchRecipes({ excludeIngredients: ['kiwi', 'pork'], count: 30 });
    expect(new URL(String(fetch.mock.calls[0]![0])).searchParams.get('number')).toBe('50');
    expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.get('excludeIngredients')).toBe(
      'kiwi,pork',
    );
  });

  it('throws RecipeApiError with the status when the quota is used up', async () => {
    const client = new SpoonacularClient({
      apiKey: 'k',
      fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 402 })),
    });
    await expect(client.searchMainCourses(10)).rejects.toMatchObject({
      name: 'RecipeApiError',
      status: 402,
    });
  });

  it('throws RecipeApiError when the network fails', async () => {
    const client = new SpoonacularClient({
      apiKey: 'k',
      fetch: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    });
    await expect(client.searchMainCourses(10)).rejects.toBeInstanceOf(RecipeApiError);
  });
});

describe('toCard', () => {
  const recipes = fixture.results as SpoonacularRecipe[];
  // Through the real schema, so defaults (empty arrays, false flags) apply as in production.
  const parse = (r: object) => toCard(SpoonacularRecipeSchema.parse(r));

  it('maps every fixture recipe to a valid card', () => {
    for (const recipe of recipes) {
      const mapped = parse(recipe);
      expect(mapped).not.toBeNull();
      expect(CardSchema.safeParse(mapped!.card).success).toBe(true);
    }
  });

  it('namespaces ids, upsizes images and keeps diet facts', () => {
    const mapped = parse({
      id: 1,
      title: 'Tofu Bowl',
      image: 'https://img.spoonacular.com/recipes/1-312x231.jpg',
      readyInMinutes: 25,
      servings: 2,
      vegan: true,
      vegetarian: true,
      glutenFree: true,
      dairyFree: true,
      cuisines: ['Asian'],
      dishTypes: ['main course'],
      sourceUrl: 'https://example.com/tofu',
      sourceName: 'Example Kitchen',
    })!;
    expect(mapped.card).toMatchObject({
      id: 'spoonacular:1',
      imageUrl: 'https://img.spoonacular.com/recipes/1-636x393.jpg',
      tags: ['vegan', '25 min', 'Asian'],
      blurb: 'Asian main course ready in 25 min. Serves 2.',
      imageCredit: { name: 'Example Kitchen', url: 'https://example.com/tofu' },
    });
    expect(mapped.facts).toMatchObject({ vegan: true, glutenFree: true, readyInMinutes: 25 });
  });

  it('credits Spoonacular’s https page when the source link is plain http', () => {
    const mapped = parse({
      id: 2,
      title: 'Stew',
      sourceUrl: 'http://insecure.example.com/stew',
      sourceName: 'Old Blog',
      spoonacularSourceUrl: 'https://spoonacular.com/stew-2',
    })!;
    expect(mapped.card.imageCredit?.url).toBe('https://spoonacular.com/stew-2');
  });

  it('leaves out images that are not https (the UI shows a placeholder)', () => {
    const mapped = parse({ id: 3, title: 'Soup', image: 'http://img.example.com/3.jpg' })!;
    expect(mapped.card.imageUrl).toBeUndefined();
  });

  it('truncates very long titles to fit the card', () => {
    const mapped = parse({ id: 4, title: 'Very '.repeat(30) + 'Long Pie' })!;
    expect(mapped.card.title.length).toBeLessThanOrEqual(80);
    expect(mapped.card.title.endsWith('…')).toBe(true);
  });
});

describe('formatDuration', () => {
  it.each([
    [25, '25 min'],
    [60, '1 h'],
    [90, '1 h 30 min'],
    [370, '6 h 10 min'],
  ])('%i -> %s', (minutes, text) => {
    expect(formatDuration(minutes)).toBe(text);
  });
});
