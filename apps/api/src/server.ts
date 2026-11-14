import { z } from 'zod';
import { createServer } from './createServer.js';

const env = z
  .object({
    PORT: z.coerce.number().int().positive().default(3001),
    // Postgres; without it sessions live in memory and are lost on restart.
    DATABASE_URL: z.string().optional(),
    // Recipe API; without it decks come from the cache or the hard-coded recipes.
    SPOONACULAR_API_KEY: z.string().optional(),
    // Only needed when the web app is served from a different origin (production).
    WEB_ORIGIN: z.url().optional(),
    // AI deck building (Phase 6). The Agent SDK reads the key itself.
    ANTHROPIC_API_KEY: z.string().optional(),
    AI_MODEL: z.string().default('claude-haiku-5-5'),
    // The app's own monthly cap, below the Console spend limit.
    AI_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(8),
    // Development only: GET /api/debug/ai (AI cost and latency).
    DEBUG_ROUTES: z.enum(['true', 'false']).default('false'),
    // Development only: one console line per agent message (which tools ran, when).
    AI_TRACE: z.enum(['true', 'false']).default('false'),
  })
  .parse(process.env);

const server = await createServer({
  port: env.PORT,
  databaseUrl: env.DATABASE_URL || undefined,
  spoonacularApiKey: env.SPOONACULAR_API_KEY || undefined,
  webOrigin: env.WEB_ORIGIN,
  ai: env.ANTHROPIC_API_KEY
    ? {
        model: env.AI_MODEL,
        monthlyBudgetUsd: env.AI_MONTHLY_BUDGET_USD,
        trace: env.AI_TRACE === 'true',
      }
    : undefined,
  debugRoutes: env.DEBUG_ROUTES === 'true',
}).catch((err: NodeJS.ErrnoException & { errors?: NodeJS.ErrnoException[] }) => {
  // pg reports "nothing listening" as ECONNREFUSED (an AggregateError for IPv4 + IPv6).
  const refused = err.code === 'ECONNREFUSED' || err.errors?.some((e) => e.code === 'ECONNREFUSED');
  if (!refused) throw err;
  console.error(
    '\nCan’t reach Postgres at DATABASE_URL.\n' +
      '  Start it:  npm run db:up   (needs Docker Desktop running)\n' +
      '  Or run without a database: remove DATABASE_URL from .env\n',
  );
  process.exit(1);
});

console.log(`API listening on ${server.url}`);
console.log(
  `  sessions: ${server.storage === 'postgres' ? 'Postgres' : 'in memory (no DATABASE_URL)'}`,
);
console.log(
  `  recipes:  ${env.SPOONACULAR_API_KEY ? 'Spoonacular (cached pool)' : 'hard-coded deck (no SPOONACULAR_API_KEY)'}`,
);

console.log(
  `  ai deck:  ${server.aiEnabled ? `${env.AI_MODEL}, budget $${env.AI_MONTHLY_BUDGET_USD}/month` : 'off (needs ANTHROPIC_API_KEY and DATABASE_URL)'}`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
