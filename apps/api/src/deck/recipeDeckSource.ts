import { z } from 'zod';
import {
  CardSchema,
  describeHardFilters,
  hasHardFilters,
  type Card,
  type GroupPreferences,
  type HardFilters,
} from '@yumanimous/shared';
import type { ApiCache, CardCatalog } from '@yumanimous/db';
import { toCard, type SpoonacularClient } from '@yumanimous/mcp-recipes';
import { DeckError, type DeckSource } from './deckSource.js';

const DAY = 24 * 60 * 60_000;
/** Below this many recipes a deck isn't worth swiping; tell the host instead. */
const MIN_DECK = 3;

export interface RecipeDeckSourceOptions {
  /** null when no API key is configured: cached pools and the fallback still work. */
  client: SpoonacularClient | null;
  cache: ApiCache;
  catalog: CardCatalog;
  /** For groups with no hard rules, when there's no pool and the API can't be reached. */
  fallback: DeckSource;
  deckSize?: number;
  poolSize?: number;
  /** How many recipes to fetch for a filtered (hard-rule) search. */
  filteredPoolSize?: number;
  poolTtlMs?: number;
  random?: () => number;
  log?: Pick<Console, 'info' | 'warn'>;
}

/**
 * Real recipes, gently on a small free quota (Spoonacular's free tier is 50 points a
 * day). Two kinds of pool, both cached in Postgres for a week:
 *
 * - No hard rules: one shared pool of popular main courses. Most sessions make no
 *   API call at all.
 * - Hard rules (diets, allergens, excluded ingredients, a time limit): a pool searched
 *   WITH those filters, cached per filter combination. The recipe API applies them, so
 *   every card in the deck satisfies every member's restrictions. There is no fallback
 *   to unfiltered recipes here: if the search can't run, the start fails with a reason.
 *
 * Soft preferences (cuisines, dislikes, cravings) then rank the pool before dealing.
 */
export class RecipeDeckSource implements DeckSource {
  readonly mode = 'cook-in' as const;
  // Bump the version when a query or the card mapping changes, to refetch.
  static readonly POOL_KEY = 'spoonacular:complexSearch:main-course:popular:v1';
  static filteredKey = (hard: HardFilters) => `spoonacular:deck:v1:${stableKey(hard)}`;

  private readonly opts: Required<Omit<RecipeDeckSourceOptions, 'client'>> & {
    client: SpoonacularClient | null;
  };
  /** Sessions starting at the same moment with the same filters share one API call. */
  private readonly inflight = new Map<string, Promise<Card[]>>();

  constructor(options: RecipeDeckSourceOptions) {
    this.opts = {
      deckSize: 10,
      poolSize: 50,
      filteredPoolSize: 30,
      poolTtlMs: 7 * DAY,
      random: Math.random,
      log: console,
      ...options,
    };
  }

  async buildDeck(group?: GroupPreferences): Promise<Card[]> {
    if (group && hasHardFilters(group.hard)) return this.filteredDeck(group);

    const pool = await this.loadPool(RecipeDeckSource.POOL_KEY, (client) =>
      client.searchMainCourses(this.opts.poolSize),
    );
    if (!pool || pool.length < this.opts.deckSize) return this.opts.fallback.buildDeck(group);
    return this.deal(pool, group);
  }

  private async filteredDeck(group: GroupPreferences): Promise<Card[]> {
    const { hard } = group;
    const pool = await this.loadPool(RecipeDeckSource.filteredKey(hard), (client) =>
      client.searchRecipes({
        type: 'main course',
        count: this.opts.filteredPoolSize,
        diets: hard.diets,
        intolerances: hard.intolerances,
        excludeIngredients: hard.excludeIngredients,
        maxReadyMinutes: hard.maxReadyMinutes ?? undefined,
      }),
    );
    if (!pool) {
      throw new DeckError(
        'The recipe service is unavailable, so the deck can’t be checked against the group’s food rules. Try again shortly.',
      );
    }
    if (pool.length < MIN_DECK) {
      const rules = describeHardFilters(hard).join(' · ');
      const hint =
        hard.maxReadyMinutes !== null ? ' Try a longer time limit.' : ' Try loosening a rule.';
      throw new DeckError(
        `Only ${pool.length} recipe${pool.length === 1 ? '' : 's'} fit everyone’s rules (${rules}).${hint}`,
      );
    }
    return this.deal(pool, group);
  }

