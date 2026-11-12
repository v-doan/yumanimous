import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./src/test/globalSetup.ts'],
    // Pulling the Postgres image the first time can take a while.
    hookTimeout: 120_000,
  },
});
