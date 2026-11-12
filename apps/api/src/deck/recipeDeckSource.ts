import { z } from 'zod';
import { CardSchema, type Card } from '@yumanimous/shared';
import type { ApiCache, CardCatalog } from '@yumanimous/db';
import { toCard, type SpoonacularClient } from '@yumanimous/mcp-recipes';
import type { DeckSource } from './deckSource.js';

const DAY = 24 * 60 * 60_000;

export interface RecipeDeckSourceOptions {
  /** null when no API key is configured: cached pools and the fallback still work. */
  client: SpoonacularClient | null;
  cache: ApiCache;
  catalog: CardCatalog;
  /** Used when there's no fresh or stale pool and the API can't be reached. */
  fallback: DeckSource;
  deckSize?: number;
  poolSize?: number;
  poolTtlMs?: number;
  random?: () => number;
  log?: Pick<Console, 'info' | 'warn'>;
}

/**
 * Real recipes, gently on a small free quota (Spoonacular's free tier is 50
 * points a day, and a 50-recipe search costs about 4). Instead of one API call per
 * session, we fetch a pool of popular recipes, cache it in Postgres for a week,
 * and deal each session a random hand from it. Most sessions make no API call.
 *
 * Order of preference: fresh cached pool -> new pool from the API -> stale cached
 * pool -> the static fallback deck. A session can always start.
 */
export class RecipeDeckSource implements DeckSource {
  readonly mode = 'cook-in' as const;
  // Bump the version when the pool query or card mapping changes, to refetch.
  static readonly POOL_KEY = 'spoonacular:complexSearch:main-course:popular:v1';

  private readonly opts: Required<Omit<RecipeDeckSourceOptions, 'client'>> & {
    client: SpoonacularClient | null;
  };
  /** Two sessions created at the same moment share one API call. */
  private inflight: Promise<Card[]> | null = null;

  constructor(options: RecipeDeckSourceOptions) {
    this.opts = {
      deckSize: 10,
      poolSize: 50,
      poolTtlMs: 7 * DAY,
      random: Math.random,
      log: console,
      ...options,
    };
  }

  async buildDeck(): Promise<Card[]> {
    const pool = await this.loadPool();
    if (pool.length < this.opts.deckSize) return this.opts.fallback.buildDeck();
    return sample(pool, this.opts.deckSize, this.opts.random);
  }

  private async loadPool(): Promise<Card[]> {
    const cached = await this.opts.cache.get(RecipeDeckSource.POOL_KEY);
    const cachedCards = cached && parsePool(cached.value);
    if (cached?.fresh && cachedCards) return cachedCards;

    if (this.opts.client) {
      this.inflight ??= this.fetchPool(this.opts.client).finally(() => {
        this.inflight = null;
      });
      try {
        return await this.inflight;
      } catch (err) {
        this.opts.log.warn(`[recipes] fetch failed, using fallback: ${(err as Error).message}`);
      }
    }
    return cachedCards ?? [];
  }

  private async fetchPool(client: SpoonacularClient): Promise<Card[]> {
    const { recipes, quota } = await client.searchMainCourses(this.opts.poolSize);
    const mapped = recipes.flatMap((r) => toCard(r) ?? []);
    this.opts.log.info(
      `[recipes] fetched ${mapped.length} recipes; quota: ${quota.request} points this call, ${quota.left} left today`,
    );

    await this.opts.catalog.save(
      mapped.map(({ card, facts }) => ({ card, source: 'spoonacular', facts })),
    );
    const cards = mapped.map((m) => m.card);
    await this.opts.cache.set(RecipeDeckSource.POOL_KEY, cards, this.opts.poolTtlMs);
    return cards;
  }
}

/** Cached JSON is untrusted until validated; a corrupt entry is treated as a miss. */
function parsePool(value: unknown): Card[] | undefined {
  const parsed = z.array(CardSchema).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** `count` distinct items in random order (partial Fisher-Yates shuffle). */
export function sample<T>(items: readonly T[], count: number, random: () => number): T[] {
  const copy = [...items];
  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}
