import { beforeEach, describe, expect, it } from 'vitest';
import type { Card } from '@yumanimous/shared';
import type { DeckSource } from '../deck/deckSource.js';
import { SessionService, type SessionEvent } from './sessionService.js';
import { InMemorySessionStore } from './sessionStore.js';

const deck: Card[] = ['soup', 'salad', 'stew'].map((id) => ({
  id,
  title: id,
  tags: [],
  blurb: `${id}!`,
}));
const deckSource: DeckSource = { mode: 'cook-in', buildDeck: async () => deck };

let clock: number;
let service: SessionService;
let store: InMemorySessionStore;
let events: SessionEvent[];

beforeEach(() => {
  clock = 1_000;
  store = new InMemorySessionStore();
  service = new SessionService({ store, deckSource, now: () => clock });
  events = [];
  service.subscribe((e) => events.push(e));
});

/** Host + guests in a started session. */
async function startedSession(guests: string[], matchRule: 'everyone' | 'majority' = 'everyone') {
  const host = await service.create({ hostName: 'Host', matchRule });
  const others = [];
  for (const name of guests) others.push(await service.join(host.code, name));
  await service.start(host.code, host.memberId);
  return { code: host.code, ids: [host.memberId, ...others.map((o) => o.memberId)] };
}

const matchEvents = () => events.filter((e) => e.type === 'match');

