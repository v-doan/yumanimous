import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryApiCache } from '@yumanimous/db';
import { createRecipesServer, RecipeDetailsSchema, RecipeResultSchema } from './server.js';
import { RecipeApiError, SpoonacularClient } from './spoonacular.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'));
const searchFixture = fixture('complexSearch.json');
const recipeFixture = fixture('recipeInformation.json');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-API-Quota-Request': '1' },
  });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let client: Client;
let clock: number;

/** A real MCP client talking to the server over an in-memory transport pair. */
async function connect(withApiKey = true) {
  clock = 0;
  const server = createRecipesServer({
    client: withApiKey ? new SpoonacularClient({ apiKey: 'test-key', fetch: fetchMock }) : null,
    cache: new InMemoryApiCache(() => clock),
    log: () => {},
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

const call = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
});

afterEach(async () => {
  await client?.close();
});

describe('tool listing', () => {
  it('exposes exactly the two read-only tools, with input and output schemas', async () => {
    await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_recipe', 'search_recipes']);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.outputSchema).toBeDefined();
    }
    const search = tools.find((t) => t.name === 'search_recipes')!;
    // Enums reach the model as JSON Schema, so it can only pick supported diets.
    expect(JSON.stringify(search.inputSchema)).toContain('"gluten free"');
  });
});

describe('search_recipes', () => {
  it('maps filters to API parameters and returns validated cards', async () => {
    fetchMock.mockResolvedValue(json(searchFixture));
    await connect();

    const res = await call('search_recipes', {
      query: 'chicken',
      diets: ['gluten free', 'paleo'],
      intolerances: ['peanut', 'shellfish'],
      maxReadyMinutes: 45,
      count: 6,
    });

    expect(res.isError).toBeFalsy();
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      query: 'chicken',
      diet: 'gluten free,paleo',
      intolerances: 'peanut,shellfish',
      maxReadyTime: '45',
      number: '6',
      type: 'main course',
    });
    const out = res.structuredContent as { recipes: unknown[]; cached: boolean };
    expect(out.cached).toBe(false);
    expect(out.recipes).toHaveLength(6);
    for (const r of out.recipes) expect(RecipeResultSchema.safeParse(r).success).toBe(true);
  });

  it('serves a repeated search from the cache, in any filter order', async () => {
    fetchMock.mockResolvedValue(json(searchFixture));
    await connect();
    await call('search_recipes', { intolerances: ['peanut', 'egg'], cuisine: 'Thai' });
    const again = await call('search_recipes', {
      cuisine: 'Thai',
      intolerances: ['egg', 'peanut'],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect((again.structuredContent as { cached: boolean }).cached).toBe(true);
  });

  it('rejects filters the API does not support before calling it', async () => {
    await connect();
    const res = await call('search_recipes', { diets: ['carnivore'] });
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps the number of results at 20', async () => {
    await connect();
    const res = await call('search_recipes', { count: 500 });
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explains a used-up quota as a readable tool error', async () => {
    fetchMock.mockResolvedValue(json({}, 402));
    await connect();
    const res = await call('search_recipes', { query: 'soup' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('quota is used up');
  });

  it('falls back to a stale cached result when the API fails', async () => {
    fetchMock.mockResolvedValueOnce(json(searchFixture));
    await connect();
    await call('search_recipes', { query: 'soup' });

    clock = 30 * 24 * 60 * 60_000; // A month later: the entry is stale.
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const res = await call('search_recipes', { query: 'soup' });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { cached: boolean }).cached).toBe(true);
  });

  it('says so when no API key is configured', async () => {
    await connect(false);
    const res = await call('search_recipes', { query: 'soup' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('No recipe API key');
  });
});

describe('get_recipe', () => {
  it('returns ingredients with aisles and continuously numbered steps', async () => {
    fetchMock.mockResolvedValue(json(recipeFixture));
    await connect();

    const res = await call('get_recipe', { recipeId: recipeFixture.id });
    expect(fetchMock.mock.calls[0]![0]).toContain(`/recipes/${recipeFixture.id}/information`);

    const { recipe } = res.structuredContent as { recipe: unknown };
    const details = RecipeDetailsSchema.parse(recipe);
    expect(details.cardId).toBe(`spoonacular:${recipeFixture.id}`);
    expect(details.ingredients.length).toBe(recipeFixture.extendedIngredients.length);
    expect(details.ingredients[0]).toMatchObject({ name: 'bell pepper', aisle: 'Produce' });
    expect(details.steps.map((s) => s.number)).toEqual(details.steps.map((_, i) => i + 1));
  });

  it('caches recipe details', async () => {
    fetchMock.mockResolvedValue(json(recipeFixture));
    await connect();
    await call('get_recipe', { recipeId: 1 });
    await call('get_recipe', { recipeId: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reports an unknown recipe as a tool error', async () => {
    fetchMock.mockResolvedValue(json({}, 404));
    await connect();
    const res = await call('get_recipe', { recipeId: 999_999 });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('No recipe with that id');
  });

  it('rejects ids that are not positive integers', async () => {
    await connect();
    expect((await call('get_recipe', { recipeId: -5 })).isError).toBe(true);
    expect((await call('get_recipe', { recipeId: '../admin' })).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('RecipeApiError', () => {
  it('keeps the HTTP status', () => {
    expect(new RecipeApiError(402, 'x').status).toBe(402);
  });
});
