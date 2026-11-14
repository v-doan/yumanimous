import { ConfigError, loadConfig } from './config.js';
import { createServer } from './createServer.js';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

const server = await createServer({
  port: config.port,
  databaseUrl: config.databaseUrl,
  readerDatabaseUrl: config.readerDatabaseUrl,
  runMigrations: config.runMigrations,
  spoonacularApiKey: config.spoonacularApiKey,
  webOrigin: config.webOrigin,
  publicOrigin: config.publicOrigin,
  staticDir: config.staticDir,
  trustedProxies: config.trustedProxies,
  limits: config.limits,
  ai: config.ai,
  debugRoutes: config.debugRoutes,
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
  `  recipes:  ${config.spoonacularApiKey ? 'Spoonacular (cached pool)' : 'hard-coded deck (no SPOONACULAR_API_KEY)'}`,
);

console.log(
  `  ai deck:  ${server.aiEnabled && config.ai ? `${config.ai.model}, budget $${config.ai.monthlyBudgetUsd}/month${config.ai.dailyBudgetUsd ? `, $${config.ai.dailyBudgetUsd}/day` : ''}` : 'off (needs ANTHROPIC_API_KEY and DATABASE_URL)'}`,
);
console.log(`  limits:   ${config.limits ? 'on' : 'off (development)'}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
