import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type {
  AckResult,
  ClientToServerEvents,
  Membership,
  ServerToClientEvents,
  SessionView,
} from '@yumanimous/shared';
import { createServer } from '../createServer.js';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

const GRACE_MS = 150;
let server: Awaited<ReturnType<typeof createServer>>;
const clients: Client[] = [];

beforeEach(async () => {
  server = await createServer({ port: 0, graceMs: GRACE_MS, presenceSweepMs: 50 });
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await server.close();
});

async function post<T>(path: string, body: object): Promise<T> {
  const res = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

const createSession = (matchRule = 'everyone') =>
  post<Membership>('/api/sessions', { hostName: 'Host', matchRule });
const joinSession = (code: string, name: string) =>
  post<Membership>(`/api/sessions/${code}/members`, { name });

/** Connects and resolves once the first state snapshot arrives. */
async function connectAs(m: Pick<Membership, 'code' | 'token'>) {
  const client: Client = connect(server.url, {
    auth: { code: m.code, token: m.token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  clients.push(client);
  const firstState = await nextEvent(client, 'session:state');
  return { client, firstState };
}

function nextEvent<E extends keyof ServerToClientEvents>(
  client: Client,
  event: E,
  predicate: (...args: Parameters<ServerToClientEvents[E]>) => boolean = () => true,
): Promise<Parameters<ServerToClientEvents[E]>[0]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 2_000);
    const listener = (...args: Parameters<ServerToClientEvents[E]>) => {
      if (!predicate(...args)) return;
      clearTimeout(timer);
      client.off(event, listener as never);
      resolve(args[0]);
    };
    client.on(event, listener as never);
  });
}

const waitForState = (client: Client, predicate: (v: SessionView) => boolean) =>
  nextEvent(client, 'session:state', predicate) as Promise<SessionView>;

const swipe = (client: Client, cardId: string, direction: 'like' | 'skip') =>
  client.emitWithAck('swipe', { cardId, direction }) as Promise<AckResult>;

