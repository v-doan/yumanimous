import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import {
  CreateShoppingListSchema,
  MemberPreferencesSchema,
  SetShoppingServingsSchema,
  ToggleShoppingLineSchema,
  SocketAuthSchema,
  SwipeInputSchema,
  type Ack,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@yumanimous/shared';
import { clientIp, TokenBucket, WindowCounter, type Limits } from '../security/limits.js';
import { SessionError, type SessionService } from '../sessions/sessionService.js';

interface SocketData {
  code: string;
  memberId: string;
  /** The client's IP (see clientIp), for per-IP limits. */
  ip: string;
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
  /**
   * Browser origins allowed to open a socket. A handshake that carries any other
   * Origin is refused (defence in depth: auth is a token, not a cookie, so a
   * cross-site page couldn't act as a member anyway). Unset: any origin (dev).
   */
  allowedOrigins?: string[] | undefined;
  /** Rate limits; omitted in tests and local development. */
  limits?: Limits | undefined;
  /** Proxies in front of the API that append to X-Forwarded-For (Fly: 1). */
  trustedProxies?: number;
}

/** What a client sees when it's going too fast. Kept friendly: it's usually a fast thumb. */
const SLOW_DOWN = 'Slow down a little and try again.';
const TOO_MANY_DECKS =
  'That’s a lot of decks and lists in the last hour. Give it a little while and try again.';

/**
 * Socket.io transport. One room per session code. All decisions are delegated to
 * SessionService; this layer authenticates, validates payloads, tracks presence
 * and relays the service's events to the right room.
 */
export function attachRealtime(
  httpServer: HttpServer,
  service: SessionService,
  { webOrigin, allowedOrigins, limits, trustedProxies = 0 }: RealtimeOptions = {},
) {
  const io: AppServer = new Server(httpServer, {
    serveClient: false,
    // Real payloads are well under 1 KB; reject anything big before it's parsed.
    maxHttpBufferSize: 10_000,
    ...(webOrigin ? { cors: { origin: webOrigin } } : {}),
    // Browsers always send Origin on cross-site requests, so a missing Origin can't
    // be a cross-site page (same-origin polling and non-browser clients omit it).
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      const ok = !allowedOrigins || !origin || allowedOrigins.includes(origin);
      callback(ok ? null : 'Origin not allowed', ok);
    },
  });

  const connections = limits ? new WindowCounter(limits.connectPerMin, 60_000) : null;
  const costly = limits ? new WindowCounter(limits.costlyPerHour, 60 * 60_000) : null;

  // A member can have several sockets (two tabs). They're offline only when the
  // last one closes. Key: `${code}:${memberId}`, value: open socket count. Removal
  // after the grace period is the service's presence sweep, not a timer here.
  const presence = new Map<string, number>();
  const key = (code: string, memberId: string) => `${code}:${memberId}`;

  // Handshake auth: the rejoin token proves who this socket is. No token, no room.
  io.use(async (socket, next) => {
    const ip = clientIp(
      socket.handshake.headers['x-forwarded-for'],
      socket.handshake.address,
      trustedProxies,
    );
    // Before any database work, so a flood of handshakes stays cheap to refuse.
    if (connections && !connections.take(ip)) return next(new Error('rate_limited'));
    const auth = SocketAuthSchema.safeParse(socket.handshake.auth);
    if (!auth.success) return next(new Error('unauthorized'));
    const memberId = await service.authenticate(auth.data.code, auth.data.token);
    if (!memberId) return next(new Error('unauthorized'));
    socket.data = { code: auth.data.code, memberId, ip };
    next();
  });

  io.on('connection', async (socket: AppSocket) => {
    const { code, memberId } = socket.data;
    void socket.join(code);

    presence.set(key(code, memberId), (presence.get(key(code, memberId)) ?? 0) + 1);

    // Per-socket throttles: swipes allow a fast thumb's burst; everything else is rare.
    const swipes = limits ? new TokenBucket(limits.swipeBurst, limits.swipesPerSecond) : null;
    const others = limits
      ? new TokenBucket(limits.otherEventsPer10s, limits.otherEventsPer10s / 10)
      : null;
    /** Checked before the handler runs; throwing here becomes the ack's error. */
    const allow = (bucket: TokenBucket | null, isCostly = false) => {
      if (bucket && !bucket.take()) throw new SessionError('not_allowed', SLOW_DOWN);
      // Per IP, not per socket: reconnecting must not reset what's been spent.
      if (isCostly && costly && !costly.take(socket.data.ip)) {
        throw new SessionError('not_allowed', TOO_MANY_DECKS);
      }
    };

    socket.on(
      'swipe',
      handle(async (input: unknown) => {
        allow(swipes);
        await service.swipe(code, memberId, SwipeInputSchema.parse(input));
      }),
    );
    socket.on(
      'session:start',
      handle(async () => {
        allow(others, true);
        await service.start(code, memberId);
      }),
    );
    socket.on(
      'preferences:set',
      handle(async (input: unknown) => {
        allow(others);
        // The client sends enum-only data, but it's still untrusted: validate it.
        await service.setPreferences(code, memberId, MemberPreferencesSchema.parse(input));
      }),
    );
    socket.on(
      'session:rebuild',
      handle(async () => {
        allow(others, true);
        await service.rebuildDeck(code, memberId);
      }),
    );
    socket.on(
      'session:leave',
      // Never throttled: leaving must always work.
      handle(() => service.removeMember(code, memberId)),
    );
    socket.on(
      'shopping:create',
      handle(async (input: unknown) => {
        allow(others, true);
        await service.createShoppingList(code, memberId, CreateShoppingListSchema.parse(input));
      }),
    );
    socket.on(
      'shopping:toggle',
      handle(async (input: unknown) => {
        // Ticking through a list is quick work: it shares the swipe allowance.
        allow(swipes);
        await service.toggleShoppingLine(code, memberId, ToggleShoppingLineSchema.parse(input));
      }),
    );
    socket.on(
      'shopping:servings',
      handle(async (input: unknown) => {
        allow(swipes);
        await service.setShoppingServings(code, memberId, SetShoppingServingsSchema.parse(input));
      }),
    );
    socket.on(
      'suggestion:accept',
      handle(async () => {
        allow(others);
        await service.acceptSuggestion(code, memberId);
      }),
    );
    socket.on(
      'session:replay',
      handle(async () => {
        allow(others, true);
        await service.playAgain(code, memberId);
      }),
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
