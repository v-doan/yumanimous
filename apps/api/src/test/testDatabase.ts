import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { migrate } from '../db/migrate.js';

/** '' when no Postgres is available; use with `describe.skipIf(!databaseUrl)`. */
export const databaseUrl = inject('databaseUrl');

/**
 * A fresh, migrated database per test file, so files can run in parallel without
 * seeing each other's rows. Dropped again in `drop()`.
 */
export async function createTestDatabase() {
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await adminQuery(`CREATE DATABASE ${name}`);

  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  await migrate(pool);

  return {
    url: url.toString(),
    pool,
    /** Empties every table between tests; much faster than a new database. */
    reset: () =>
      pool.query('TRUNCATE sessions, members, swipes, matches, session_cards, cards, api_cache'),
    drop: async () => {
      await pool.end();
      await adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

async function adminQuery(sql: string) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
