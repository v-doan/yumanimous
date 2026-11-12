import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Starts one throwaway Postgres for the run (see packages/db/src/testing).
    globalSetup: ['../../packages/db/src/testing/globalSetup.ts'],
    hookTimeout: 120_000,
  },
});
