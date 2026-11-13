import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import {
  MemberPreferencesSchema,
  SocketAuthSchema,
  SwipeInputSchema,
  type Ack,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@yumanimous/shared';
import { SessionError, type SessionService } from '../sessions/sessionService.js';

interface SocketData {
  code: string;
  memberId: string;
  /** Set when the member was removed, so the disconnect handler doesn't start a grace timer. */
  removed?: boolean;
}

type AppServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export interface RealtimeOptions {
  webOrigin?: string | undefined;
}

/**
 * Socket.io transport. One room per session code. All decisions are delegated to
 * SessionService; this layer authenticates, validates payloads, tracks presence
 * and relays the service's events to the right room.
 */
export function attachRealtime(
  httpServer: HttpServer,
  service: SessionService,
  { webOrigin }: RealtimeOptions = {},
) {
  const io: AppServer = new Server(httpServer, {
    serveClient: false,
    // Real payloads are well under 1 KB; reject anything big before it's parsed.
    maxHttpBufferSize: 10_000,
    ...(webOrigin ? { cors: { origin: webOrigin } } : {}),
  });

  // A member can have several sockets (two tabs). They're offline only when the
  // last one closes. Key: `${code}:${memberId}`, value: open socket count. Removal
  // after the grace period is the service's presence sweep, not a timer here.
  const presence = new Map<string, number>();
  const key = (code: string, memberId: string) => `${code}:${memberId}`;

  // Handshake auth: the rejoin token proves who this socket is. No token, no room.
  io.use(async (socket, next) => {
    const auth = SocketAuthSchema.safeParse(socket.handshake.auth);
    if (!auth.success) return next(new Error('unauthorized'));
    const memberId = await service.authenticate(auth.data.code, auth.data.token);
    if (!memberId) return next(new Error('unauthorized'));
    socket.data = { code: auth.data.code, memberId };
    next();
  });

  io.on('connection', async (socket: AppSocket) => {
    const { code, memberId } = socket.data;
    void socket.join(code);

    presence.set(key(code, memberId), (presence.get(key(code, memberId)) ?? 0) + 1);

    socket.on(
      'swipe',
      handle(async (input: unknown) => {
        await service.swipe(code, memberId, SwipeInputSchema.parse(input));
      }),
    );
    socket.on(
      'session:start',
      handle(() => service.start(code, memberId)),
    );
    socket.on(
      'preferences:set',
      handle(async (input: unknown) => {
        // The client sends enum-only data, but it's still untrusted: validate it.
        await service.setPreferences(code, memberId, MemberPreferencesSchema.parse(input));
      }),
    );
    socket.on(
      'session:rebuild',
      handle(() => service.rebuildDeck(code, memberId)),
    );
    socket.on(
      'session:leave',
      handle(() => service.removeMember(code, memberId)),
    );

    socket.on('disconnect', () => {
      const remaining = (presence.get(key(code, memberId)) ?? 1) - 1;
      if (remaining > 0) {
        presence.set(key(code, memberId), remaining);
        return;
      }
      presence.delete(key(code, memberId));
      if (!socket.data.removed) void service.setConnected(code, memberId, false).catch(logError);
    });

    try {
      await service.setConnected(code, memberId, true);
      // setConnected only broadcasts on a change; a second tab still needs a snapshot.
      socket.emit('session:state', await service.view(code));
    } catch (err) {
      logError(err);
      socket.disconnect(true);
    }
  });

  const unsubscribe = service.subscribe((event) => {
    switch (event.type) {
      case 'changed':
        io.to(event.code).emit('session:state', event.view);
        break;
      case 'match':
        io.to(event.code).emit('session:match', { cardId: event.cardId });
        break;
      case 'deck-progress':
        io.to(event.code).emit('deck:progress', { stage: event.stage });
        break;
      case 'member-removed':
        for (const socket of socketsOf(event.code, event.memberId)) {
          socket.data.removed = true;
          socket.emit('session:ended', 'removed');
          // Let the 'removed' event and any pending ack flush before closing.
          setImmediate(() => socket.disconnect(true));
        }
        break;
      case 'ended':
        io.to(event.code).emit('session:ended', 'expired');
        io.in(event.code).disconnectSockets(true);
        break;
    }
  });

  function socketsOf(code: string, memberId: string): AppSocket[] {
    const room = io.sockets.adapter.rooms.get(code) ?? new Set<string>();
    return [...room]
      .map((id) => io.sockets.sockets.get(id))
      .filter((s): s is AppSocket => s?.data.memberId === memberId);
  }

  return {
    io,
    close: async () => {
      unsubscribe();
      presence.clear();
      await io.close();
    },
  };
}

/**
 * Wraps an event handler so every client call gets exactly one ack. Expected
 * failures (SessionError, bad payload) return their message; anything else is
 * logged and reported generically so internals don't leak to clients.
 */
function handle<Args extends unknown[]>(fn: (...args: Args) => Promise<void>) {
  return async (...args: [...Args, Ack]) => {
    const last: unknown = args.at(-1);
    if (typeof last !== 'function') return; // Clients must ask for an ack.
    const ack = last as Ack;
    try {
      await fn(...(args.slice(0, -1) as Args));
      ack({ ok: true });
    } catch (err) {
      if (err instanceof SessionError) return ack({ ok: false, error: err.message });
      if (err instanceof z.ZodError) return ack({ ok: false, error: 'Invalid input' });
      logError(err);
      ack({ ok: false, error: 'Something went wrong' });
    }
  };
}

function logError(err: unknown) {
  console.error('[realtime]', err);
}
