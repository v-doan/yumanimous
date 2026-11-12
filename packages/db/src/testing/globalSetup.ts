import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

import './providedContext.js';

/**
 * Runs once per `vitest run`. Starts a throwaway Postgres in Docker (Testcontainers)
 * so `npm test` needs no setup. Set TEST_DATABASE_URL to use an existing server
 * instead. Without Docker, Postgres tests are skipped loudly, not silently passed.
 */
export default async function setup(project: TestProject) {
  if (process.env.TEST_DATABASE_URL) {
    project.provide('databaseUrl', process.env.TEST_DATABASE_URL);
    return;
  }

  let container: StartedPostgreSqlContainer;
  try {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
  } catch (err) {
    console.warn(
      `\n[tests] Postgres tests SKIPPED: could not start a container (${(err as Error).message.split('\n')[0]}).` +
        '\n[tests] Start Docker Desktop, or set TEST_DATABASE_URL, to run them.\n',
    );
    project.provide('databaseUrl', '');
    return;
  }

  project.provide('databaseUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
