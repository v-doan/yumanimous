import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '@yumanimous/shared';
import { InMemoryApiCache, type CardCatalog } from '@yumanimous/db';
import { RecipeApiError, type SpoonacularClient } from '@yumanimous/mcp-recipes';
import { staticRecipeDeck } from './deckSource.js';
import { RecipeDeckSource, sample } from './recipeDeckSource.js';

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/mcp-recipes/src/__fixtures__/complexSearch.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const quota = { request: 4, used: 4, left: 46 };
const silent = { info: () => {}, warn: () => {} };

let clock: number;
let cache: InMemoryApiCache;
let catalog: CardCatalog & { save: ReturnType<typeof vi.fn> };
let search: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clock = 0;
  cache = new InMemoryApiCache(() => clock);
  catalog = { save: vi.fn().mockResolvedValue(undefined) };
  search = vi.fn().mockResolvedValue({ recipes: fixture.results, quota });
});

function source(overrides: Partial<ConstructorParameters<typeof RecipeDeckSource>[0]> = {}) {
  return new RecipeDeckSource({
    client: { searchMainCourses: search } as unknown as SpoonacularClient,
    cache,
    catalog,
    fallback: staticRecipeDeck,
    deckSize: 4,
    poolTtlMs: 1_000,
    log: silent,
    ...overrides,
  });
}

const ids = (cards: Card[]) => cards.map((c) => c.id);
const isRecipeDeck = (cards: Card[]) => cards.every((c) => c.id.startsWith('spoonacular:'));

describe('RecipeDeckSource', () => {
  it('fetches a pool once, caches it, and deals each deck from the cache', async () => {
    const deckSource = source();
    const first = await deckSource.buildDeck();
    const second = await deckSource.buildDeck();

    expect(search).toHaveBeenCalledOnce();
    expect(first).toHaveLength(4);
    expect(isRecipeDeck(first) && isRecipeDeck(second)).toBe(true);
    expect(new Set(ids(first)).size).toBe(4); // No duplicates within a deck.
  });

  it('stores fetched cards in the catalog with their diet facts', async () => {
    await source().buildDeck();
    const saved = catalog.save.mock.calls[0]![0];
    expect(saved).toHaveLength(6);
    expect(saved[0]).toMatchObject({
      source: 'spoonacular',
      facts: expect.objectContaining({ vegan: false }),
    });
  });

  it('refetches once the cached pool expires', async () => {
    const deckSource = source();
    await deckSource.buildDeck();
    clock = 2_000;
    await deckSource.buildDeck();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('shares one API call between sessions created at the same moment', async () => {
    const deckSource = source();
    await Promise.all([deckSource.buildDeck(), deckSource.buildDeck(), deckSource.buildDeck()]);
    expect(search).toHaveBeenCalledOnce();
  });

  it('serves a stale pool when the API fails (e.g. quota used up)', async () => {
    const deckSource = source();
    await deckSource.buildDeck();
    clock = 2_000;
    search.mockRejectedValue(new RecipeApiError(402, 'quota'));
    expect(isRecipeDeck(await deckSource.buildDeck())).toBe(true);
  });

  it('falls back to the hard-coded deck with no cache and no API', async () => {
    search.mockRejectedValue(new RecipeApiError(0, 'offline'));
    const deck = await source({ deckSize: 10 }).buildDeck();
    expect(ids(deck)).toEqual(ids(await staticRecipeDeck.buildDeck()));
  });

  it('falls back when no API key is configured and nothing is cached', async () => {
    const deck = await source({ client: null, deckSize: 10 }).buildDeck();
    expect(deck[0]?.id).toBe('rainbow-chickpea-bowl');
  });

  it('falls back when the pool is smaller than a deck', async () => {
    const deck = await source({ deckSize: 10 }).buildDeck(); // Fixture pool has 6.
    expect(isRecipeDeck(deck)).toBe(false);
  });

  it('ignores a corrupted cache entry', async () => {
    await cache.set(RecipeDeckSource.POOL_KEY, [{ nonsense: true }], 1_000);
    expect(isRecipeDeck(await source().buildDeck())).toBe(true);
    expect(search).toHaveBeenCalledOnce();
  });
});

describe('sample', () => {
  it('returns distinct items, never more than available', () => {
    const items = [1, 2, 3, 4, 5];
    const picked = sample(items, 3, Math.random);
    expect(new Set(picked).size).toBe(3);
    expect(sample(items, 10, Math.random)).toHaveLength(5);
  });

  it('is deterministic for a given random function', () => {
    expect(sample(['a', 'b', 'c'], 3, () => 0)).toEqual(['a', 'b', 'c']);
  });
});
