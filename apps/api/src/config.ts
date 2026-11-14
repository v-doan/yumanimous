import { z } from 'zod';
import { DEFAULT_LIMITS, type Limits } from './security/limits.js';

const bool = z.enum(['true', 'false']).default('false');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  // Postgres; without it sessions live in memory and are lost on restart.
  DATABASE_URL: z.string().optional(),
  // Production: a SELECT-only role for the agents' session tools (mcp-session).
  DATABASE_READER_URL: z.string().optional(),
  // Recipe API; without it decks come from the cache or the hard-coded recipes.
  SPOONACULAR_API_KEY: z.string().optional(),
  // AI deck building (Phase 6). The Agent SDK reads the key itself.
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-haiku-5-5'),
  // The app's own caps, below the Console spend limit.
  AI_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(8),
  AI_DAILY_BUDGET_USD: z.coerce.number().positive().optional(),
  // Production: the site's public https origin, e.g. https://yumanimous.fly.dev.
  PUBLIC_ORIGIN: z.string().optional(),
  // Only needed when the web app is served from a different origin.
  WEB_ORIGIN: z.url().optional(),
  // Production: the built web app, served by the API from the same origin.
  WEB_STATIC_DIR: z.string().optional(),
  // Proxies in front of the API that append to X-Forwarded-For (Fly's edge: 1).
  TRUSTED_PROXIES: z.coerce.number().int().min(0).max(3).optional(),
  // Development: turn the production rate limits on locally, to try them.
  RATE_LIMITS: bool,
  // Development only: GET /api/debug/ai (AI cost and latency).
  DEBUG_ROUTES: bool,
  // Development only: one console line per agent message (which tools ran, when).
  AI_TRACE: bool,
});

export interface Config {
  production: boolean;
  port: number;
  databaseUrl: string | undefined;
  readerDatabaseUrl: string | undefined;
  spoonacularApiKey: string | undefined;
  ai:
    | { model: string; monthlyBudgetUsd: number; dailyBudgetUsd?: number; trace: boolean }
    | undefined;
  publicOrigin: string | undefined;
  webOrigin: string | undefined;
  staticDir: string | undefined;
  trustedProxies: number;
  limits: Limits | undefined;
  debugRoutes: boolean;
  runMigrations: boolean;
}

/** A setting that would make a production deployment unsafe. Lists every problem. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Unsafe or incomplete production configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

/** In production, a connection must verify the server's certificate, not just encrypt. */
const verifiesTls = (url: string) => /[?&]sslmode=verify-full(&|$)/.test(url);

/**
 * Reads the environment. In production it refuses to start rather than run with a
 * debug route open, a database connection that isn't verified TLS, or limits off:
 * those are exactly the mistakes that are easy to make at 1am and hard to notice.
 */
export function loadConfig(raw: NodeJS.ProcessEnv): Config {
  const env = EnvSchema.parse(raw);
  const production = env.NODE_ENV === 'production';
  const blank = (v: string | undefined) => (v ? v : undefined);
  const databaseUrl = blank(env.DATABASE_URL);
  const readerDatabaseUrl = blank(env.DATABASE_READER_URL);
  const anthropic = blank(env.ANTHROPIC_API_KEY);

  if (production) {
    const problems: string[] = [];
    if (env.DEBUG_ROUTES === 'true') problems.push('DEBUG_ROUTES must be false');
    if (env.AI_TRACE === 'true') problems.push('AI_TRACE must be false (it logs guest names)');
    const origin = env.PUBLIC_ORIGIN;
    if (!origin) problems.push('PUBLIC_ORIGIN is required, e.g. https://yumanimous.fly.dev');
    else if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) {
      problems.push('PUBLIC_ORIGIN must be an https origin with no path or trailing slash');
    }
    if (!databaseUrl) problems.push('DATABASE_URL is required');
    else if (!verifiesTls(databaseUrl)) problems.push('DATABASE_URL must use sslmode=verify-full');
    if (anthropic && !readerDatabaseUrl) {
      problems.push('DATABASE_READER_URL (the SELECT-only role) is required when AI is on');
    }
    if (readerDatabaseUrl && !verifiesTls(readerDatabaseUrl)) {
      problems.push('DATABASE_READER_URL must use sslmode=verify-full');
    }
    if (!env.WEB_STATIC_DIR) problems.push('WEB_STATIC_DIR is required (the built web app)');
    if (problems.length) throw new ConfigError(problems);
  }

  return {
    production,
    port: env.PORT,
    databaseUrl,
    readerDatabaseUrl,
    spoonacularApiKey: blank(env.SPOONACULAR_API_KEY),
    ai: anthropic
      ? {
          model: env.AI_MODEL,
          monthlyBudgetUsd: env.AI_MONTHLY_BUDGET_USD,
          // In production a daily cap always applies: one busy (or abusive) day
          // must not spend the whole month.
          ...(env.AI_DAILY_BUDGET_USD !== undefined
            ? { dailyBudgetUsd: env.AI_DAILY_BUDGET_USD }
            : production
              ? { dailyBudgetUsd: 0.5 }
              : {}),
          trace: env.AI_TRACE === 'true',
        }
      : undefined,
    publicOrigin: env.PUBLIC_ORIGIN,
    webOrigin: env.WEB_ORIGIN,
    staticDir: env.WEB_STATIC_DIR,
    trustedProxies: env.TRUSTED_PROXIES ?? (production ? 1 : 0),
    // Always on in production; there is deliberately no switch to turn them off.
    limits: production || env.RATE_LIMITS === 'true' ? DEFAULT_LIMITS : undefined,
    debugRoutes: env.DEBUG_ROUTES === 'true',
    // Production migrates once per deploy, as the schema owner (see fly.toml).
    runMigrations: !production,
  };
}
