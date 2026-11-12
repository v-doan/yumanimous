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
  })
  .parse(process.env);

const server = await createServer({
  port: env.PORT,
  databaseUrl: env.DATABASE_URL || undefined,
  spoonacularApiKey: env.SPOONACULAR_API_KEY || undefined,
  webOrigin: env.WEB_ORIGIN,
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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
