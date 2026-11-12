import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Card } from '@yumanimous/shared';
import { PostgresApiCache, PostgresCardCatalog } from '../cache/caches.js';
import type { DeckSource } from '../deck/deckSource.js';
import { createTestDatabase, databaseUrl } from '../test/testDatabase.js';
import { PostgresSessionStore } from './postgresSessionStore.js';
import { SessionService } from './sessionService.js';

/**
 * Guarantees only the database can give. The shared behaviour tests in
 * sessionService.test.ts already run against Postgres too.
 */
describe.skipIf(!databaseUrl)('Postgres-specific guarantees', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  const deck: Card[] = ['a', 'b'].map((id) => ({ id, title: id, tags: [], blurb: id }));
  const deckSource: DeckSource = { mode: 'cook-in', buildDeck: async () => deck };
  const newService = () =>
    new SessionService({ store: new PostgresSessionStore(db.pool), deckSource });

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.reset();
  });

  it('keeps every swipe when two API processes write to one session at once', async () => {
    // Two services = two processes: separate in-memory locks, so only the
    // transaction's SELECT ... FOR UPDATE keeps them from overwriting each other.
    const a = newService();
    const b = newService();
    const host = await a.create({ hostName: 'Host', matchRule: 'everyone' });
    const guests = await Promise.all(['G1', 'G2', 'G3'].map((n) => a.join(host.code, n)));
    await a.start(host.code, host.memberId);

    const everyone = [host, ...guests];
    await Promise.all(
      everyone.flatMap((m, i) =>
        deck.map((card) =>
          (i % 2 ? a : b).swipe(host.code, m.memberId, { cardId: card.id, direction: 'like' }),
        ),
      ),
    );

    const view = await a.view(host.code);
    expect(view.swipes).toHaveLength(everyone.length * deck.length);
    expect(view.matches.map((m) => m.cardId).sort()).toEqual(['a', 'b']);
  });

  it('enforces one vote per member per card in the schema itself', async () => {
    const service = newService();
    const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
    const insert = (direction: string) =>
      db.pool.query(
        `INSERT INTO swipes (member_id, session_code, card_id, direction) VALUES ($1, $2, 'a', $3)`,
        [host.memberId, host.code, direction],
      );
    await insert('like');
    await expect(insert('skip')).rejects.toThrow(/duplicate key/);
  });

  it('deletes a removed member’s votes by cascade', async () => {
    const service = newService();
    const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
    const guest = await service.join(host.code, 'Guest');
    await service.start(host.code, host.memberId);
    await service.swipe(host.code, guest.memberId, { cardId: 'a', direction: 'skip' });

    await service.removeMember(host.code, guest.memberId);
    const { rows } = await db.pool.query('SELECT * FROM swipes WHERE member_id = $1', [
      guest.memberId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('deleting a session deletes everything in it', async () => {
    const service = newService();
    const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
    await service.removeMember(host.code, host.memberId); // Last member -> session ends.
    for (const table of ['sessions', 'members', 'session_cards']) {
      const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n).toBe(0);
    }
  });

  it('survives a "restart": a new store instance sees the same session', async () => {
    const before = newService();
    const host = await before.create({ hostName: 'Host', matchRule: 'majority' });
    const after = newService();
    expect(await after.authenticate(host.code, host.token)).toBe(host.memberId);
    expect((await after.view(host.code)).matchRule).toBe('majority');
  });
});

describe.skipIf(!databaseUrl)('Postgres caches', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('stores API responses with freshness', async () => {
    const cache = new PostgresApiCache(db.pool);
    await cache.set('fresh', { a: 1 }, 60_000);
    await cache.set('stale', { b: 2 }, -1_000);
    expect(await cache.get('fresh')).toEqual({ value: { a: 1 }, fresh: true });
    expect(await cache.get('stale')).toEqual({ value: { b: 2 }, fresh: false });
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('upserts catalog cards with their facts', async () => {
    const catalog = new PostgresCardCatalog(db.pool);
    const card: Card = { id: 'spoonacular:1', title: 'Pie', tags: [], blurb: 'Pie.' };
    await catalog.save([{ card, source: 'spoonacular', facts: { vegan: false } }]);
    await catalog.save([{ card, source: 'spoonacular', facts: { vegan: true } }]);
    const { rows } = await db.pool.query('SELECT facts FROM cards WHERE id = $1', [card.id]);
    expect(rows).toEqual([{ facts: { vegan: true } }]);
  });
});