  /**
   * Cache-first pool. Fresh cache -> no call. Otherwise fetch; if that fails, a stale
   * pool is still correct for the same filters. Returns null when nothing is available.
   */
  private async loadPool(
    key: string,
    search: (client: SpoonacularClient) => ReturnType<SpoonacularClient['searchRecipes']>,
  ): Promise<Card[] | null> {
    const cached = await this.opts.cache.get(key);
    const cachedCards = cached && parsePool(cached.value);
    if (cached?.fresh && cachedCards) return cachedCards;

    const client = this.opts.client;
    if (client) {
      let pending = this.inflight.get(key);
      if (!pending) {
        pending = this.fetchPool(key, () => search(client)).finally(() =>
          this.inflight.delete(key),
        );
        this.inflight.set(key, pending);
      }
      try {
        return await pending;
      } catch (err) {
        this.opts.log.warn(`[recipes] fetch failed: ${(err as Error).message}`);
      }
    }
    return cachedCards ?? null;
  }

  private async fetchPool(
    key: string,
    search: () => ReturnType<SpoonacularClient['searchRecipes']>,
  ): Promise<Card[]> {
    const { recipes, quota } = await search();
    const mapped = recipes.flatMap((r) => toCard(r) ?? []);
    this.opts.log.info(
      `[recipes] fetched ${mapped.length} recipes; quota: ${quota.request} points this call, ${quota.left} left today`,
    );

    await this.opts.catalog.save(
      mapped.map(({ card, facts }) => ({ card, source: 'spoonacular', facts })),
    );
    const cards = mapped.map((m) => m.card);
    await this.opts.cache.set(key, cards, this.opts.poolTtlMs);
    return cards;
  }

  /**
   * Ranks by soft preferences, then deals a random hand from the best part of the
   * pool: the group's taste shows, but two sessions with the same people still get
   * different decks.
   */
  private deal(pool: Card[], group: GroupPreferences | undefined): Card[] {
    const size = Math.min(this.opts.deckSize, pool.length);
    if (!group) return sample(pool, size, this.opts.random);

    const shuffled = sample(pool, pool.length, this.opts.random); // Random tie-breaks.
    const ranked = shuffled
      .map((card) => ({ card, score: softScore(card, group.soft) }))
      .sort((a, b) => b.score - a.score)
      .map((r) => r.card);
    const shortlist = ranked.slice(0, Math.max(size * 2, size));
    return sample(shortlist, size, this.opts.random);
  }
}

// Words in a recipe title that suggest a craving. Rough, and that's fine: it only
// nudges the order. Phase 6's curator agent does real ranking.
const CRAVING_HINTS: Record<string, RegExp> = {
  spicy: /spicy|chili|chilli|jalape|sriracha|curry|cajun|peri peri|hot/i,
  'comfort food': /casserole|mac|pie|stew|lasagna|bake|pot roast|meatloaf/i,
  healthy: /salad|quinoa|bowl|grilled|steamed/i,
  light: /salad|soup|broth|steamed/i,
  cheesy: /chees|parmesan|mozzarella|cheddar/i,
  hearty: /stew|chili|roast|casserole|pie/i,
  sweet: /sweet|honey|maple|caramel|teriyaki/i,
  fresh: /salad|fresh|herb|citrus|lemon/i,
};

/** Higher is better. Exported for tests. */
export function softScore(card: Card, soft: GroupPreferences['soft']): number {
  const text = `${card.title} ${card.tags.join(' ')}`.toLowerCase();
  let score = 0;
  for (const tag of card.tags) score += soft.cuisineScores[tag] ?? 0;
  for (const ingredient of soft.dislikedIngredients) {
    if (text.includes(ingredient)) score -= 2;
  }
  for (const craving of soft.cravings) {
    if (craving === 'quick') {
      if ((minutesOf(card) ?? Infinity) <= 30) score += 1;
    } else if (CRAVING_HINTS[craving]?.test(text)) {
      score += 1;
    }
  }
  return score;
}

/** Reads "25 min" / "1 h 30 min" from a card's tags. */
function minutesOf(card: Card): number | null {
  for (const tag of card.tags) {
    const m = /^(?:(\d+) h)?\s*(?:(\d+) min)?$/.exec(tag);
    if (m && (m[1] || m[2])) return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  }
  return null;
}

/** Same filters in any order -> same cache key. */
function stableKey(hard: HardFilters): string {
  return JSON.stringify({
    diets: [...hard.diets].sort(),
    intolerances: [...hard.intolerances].sort(),
    excludeIngredients: [...hard.excludeIngredients].sort(),
    maxReadyMinutes: hard.maxReadyMinutes,
  });
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
