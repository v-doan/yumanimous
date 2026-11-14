import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createPool,
  InMemoryApiCache,
  migrate,
  noopCardCatalog,
  PostgresApiCache,
  PostgresCardCatalog,
} from '@yumanimous/db';
import { createSessionServer } from '@yumanimous/mcp-session';
import { BudgetGuard, PostgresAiCallLog } from './ai/aiCallLog.js';
import { ClaudeDeckAgent } from './ai/deckAgent.js';
import { AiDeckSource } from './deck/aiDeckSource.js';
import { staticRecipeDeck, type DeckSource } from './deck/deckSource.js';
import { RecipeDeckSource } from './deck/recipeDeckSource.js';
import { createApp } from './http/app.js';
import { attachRealtime } from './realtime/realtime.js';
import { createRecipesServer, SpoonacularClient } from '@yumanimous/mcp-recipes';
import { AiRunner } from './ai/aiRunner.js';
import { ClaudeFollowUpAgent } from './ai/followUpAgents.js';
import { FollowUpService, type FollowUps } from './followUps/followUps.js';
import { mcpRecipeDetails } from './followUps/recipeDetails.js';
import { PostgresSessionStore } from './sessions/postgresSessionStore.js';
import { InMemorySessionStore, type SessionStore } from './sessions/sessionStore.js';
import { SessionService } from './sessions/sessionService.js';
import type { Limits } from './security/limits.js';