describe('handshake', () => {
  it('rejects a connection without a valid token', async () => {
    const host = await createSession();
    const client: Client = connect(server.url, {
      auth: { code: host.code, token: 'x'.repeat(43) },
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(client);
    const err = await new Promise<Error>((resolve) => client.on('connect_error', resolve));
    expect(err.message).toBe('unauthorized');
  });

  it('sends the session state on connect and marks the member online', async () => {
    const host = await createSession();
    const { firstState } = await connectAs(host);
    expect(firstState.code).toBe(host.code);
    expect(firstState.members[0]).toMatchObject({ id: host.memberId, connected: true });
  });
});

describe('a two-person session', () => {
  it('syncs joins, start, swipes and the match to everyone', async () => {
    const hostM = await createSession();
    const { client: host } = await connectAs(hostM);

    // Listen before acting: the broadcast can beat the REST response back to us.
    const hostSeesGuest = waitForState(host, (v) => v.members.length === 2);
    const guestM = await joinSession(hostM.code, 'Sam');
    await hostSeesGuest; // The host sees the guest arrive in the lobby.
    const { client: guest } = await connectAs(guestM);

    // Only the host can start.
    expect(await guest.emitWithAck('session:start')).toEqual({
      ok: false,
      error: 'Only the host can start',
    });
    const started = waitForState(guest, (v) => v.status === 'swiping');
    expect(await host.emitWithAck('session:start')).toEqual({ ok: true });
    const view = await started;
    const firstCard = view.deck[0]!.id;

    const hostMatch = nextEvent(host, 'session:match');
    const guestMatch = nextEvent(guest, 'session:match');
    expect(await swipe(host, firstCard, 'like')).toEqual({ ok: true });
    expect(await swipe(guest, firstCard, 'like')).toEqual({ ok: true });

    expect(await hostMatch).toEqual({ cardId: firstCard });
    expect(await guestMatch).toEqual({ cardId: firstCard });
  });

  it('acks invalid swipe payloads with an error instead of crashing', async () => {
    const hostM = await createSession();
    const { client } = await connectAs(hostM);
    await client.emitWithAck('session:start');
    const bad = (await client.emitWithAck('swipe', {
      cardId: 'x',
      direction: 'superlike',
    } as never)) as AckResult;
    expect(bad).toEqual({ ok: false, error: 'Invalid input' });
    expect(await swipe(client, 'caviar', 'like')).toEqual({
      ok: false,
      error: 'That card is not in this deck',
    });
  });
});

describe('food rules', () => {
  const vegan = {
    diets: ['vegan'],
    intolerances: [],
    avoidIngredients: [],
    maxReadyMinutes: null,
    cuisinesLiked: [],
    cuisinesDisliked: [],
    cravings: [],
    unsupported: [],
  };

  it('saves a member’s rules and shows them to the group', async () => {
    const hostM = await createSession();
    const { client: host } = await connectAs(hostM);
    const guestM = await joinSession(hostM.code, 'Sam');
    const { client: guest } = await connectAs(guestM);

    const hostSees = waitForState(host, (v) =>
      v.members.some((m) => m.id === guestM.memberId && m.preferences?.diets[0] === 'vegan'),
    );
    expect(await guest.emitWithAck('preferences:set', vegan as never)).toEqual({ ok: true });
    await hostSees;
  });

  it('rejects rules outside the allowed values', async () => {
    const hostM = await createSession();
    const { client } = await connectAs(hostM);
    const bad = { ...vegan, diets: ['carnivore'] };
    expect(await client.emitWithAck('preferences:set', bad as never)).toEqual({
      ok: false,
      error: 'Invalid input',
    });
  });

  it('lets only the host rebuild the deck', async () => {
    const hostM = await createSession();
    const guestM = await joinSession(hostM.code, 'Sam');
    const { client: host } = await connectAs(hostM);
    const { client: guest } = await connectAs(guestM);
    await host.emitWithAck('session:start');

    expect(await guest.emitWithAck('session:rebuild')).toEqual({
      ok: false,
      error: 'Only the host can rebuild the deck',
    });
    expect(await host.emitWithAck('session:rebuild')).toEqual({ ok: true });
  });
});

describe('presence', () => {
  it('a refresh within the grace period keeps the member and their swipes', async () => {
    const hostM = await createSession();
    const guestM = await joinSession(hostM.code, 'Sam');
    const { client: host } = await connectAs(hostM);
    const { client: guest } = await connectAs(guestM);
    const started = waitForState(guest, (v) => v.status === 'swiping');
    await host.emitWithAck('session:start');
    const card = (await started).deck[0]!.id;
    await swipe(guest, card, 'like');

    const offline = waitForState(host, (v) =>
      v.members.some((m) => m.id === guestM.memberId && !m.connected),
    );
    guest.disconnect();
    await offline;

    const { firstState } = await connectAs(guestM); // Same token = same identity.
    expect(firstState.members.find((m) => m.id === guestM.memberId)).toMatchObject({
      connected: true,
      swipedCount: 1,
    });
  });

  it('removes a member after the grace period and hands over the host role', async () => {
    const hostM = await createSession();
    const guestM = await joinSession(hostM.code, 'Sam');
    const { client: host } = await connectAs(hostM);
    const { client: guest } = await connectAs(guestM);

    const handedOver = waitForState(guest, (v) => v.members.length === 1);
    host.disconnect();
    const view = await handedOver;
    expect(view.members[0]).toMatchObject({ id: guestM.memberId, isHost: true });
  });

  it('leaving tells the member their session ended and removes them at once', async () => {
    const hostM = await createSession();
    const guestM = await joinSession(hostM.code, 'Sam');
    const { client: host } = await connectAs(hostM);
    const { client: guest } = await connectAs(guestM);

    const ended = nextEvent(guest, 'session:ended');
    const hostSeesLeave = waitForState(host, (v) => v.members.length === 1);
    guest.emit('session:leave', () => {});
    expect(await ended).toBe('removed');
    await hostSeesLeave;

    // The old token no longer works.
    const retry: Client = connect(server.url, {
      auth: { code: guestM.code, token: guestM.token },
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(retry);
    const err = await new Promise<Error>((resolve) => retry.on('connect_error', resolve));
    expect(err.message).toBe('unauthorized');
  });
});
