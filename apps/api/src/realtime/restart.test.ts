import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type {
  AckResult,
  ClientToServerEvents,
  Membership,
  ServerToClientEvents,
  SessionView,
} from '@yumanimous/shared';
import { createServer } from '../createServer.js';
import { createTestDatabase, databaseUrl } from '@yumanimous/db/testing';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * The Phase 3 promise: restart the API mid-session and nobody notices. The phone's
 * socket reconnects with its stored token and carries on where it left off.
 */
describe.skipIf(!databaseUrl)('API restart mid-session', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('keeps the session, the member and their swipes', async () => {
    let server = await createServer({ port: 0, databaseUrl: db.url });
    const port = server.port;

    const host = (await (
      await fetch(`${server.url}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostName: 'Host' }),
      })
    ).json()) as Membership;

    const client: Client = connect(server.url, {
      auth: { code: host.code, token: host.token },
      transports: ['websocket'],
      reconnectionDelay: 50,
      reconnectionDelayMax: 200,
    });
    // A graceful shutdown says "io server disconnect", which socket.io-client doesn't
    // retry on its own. The web app's useSession does exactly this.
    client.on('disconnect', (reason) => {
      if (reason === 'io server disconnect') client.connect();
    });

    try {
      await nextState(client, () => true);
      // The deck is built at the start, so read it from the state that follows.
      const started = nextState(client, (v) => v.status === 'swiping');
      await client.emitWithAck('session:start');
      const card = (await started).deck[0]!.id;
      expect(await swipe(client, card)).toEqual({ ok: true });

      // Restart: a brand-new server process on the same port and database.
      await server.close();
      const backAgain = nextState(client, (v) => v.members[0]?.connected === true);
      server = await createServer({ port, databaseUrl: db.url });

      const view = await backAgain;
      expect(view.status).toBe('swiping');
      expect(view.members[0]).toMatchObject({ id: host.memberId, swipedCount: 1 });
      expect(await swipe(client, view.deck[1]!.id)).toEqual({ ok: true });
    } finally {
      client.disconnect();
      await server.close();
    }
  }, 20_000);
});

function nextState(client: Client, predicate: (v: SessionView) => boolean): Promise<SessionView> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for state')), 10_000);
    const listener = (view: SessionView) => {
      if (!predicate(view)) return;
      clearTimeout(timer);
      client.off('session:state', listener);
      resolve(view);
    };
    client.on('session:state', listener);
  });
}

const swipe = (client: Client, cardId: string) =>
  client.emitWithAck('swipe', { cardId, direction: 'like' }) as Promise<AckResult>;
