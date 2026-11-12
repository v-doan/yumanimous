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
import { staticRecipeDeck, type DeckSource } from './deck/deckSource.js';
import { RecipeDeckSource } from './deck/recipeDeckSource.js';
import { createApp } from './http/app.js';
import { attachRealtime } from './realtime/realtime.js';
import { SpoonacularClient } from '@yumanimous/mcp-recipes';
import { PostgresSessionStore } from './sessions/postgresSessionStore.js';
import { InMemorySessionStore, type SessionStore } from './sessions/sessionStore.js';
import { SessionService } from './sessions/sessionService.js';

export interface ServerOptions {
  port: number;
  /** Postgres connection string. Without it, everything lives in memory. */
  databaseUrl?: string | undefined;
  /** Without it, decks come from the cache (if any) or the hard-coded recipes. */
  spoonacularApiKey?: string | undefined;
  webOrigin?: string | undefined;
  /** How long a member may be offline (refresh, tunnel, locked phone) before removal. */
  graceMs?: number;
  /** How often to look for members past the grace period. */
  presenceSweepMs?: number;
  /** Test overrides. */
  store?: SessionStore;
  deckSource?: DeckSource;
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
  graceMs = 2 * MINUTE,
  presenceSweepMs = 30 * SECOND,
  now,
  ...overrides
}: ServerOptions) {
  const pool = databaseUrl ? createPool(databaseUrl) : null;
  if (pool) await migrate(pool);

  const store =
    overrides.store ?? (pool ? new PostgresSessionStore(pool) : new InMemorySessionStore());
  const deckSource =
    overrides.deckSource ??
    new RecipeDeckSource({
      client: spoonacularApiKey ? new SpoonacularClient({ apiKey: spoonacularApiKey }) : null,
      cache: pool ? new PostgresApiCache(pool) : new InMemoryApiCache(),
      catalog: pool ? new PostgresCardCatalog(pool) : noopCardCatalog,
      fallback: staticRecipeDeck,
    });

  const service = new SessionService({ store, deckSource, ...(now ? { now } : {}) });
  // After a restart nobody has a socket yet. Phones reconnect within seconds and
  // flip back online; the presence sweep removes anyone who doesn't come back.
  await service.markAllOffline();

  const app = createApp(service, { webOrigin });
  const httpServer = createHttpServer(app);
  const realtime = attachRealtime(httpServer, service, { webOrigin });

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
    close: async () => {
      for (const timer of timers) clearInterval(timer);
      await realtime.close(); // Also closes the HTTP server.
      await store.close();
      await pool?.end();
    },
  };
}
