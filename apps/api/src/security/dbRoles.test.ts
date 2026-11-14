import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type pg from 'pg';
import { applyGrants, connectionStringFor, createPool, ensureRoles } from '@yumanimous/db';
import { createTestDatabase, databaseUrl } from '@yumanimous/db/testing';
import { createSessionServer } from '@yumanimous/mcp-session';
import { PostgresSessionStore } from '../sessions/postgresSessionStore.js';
import { SessionService } from '../sessions/sessionService.js';

/**
 * Proves the production roles (packages/db/src/roles.ts) against a real Postgres:
 * the app can run every session operation but can't change the schema; the reader
 * serves the agents' tools but can't write, and can't read rejoin token hashes.
 */
describe.skipIf(!databaseUrl)('least-privilege database roles', () => {
  // Roles are cluster-wide; unique names keep parallel test files apart.
  const suffix = randomBytes(4).toString('hex');
  const roles = { app: `test_app_${suffix}`, reader: `test_reader_${suffix}` };
  const passwords = { app: 'app-pw-test', reader: 'reader-pw-test' };
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let appPool: pg.Pool;
  let readerPool: pg.Pool;
  let code: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    await ensureRoles(db.pool, passwords, roles);
    await applyGrants(db.pool, roles);
    appPool = createPool(connectionStringFor(db.url, roles.app, passwords.app));
    readerPool = createPool(connectionStringFor(db.url, roles.reader, passwords.reader), {
      readOnly: true,
    });

    // A real session, written through the app role.
    const service = new SessionService({
      store: new PostgresSessionStore(appPool),
      deckSource: {
        mode: 'cook-in',
        buildDeck: async () => [{ id: 'soup', title: 'Soup', tags: [], blurb: 'Warm.' }],
      },
    });
    const host = await service.create({ hostName: 'Vy', matchRule: 'everyone' });
    await service.join(host.code, 'Sam');
    await service.start(host.code, host.memberId);
    await service.swipe(host.code, host.memberId, { cardId: 'soup', direction: 'like' });
    code = host.code;
  });

  afterAll(async () => {
    await appPool?.end();
    await readerPool?.end();
    await db?.drop();
    // Roles live on the cluster, not in the dropped database.
    const admin = createPool(databaseUrl);
    for (const role of [roles.app, roles.reader]) {
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await admin.end();
  });

  const denied = /permission denied|must be owner/;

  describe('app role', () => {
    it('runs a whole session (the setup above)', async () => {
      const { rows } = await appPool.query('SELECT count(*)::int AS n FROM swipes');
      expect(rows[0].n).toBe(1);
    });

    it('cannot change the schema', async () => {
      await expect(appPool.query('DROP TABLE swipes')).rejects.toThrow(denied);
      await expect(appPool.query('ALTER TABLE members ADD COLUMN x int')).rejects.toThrow(denied);
      await expect(appPool.query('CREATE TABLE evil (id int)')).rejects.toThrow(denied);
      await expect(appPool.query('TRUNCATE sessions')).rejects.toThrow(denied);
    });

    it('cannot touch the migrations ledger', async () => {
      await expect(appPool.query('SELECT * FROM schema_migrations')).rejects.toThrow(denied);
      await expect(appPool.query('DELETE FROM schema_migrations')).rejects.toThrow(denied);
    });

    it('cannot create roles or databases', async () => {
      await expect(appPool.query('CREATE ROLE sneaky')).rejects.toThrow(denied);
      await expect(appPool.query('CREATE DATABASE sneaky')).rejects.toThrow(denied);
    });
  });

  describe('reader role', () => {
    it('serves the agents’ session tools', async () => {
      const server = createSessionServer({ pool: readerPool });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '0' });
      await Promise.all([server.connect(b), client.connect(a)]);
      try {
        for (const tool of [
          'get_session',
          'get_swipe_history',
          'get_vote_tally',
          'get_member_preferences',
          'get_round_history',
        ]) {
          const res = await client.callTool({ name: tool, arguments: { code } });
          expect(res.isError, tool).toBeFalsy();
        }
      } finally {
        await client.close();
      }
    });

    it('can never read rejoin token hashes', async () => {
      await expect(readerPool.query('SELECT token_hash FROM members')).rejects.toThrow(denied);
      await expect(readerPool.query('SELECT * FROM members')).rejects.toThrow(denied);
    });

    it('cannot write, even after turning read-only mode off', async () => {
      const client = await readerPool.connect();
      try {
        // The read-only session setting can be switched off by a connection...
        await client.query('SET default_transaction_read_only = off');
        // ...but the role itself still has no write privileges.
        await expect(client.query('DELETE FROM swipes')).rejects.toThrow(denied);
        await expect(client.query("UPDATE sessions SET status = 'lobby'")).rejects.toThrow(denied);
      } finally {
        client.release();
      }
    });

    it('sees only the tables the tools need', async () => {
      await expect(readerPool.query('SELECT * FROM ai_calls')).rejects.toThrow(denied);
      await expect(readerPool.query('SELECT * FROM api_cache')).rejects.toThrow(denied);
      await expect(readerPool.query('SELECT * FROM shopping_lists')).rejects.toThrow(denied);
    });
  });

  it('grants are idempotent (they run on every deploy)', async () => {
    await applyGrants(db.pool, roles);
    await applyGrants(db.pool, roles);
    const { rows } = await appPool.query('SELECT count(*)::int AS n FROM sessions');
    expect(rows[0].n).toBe(1);
  });
});
