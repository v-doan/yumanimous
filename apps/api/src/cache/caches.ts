import type pg from 'pg';
import type { Card } from '@yumanimous/shared';

/** A cached value, plus whether it is still within its time-to-live. */
export interface CacheEntry {
  value: unknown;
  fresh: boolean;
}

/**
 * Raw external API responses, keyed by request. Expired entries are still returned
 * (marked stale): when the API is down or out of quota, stale data beats none.
 * Values come back as `unknown` on purpose: callers re-validate with Zod.
 */
export interface ApiCache {
  get: (key: string) => Promise<CacheEntry | undefined>;
  set: (key: string, value: unknown, ttlMs: number) => Promise<void>;
}

/** Every card we've ever fetched, with the source facts later phases filter on. */
export interface CardCatalog {
  save: (entries: { card: Card; source: string; facts: object }[]) => Promise<void>;
}

export class InMemoryApiCache implements ApiCache {
  private entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return { value: structuredClone(entry.value), fresh: entry.expiresAt > this.now() };
  }

  async set(key: string, value: unknown, ttlMs: number) {
    this.entries.set(key, { value: structuredClone(value), expiresAt: this.now() + ttlMs });
  }
}

/** Without a database there's nowhere to keep a catalog; sessions still get their cards. */
export const noopCardCatalog: CardCatalog = { save: async () => {} };

export class PostgresApiCache implements ApiCache {
  constructor(private readonly pool: pg.Pool) {}

  async get(key: string) {
    const { rows } = await this.pool.query<{ response: unknown; fresh: boolean }>(
      'SELECT response, expires_at > now() AS fresh FROM api_cache WHERE key = $1',
      [key],
    );
    const row = rows[0];
    return row && { value: row.response, fresh: row.fresh };
  }

  async set(key: string, value: unknown, ttlMs: number) {
    await this.pool.query(
      `INSERT INTO api_cache (key, response, fetched_at, expires_at)
       VALUES ($1, $2, now(), now() + make_interval(secs => $3))
       ON CONFLICT (key) DO UPDATE
         SET response = excluded.response,
             fetched_at = excluded.fetched_at,
             expires_at = excluded.expires_at`,
      [key, JSON.stringify(value), ttlMs / 1000],
    );
  }
}

export class PostgresCardCatalog implements CardCatalog {
  constructor(private readonly pool: pg.Pool) {}

  async save(entries: { card: Card; source: string; facts: object }[]) {
    for (const { card, source, facts } of entries) {
      await this.pool.query(
        `INSERT INTO cards (id, source, card, facts, fetched_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id) DO UPDATE
           SET card = excluded.card, facts = excluded.facts, fetched_at = excluded.fetched_at`,
        [card.id, source, card, facts],
      );
    }
  }
}