export interface ServerOptions {
  port: number;
  /** Postgres connection string. Without it, everything lives in memory. */
  databaseUrl?: string | undefined;
  /** Without it, decks come from the cache (if any) or the hard-coded recipes. */
  spoonacularApiKey?: string | undefined;
  webOrigin?: string | undefined;
  /**
   * AI deck building (Phase 6). Needs Postgres (for the read-only session tools and
   * the cost log) and ANTHROPIC_API_KEY in the environment. Off when omitted.
   */
  ai?:
    | { model: string; monthlyBudgetUsd: number; dailyBudgetUsd?: number; trace?: boolean }
    | undefined;
  /** Exposes GET /api/debug/ai (AI cost and latency). Development only. */
  debugRoutes?: boolean;
  /**
   * Production: a connection as a SELECT-only role for the agents' session tools
   * (mcp-session). Without it, a read-only session on `databaseUrl` is used (dev).
   */
  readerDatabaseUrl?: string | undefined;
  /**
   * Run migrations at startup (dev, tests). In production they run once per deploy
   * as the schema owner, and the app's own role can't change the schema.
   */
  runMigrations?: boolean;
  /** Abuse and cost limits (production). */
  limits?: Limits | undefined;
  /** Proxies in front of the API that add to X-Forwarded-For (Fly: 1). */
  trustedProxies?: number;
  /** Production: serve the built web app from this directory, same origin. */
  staticDir?: string | undefined;
  /** Production: the site's public https origin (CSP, socket origin check). */
  publicOrigin?: string | undefined;
  /** How long a member may be offline (refresh, tunnel, locked phone) before removal. */
  graceMs?: number;
  /** How often to look for members past the grace period. */
  presenceSweepMs?: number;
  /** Test overrides. */
  store?: SessionStore;
  deckSource?: DeckSource;
  followUps?: FollowUps;
  now?: () => number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

/** Wires store -> service -> HTTP + Socket.io. Used by `server.ts` and by tests. */
export async function createServer({
  port,
  databaseUrl,
  spoonacularApiKey,
  webOrigin,
  ai,
  debugRoutes = false,
  readerDatabaseUrl,
  runMigrations = true,
  limits,
  trustedProxies = 0,
  staticDir,
  publicOrigin,
  graceMs = 2 * MINUTE,
  presenceSweepMs = 30 * SECOND,
  now,
  ...overrides
}: ServerOptions) {
  const pool = databaseUrl ? createPool(databaseUrl) : null;
  if (pool && runMigrations) await migrate(pool);

  const store =
    overrides.store ?? (pool ? new PostgresSessionStore(pool) : new InMemorySessionStore());
  const spoonacular = spoonacularApiKey
    ? new SpoonacularClient({ apiKey: spoonacularApiKey })
    : null;
  const apiCache = pool ? new PostgresApiCache(pool) : new InMemoryApiCache();
  const recipeDeck = new RecipeDeckSource({
    client: spoonacular,
    cache: apiCache,
    catalog: pool ? new PostgresCardCatalog(pool) : noopCardCatalog,
    fallback: staticRecipeDeck,
  });

  // AI sits on top of the recipe source: same safe candidate pool, plus a budget
  // guard and a cost log. Without Postgres or a key, the non-AI deck is used.
  let aiLog: PostgresAiCallLog | null = null;
  let budget: BudgetGuard | null = null;
  let readOnlyPool: ReturnType<typeof createPool> | null = null;
  let aiDeck: AiDeckSource | null = null;
  let followUpAi: ConstructorParameters<typeof FollowUpService>[0]['ai'];
  if (ai && pool && databaseUrl) {
    // Guest names can appear in tool inputs; the trace is for local debugging only.
    const trace = ai.trace ? { trace: (line: string) => console.log(`[ai] ${line}`) } : {};
    aiLog = new PostgresAiCallLog(pool);
    budget = new BudgetGuard(aiLog, ai.monthlyBudgetUsd, Date.now, ai.dailyBudgetUsd ?? null);
    // The agents read sessions through mcp-session on a connection Postgres keeps
    // read-only, exactly as Claude Desktop / Claude Code do.
    // Production uses a SELECT-only role (no access to rejoin token hashes at all);
    // the read-only session setting stays on as well.
    const sessionPool = createPool(readerDatabaseUrl ?? databaseUrl, { readOnly: true });
    readOnlyPool = sessionPool;
    followUpAi = {
      agent: new ClaudeFollowUpAgent({
        model: ai.model,
        createSessionServer: () => createSessionServer({ pool: sessionPool }),
        ...trace,
      }),
      runner: new AiRunner({ log: aiLog, budget, model: ai.model }),
    };
    aiDeck = new AiDeckSource({
      base: recipeDeck,
      agent: new ClaudeDeckAgent({
        model: ai.model,
        createSessionServer: () => createSessionServer({ pool: sessionPool }),
        ...trace,
      }),
      log: aiLog,
      budget,
    });
  } else if (ai) {
    console.warn('[ai] AI deck building needs DATABASE_URL; using the non-AI deck.');
  }
  const deckSource = overrides.deckSource ?? aiDeck ?? recipeDeck;

  // Phase 7. Recipes are read through mcp-recipes (in-process) with the same cache
  // as the deck, so a recipe already looked up costs nothing. Without AI, lists and
  // compromises are made by code alone.
  const followUps =
    overrides.followUps ??
    new FollowUpService({
      recipeDetails: mcpRecipeDetails(() =>
        createRecipesServer({ client: spoonacular, cache: apiCache }),
      ),
      ai: followUpAi,
    });

  const service = new SessionService({
    store,
    deckSource,
    followUps,
    caps: { maxActiveSessions: limits?.maxActiveSessions ?? null },
    ...(now ? { now } : {}),
  });
  // After a restart nobody has a socket yet. Phones reconnect within seconds and
  // flip back online; the presence sweep removes anyone who doesn't come back.
  await service.markAllOffline();

  const app = createApp(service, {
    webOrigin,
    debug: debugRoutes && aiLog && budget ? { aiLog, budget } : undefined,
    limits,
    trustedProxies,
    staticDir,
    publicOrigin,
  });
  const httpServer = createHttpServer(app);
  const realtime = attachRealtime(httpServer, service, {
    webOrigin,
    limits,
    trustedProxies,
    allowedOrigins: publicOrigin ? [publicOrigin, ...(webOrigin ? [webOrigin] : [])] : undefined,
  });

  const timers = [
    setInterval(
      () => void service.removeStaleMembers(graceMs).catch(console.error),
      presenceSweepMs,
    ),
    // Sessions are useless after a day of silence; drop them to keep the tables small.
    setInterval(() => void service.sweepIdle(DAY).catch(console.error), 60 * MINUTE),
  ];
  for (const timer of timers) timer.unref();

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  const address = httpServer.address() as AddressInfo;

  return {
    service,
    app,
    port: address.port,
    url: `http://localhost:${address.port}`,
    storage: pool ? ('postgres' as const) : ('memory' as const),
    aiEnabled: aiDeck !== null && !overrides.deckSource,
    close: async () => {
      for (const timer of timers) clearInterval(timer);
      await realtime.close(); // Also closes the HTTP server.
      await service.settled(); // A mediator run may still be writing.
      await store.close();
      await readOnlyPool?.end();
      await pool?.end();
    },
  };
}
