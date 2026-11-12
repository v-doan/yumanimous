import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { staticRecipeDeck, type DeckSource } from './deck/deckSource.js';
import { createApp } from './http/app.js';
import { attachRealtime } from './realtime/realtime.js';
import { InMemorySessionStore, type SessionStore } from './sessions/sessionStore.js';
import { SessionService } from './sessions/sessionService.js';

export interface ServerOptions {
  port: number;
  graceMs?: number;
  webOrigin?: string | undefined;
  store?: SessionStore;
  deckSource?: DeckSource;
  now?: () => number;
}

const TWO_MINUTES = 2 * 60_000;

/** Wires store -> service -> HTTP + Socket.io. Used by `server.ts` and by tests. */
export async function createServer({
  port,
  graceMs = TWO_MINUTES,
  webOrigin,
  store = new InMemorySessionStore(),
  deckSource = staticRecipeDeck,
  now,
}: ServerOptions) {
  const service = new SessionService({ store, deckSource, ...(now ? { now } : {}) });
  const app = createApp(service, { webOrigin });
  const httpServer = createHttpServer(app);
  const realtime = attachRealtime(httpServer, service, { graceMs, webOrigin });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  const address = httpServer.address() as AddressInfo;

  return {
    service,
    app,
    port: address.port,
    url: `http://localhost:${address.port}`,
    // io.close() also closes the HTTP server.
    close: () => realtime.close(),
  };
}