describe('create / preview / join', () => {
  it('creates a lobby with the host as the only member', async () => {
    const { code, memberId } = await service.create({ hostName: 'Vy', matchRule: 'everyone' });
    const view = await service.view(code);
    expect(view.status).toBe('lobby');
    expect(view.members).toEqual([expect.objectContaining({ id: memberId, isHost: true })]);
    expect(view.deck.map((c) => c.id)).toEqual(['soup', 'salad', 'stew']);
  });

  it('never exposes token hashes in the view', async () => {
    const { code } = await service.create({ hostName: 'Vy', matchRule: 'everyone' });
    expect(JSON.stringify(await service.view(code))).not.toMatch(/tokenHash/);
  });

  it('previews a session for the join screen', async () => {
    const { code } = await service.create({ hostName: 'Vy', matchRule: 'majority' });
    expect(await service.preview(code)).toMatchObject({
      hostName: 'Vy',
      matchRule: 'majority',
      memberCount: 1,
      full: false,
    });
  });

  it('rejects a duplicate name, ignoring case', async () => {
    const { code } = await service.create({ hostName: 'Vy', matchRule: 'everyone' });
    await expect(service.join(code, 'vy')).rejects.toMatchObject({ code: 'name_taken' });
  });

  it('caps sessions at 10 members', async () => {
    const { code } = await service.create({ hostName: 'Host', matchRule: 'everyone' });
    for (let i = 1; i < 10; i++) await service.join(code, `Guest ${i}`);
    await expect(service.join(code, 'One too many')).rejects.toMatchObject({ code: 'full' });
  });

  it('reports unknown sessions as not_found', async () => {
    await expect(service.join('ZZZZZZ', 'Sam')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('authenticates only the right token for the right session', async () => {
    const a = await service.create({ hostName: 'A', matchRule: 'everyone' });
    const b = await service.create({ hostName: 'B', matchRule: 'everyone' });
    expect(await service.authenticate(a.code, a.token)).toBe(a.memberId);
    expect(await service.authenticate(a.code, b.token)).toBeNull();
    expect(await service.authenticate(a.code, 'x'.repeat(43))).toBeNull();
  });
});

describe('start', () => {
  it('only the host can start', async () => {
    const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
    const guest = await service.join(host.code, 'Sam');
    await expect(service.start(host.code, guest.memberId)).rejects.toMatchObject({
      code: 'not_host',
    });
    await service.start(host.code, host.memberId);
    expect((await service.view(host.code)).status).toBe('swiping');
  });

  it('rejects swipes before the start', async () => {
    const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
    await expect(
      service.swipe(host.code, host.memberId, { cardId: 'soup', direction: 'like' }),
    ).rejects.toMatchObject({ code: 'not_started' });
  });
});

describe('swipe and matching', () => {
  it('declares a match once everyone likes a card, exactly once', async () => {
    const { code, ids } = await startedSession(['Sam']);
    await service.swipe(code, ids[0]!, { cardId: 'soup', direction: 'like' });
    expect(matchEvents()).toHaveLength(0);

    await service.swipe(code, ids[1]!, { cardId: 'soup', direction: 'like' });
    await service.swipe(code, ids[1]!, { cardId: 'salad', direction: 'skip' });
    expect(matchEvents()).toEqual([{ type: 'match', code, cardId: 'soup' }]);
    expect((await service.view(code)).matches).toEqual([{ cardId: 'soup', matchedAt: 1_000 }]);
  });

  it('keeps the first swipe when a member swipes the same card twice', async () => {
    const { code, ids } = await startedSession([]);
    await service.swipe(code, ids[0]!, { cardId: 'soup', direction: 'skip' });
    await service.swipe(code, ids[0]!, { cardId: 'soup', direction: 'like' });
    const view = await service.view(code);
    expect(view.swipes).toEqual([{ cardId: 'soup', memberId: ids[0], direction: 'skip' }]);
  });

  it('rejects cards that are not in the deck', async () => {
    const { code, ids } = await startedSession([]);
    await expect(
      service.swipe(code, ids[0]!, { cardId: 'caviar', direction: 'like' }),
    ).rejects.toMatchObject({ code: 'unknown_card' });
  });

  it('rejects swipes from non-members', async () => {
    const { code } = await startedSession([]);
    await expect(
      service.swipe(code, 'stranger', { cardId: 'soup', direction: 'like' }),
    ).rejects.toMatchObject({ code: 'not_member' });
  });

  it('does not lose swipes that arrive at the same time', async () => {
    const { code, ids } = await startedSession(['B', 'C', 'D']);
    await Promise.all(
      ids.map((id) => service.swipe(code, id, { cardId: 'soup', direction: 'like' })),
    );
    expect((await service.view(code)).swipes).toHaveLength(4);
    expect(matchEvents()).toHaveLength(1);
  });

  it('uses the majority rule when the session asks for it', async () => {
    const { code, ids } = await startedSession(['B', 'C'], 'majority');
    await service.swipe(code, ids[0]!, { cardId: 'stew', direction: 'like' });
    await service.swipe(code, ids[1]!, { cardId: 'stew', direction: 'like' });
    expect(matchEvents()).toEqual([{ type: 'match', code, cardId: 'stew' }]);
  });

  it('marks the session finished when everyone has swiped every card', async () => {
    const { code, ids } = await startedSession(['Sam']);
    for (const id of ids) {
      for (const card of deck)
        await service.swipe(code, id, { cardId: card.id, direction: 'skip' });
    }
    expect((await service.view(code)).finished).toBe(true);
  });

  it('a late joiner reopens a finished session and keeps existing matches', async () => {
    const { code, ids } = await startedSession([]);
    for (const card of deck)
      await service.swipe(code, ids[0]!, { cardId: card.id, direction: 'like' });
    expect((await service.view(code)).matches).toHaveLength(3);

    await service.join(code, 'Late');
    const view = await service.view(code);
    expect(view.finished).toBe(false);
    expect(view.matches).toHaveLength(3); // Sticky.
  });
});

describe('leaving and presence', () => {
  it('removing the only skipper turns the card into a match', async () => {
    const { code, ids } = await startedSession(['Sam', 'Skipper']);
    await service.swipe(code, ids[0]!, { cardId: 'soup', direction: 'like' });
    await service.swipe(code, ids[1]!, { cardId: 'soup', direction: 'like' });
    await service.swipe(code, ids[2]!, { cardId: 'soup', direction: 'skip' });
    expect(matchEvents()).toHaveLength(0);

    await service.removeMember(code, ids[2]!);
    expect(matchEvents()).toEqual([{ type: 'match', code, cardId: 'soup' }]);
    const view = await service.view(code);
    expect(view.members).toHaveLength(2);
    expect(view.swipes.some((s) => s.memberId === ids[2])).toBe(false);
  });

  it('hands the host role to the earliest online member when the host leaves', async () => {
    const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
    clock += 1;
    const offline = await service.join(host.code, 'Offline');
    clock += 1;
    const online = await service.join(host.code, 'Online');
    await service.setConnected(host.code, online.memberId, true);

    await service.removeMember(host.code, host.memberId);
    const view = await service.view(host.code);
    expect(view.members.find((m) => m.isHost)?.id).toBe(online.memberId);
    expect(view.members.find((m) => m.id === offline.memberId)?.isHost).toBe(false);
  });

  it('falls back to the earliest member when nobody is online', async () => {
    const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
    const guest = await service.join(host.code, 'Guest');
    await service.removeMember(host.code, host.memberId);
    expect((await service.view(host.code)).members[0]).toMatchObject({
      id: guest.memberId,
      isHost: true,
    });
  });

  it('deletes the session when the last member leaves', async () => {
    const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
    await service.removeMember(host.code, host.memberId);
    expect(events).toContainEqual({ type: 'ended', code: host.code });
    await expect(service.view(host.code)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('ignores removal of a member who is already gone', async () => {
    const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
    await service.join(host.code, 'Guest');
    events = [];
    await service.removeMember(host.code, 'nobody');
    await service.removeMember('ZZZZZZ', 'nobody');
    expect(events).toEqual([]);
  });

  it('only broadcasts presence when it actually changes', async () => {
    const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
    await service.setConnected(host.code, host.memberId, true);
    await service.setConnected(host.code, host.memberId, true);
    expect(events.filter((e) => e.type === 'changed')).toHaveLength(1);
  });
});

describe('sweepIdle', () => {
  it('removes sessions idle longer than the limit', async () => {
    const old = await service.create({ hostName: 'Old', matchRule: 'everyone' });
    clock += 10_000;
    const fresh = await service.create({ hostName: 'Fresh', matchRule: 'everyone' });
    expect(await service.sweepIdle(5_000)).toBe(1);
    await expect(service.view(old.code)).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.view(fresh.code)).resolves.toBeDefined();
  });
});
