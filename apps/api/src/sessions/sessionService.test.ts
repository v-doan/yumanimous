import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyPreferences,
  type Card,
  type GroupPreferences,
  type MemberPreferences,
} from '@yumanimous/shared';
import { DeckError, type DeckSource } from '../deck/deckSource.js';
import { FollowUpError, type FollowUps } from '../followUps/followUps.js';
import { buildLines } from '../followUps/shoppingList.js';
import { SessionService, type SessionEvent } from './sessionService.js';
import { createTestDatabase, databaseUrl } from '@yumanimous/db/testing';
import { PostgresSessionStore } from './postgresSessionStore.js';
import { InMemorySessionStore, type SessionStore } from './sessionStore.js';

const deck: Card[] = ['soup', 'salad', 'stew'].map((id) => ({
  id,
  title: id,
  tags: [],
  blurb: `${id}!`,
}));
/** Records the merged rules each deck was asked to satisfy. */
let deckRequests: (GroupPreferences | undefined)[] = [];
let nextDeck: Card[] | Error = deck;
const deckSource: DeckSource = {
  mode: 'cook-in',
  buildDeck: async (group) => {
    deckRequests.push(group);
    if (nextDeck instanceof Error) throw nextDeck;
    return nextDeck;
  },
};

// Phase 7: recipe cards (only those have ingredients), and fake follow-ups.
const recipeDeck: Card[] = [1, 2, 3].map((n) => ({
  id: `spoonacular:${n}`,
  title: `Recipe ${n}`,
  tags: [],
  blurb: 'Tasty.',
}));
const garlic = [{ name: 'garlic', amount: 2, unit: 'cloves', aisle: 'Produce' }];
let listCalls = 0;
let mediateCalls = 0;
let listGate: Promise<void> = Promise.resolve();
let listError: Error | null = null;
const followUps: FollowUps = {
  shoppingList: async ({ servings }) => {
    listCalls++;
    await listGate;
    if (listError) throw listError;
    const plan = [{ name: 'Garlic', aisle: 'Produce', covers: [0], likelyAtHome: false }];
    return {
      recipeServings: 2,
      ingredients: garlic,
      lines: buildLines(plan, garlic, servings, 2),
      source: 'ai',
    };
  },
  mediate: async ({ contenders }) => {
    mediateCalls++;
    return { cardId: contenders[0]!.cardId, reason: 'It got the most yums.', source: 'fallback' };
  },
};

const prefs = (p: Partial<MemberPreferences>): MemberPreferences => ({
  ...emptyPreferences(),
  ...p,
});

// The same behaviour tests run against both stores. That's the proof that Postgres
// and the in-memory store are interchangeable behind the SessionStore interface.
describe.each(['memory', 'postgres'] as const)('SessionService with %s store', (kind) => {
  describe.skipIf(kind === 'postgres' && !databaseUrl)('', () => {
    let clock: number;
    let service: SessionService;
    let store: SessionStore;
    let events: SessionEvent[];
    let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;

    beforeAll(async () => {
      if (kind === 'postgres') db = await createTestDatabase();
    });
    afterAll(async () => {
      await db?.drop();
    });

    beforeEach(async () => {
      clock = 1_000;
      deckRequests = [];
      nextDeck = deck;
      if (db) await db.reset();
      store = db ? new PostgresSessionStore(db.pool) : new InMemorySessionStore();
      service = new SessionService({ store, deckSource, now: () => clock });
      events = [];
      service.subscribe((e) => events.push(e));
    });

    /** Host + guests in a started session. */
    async function startedSession(
      guests: string[],
      matchRule: 'everyone' | 'majority' = 'everyone',
    ) {
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
        // The deck waits for everyone's food rules: it's built at the start.
        expect(view.deck).toEqual([]);
        expect(view.deckFilters).toBeNull();
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

    describe('food rules and the deck', () => {
      it('builds the deck at the start from everyone’s merged hard rules', async () => {
        const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
        const sam = await service.join(host.code, 'Sam');
        await service.setPreferences(host.code, host.memberId, prefs({ diets: ['vegetarian'] }));
        await service.setPreferences(
          host.code,
          sam.memberId,
          prefs({ intolerances: ['peanut'], maxReadyMinutes: 30 }),
        );
        expect(deckRequests).toEqual([]); // Nothing built in the lobby.

        await service.start(host.code, host.memberId);
        const hard = {
          diets: ['vegetarian'],
          intolerances: ['peanut'],
          excludeIngredients: [],
          maxReadyMinutes: 30,
        };
        expect(deckRequests[0]?.hard).toEqual(hard);
        const view = await service.view(host.code);
        expect(view.deck.map((c) => c.id)).toEqual(['soup', 'salad', 'stew']);
        expect(view.deckFilters).toEqual(hard);
        expect(view.uncovered).toEqual([]);
        expect(view.members.find((m) => m.id === sam.memberId)?.preferences).toMatchObject({
          intolerances: ['peanut'],
        });
      });

      it('warns about a late joiner’s rule the deck was never filtered for', async () => {
        const { code } = await startedSession([]);
        const kim = await service.join(code, 'Kim');
        await service.setPreferences(code, kim.memberId, prefs({ intolerances: ['shellfish'] }));
        expect((await service.view(code)).uncovered).toEqual([
          { rule: 'no shellfish', members: ['Kim'] },
        ]);
      });

      it('rebuilds the deck for everyone’s current rules and clears the votes', async () => {
        const { code, ids } = await startedSession([]);
        await service.swipe(code, ids[0]!, { cardId: 'soup', direction: 'like' });
        expect((await service.view(code)).matches).toHaveLength(1);
        const kim = await service.join(code, 'Kim');
        await service.setPreferences(code, kim.memberId, prefs({ intolerances: ['shellfish'] }));

        nextDeck = [{ id: 'tofu', title: 'Tofu', tags: [], blurb: 'Tofu!' }];
        await service.rebuildDeck(code, ids[0]!);

        expect(deckRequests.at(-1)?.hard.intolerances).toEqual(['shellfish']);
        const view = await service.view(code);
        expect(view.deck.map((c) => c.id)).toEqual(['tofu']);
        expect(view.swipes).toEqual([]);
        expect(view.matches).toEqual([]);
        expect(view.uncovered).toEqual([]);
      });

      it('only the host can rebuild, and only once swiping', async () => {
        const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
        const sam = await service.join(host.code, 'Sam');
        await expect(service.rebuildDeck(host.code, host.memberId)).rejects.toMatchObject({
          code: 'not_started',
        });
        await service.start(host.code, host.memberId);
        await expect(service.rebuildDeck(host.code, sam.memberId)).rejects.toMatchObject({
          code: 'not_host',
        });
      });

      it('cannot start twice', async () => {
        const { code, ids } = await startedSession([]);
        await expect(service.start(code, ids[0]!)).rejects.toMatchObject({
          code: 'already_started',
        });
      });

      it('passes a deck failure to the host as a readable error and stays in the lobby', async () => {
        const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
        nextDeck = new DeckError('Only 1 recipe fits everyone’s rules (vegan).');
        await expect(service.start(host.code, host.memberId)).rejects.toMatchObject({
          code: 'deck_unavailable',
          message: 'Only 1 recipe fits everyone’s rules (vegan).',
        });
        expect((await service.view(host.code)).status).toBe('lobby');
      });

      it('rejects preferences from non-members', async () => {
        const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
        await expect(
          service.setPreferences(host.code, 'stranger', prefs({})),
        ).rejects.toMatchObject({ code: 'not_member' });
      });

      it('forgets a member’s rules when they leave', async () => {
        const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
        const sam = await service.join(host.code, 'Sam');
        await service.setPreferences(host.code, sam.memberId, prefs({ diets: ['vegan'] }));
        await service.removeMember(host.code, sam.memberId);
        await service.start(host.code, host.memberId);
        expect(deckRequests[0]?.hard.diets).toEqual([]);
      });
    });

    describe('blurbs that arrive after the deck', () => {
      const cards: Card[] = ['a', 'b'].map((id) => ({
        id,
        title: id,
        tags: [],
        blurb: `Recipe blurb ${id}.`,
      }));

      it('are swapped into the live deck by card id', async () => {
        let late: ((b: Map<string, string>) => void) | undefined;
        const svc = new SessionService({
          store,
          deckSource: {
            mode: 'cook-in',
            buildDeck: async (_group, context) => {
              late = context?.onBlurbs;
              return cards;
            },
          },
          now: () => clock,
        });
        const host = await svc.create({ hostName: 'Host', matchRule: 'everyone' });
        await svc.start(host.code, host.memberId);

        late!(
          new Map([
            ['b', 'Written by the AI for b.'],
            ['gone', 'For a card not in this deck.'],
          ]),
        );
        await vi.waitFor(async () =>
          expect((await svc.view(host.code)).deck.map((c) => c.blurb)).toEqual([
            'Recipe blurb a.',
            'Written by the AI for b.',
          ]),
        );
      });

      it('are held when they arrive before the deck is saved, then applied', async () => {
        const svc = new SessionService({
          store,
          deckSource: {
            mode: 'cook-in',
            buildDeck: async (_group, context) => {
              // The writer finished before start() saved the deck.
              context?.onBlurbs?.(new Map([['a', 'Early AI blurb for a.']]));
              return cards;
            },
          },
          now: () => clock,
        });
        const host = await svc.create({ hostName: 'Host', matchRule: 'everyone' });
        await svc.start(host.code, host.memberId);
        await vi.waitFor(async () =>
          expect((await svc.view(host.code)).deck[0]!.blurb).toBe('Early AI blurb for a.'),
        );
      });
    });

    describe('one deck build at a time', () => {
      /** A deck source whose build only finishes when the test says so. */
      function slowDeckSource() {
        let builds = 0;
        let release: (cards: Card[] | Error) => void = () => {};
        const source: DeckSource = {
          mode: 'cook-in',
          buildDeck: () => {
            builds++;
            return new Promise<Card[]>((resolve, reject) => {
              release = (result) => (result instanceof Error ? reject(result) : resolve(result));
            });
          },
        };
        return { source, builds: () => builds, release: (r: Card[] | Error) => release(r) };
      }

      it('a second Start while building joins the first build instead of paying again', async () => {
        const slow = slowDeckSource();
        const svc = new SessionService({ store, deckSource: slow.source, now: () => clock });
        const host = await svc.create({ hostName: 'Host', matchRule: 'everyone' });

        const first = svc.start(host.code, host.memberId);
        const second = svc.start(host.code, host.memberId); // Double tap / refresh.
        await vi.waitFor(() => expect(slow.builds()).toBe(1));
        slow.release(deck);

        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
        expect(slow.builds()).toBe(1);
        expect((await svc.view(host.code)).status).toBe('swiping');
        // Once it's done, a further Start is a plain "already started".
        await expect(svc.start(host.code, host.memberId)).rejects.toMatchObject({
          code: 'already_started',
        });
      });

      it('a guest can’t join or start a build', async () => {
        const slow = slowDeckSource();
        const svc = new SessionService({ store, deckSource: slow.source, now: () => clock });
        const host = await svc.create({ hostName: 'Host', matchRule: 'everyone' });
        const sam = await svc.join(host.code, 'Sam');

        const building = svc.start(host.code, host.memberId);
        await vi.waitFor(() => expect(slow.builds()).toBe(1));
        await expect(svc.start(host.code, sam.memberId)).rejects.toMatchObject({
          code: 'not_host',
        });
        slow.release(deck);
        await building;
        expect(slow.builds()).toBe(1);
      });

      it('a failed build fails every waiter, then a retry builds again', async () => {
        const slow = slowDeckSource();
        const svc = new SessionService({ store, deckSource: slow.source, now: () => clock });
        const host = await svc.create({ hostName: 'Host', matchRule: 'everyone' });

        const first = svc.start(host.code, host.memberId);
        const second = svc.start(host.code, host.memberId);
        await vi.waitFor(() => expect(slow.builds()).toBe(1));
        slow.release(new DeckError('Recipe service down'));
        await expect(first).rejects.toMatchObject({ code: 'deck_unavailable' });
        await expect(second).rejects.toMatchObject({ code: 'deck_unavailable' });
        expect((await svc.view(host.code)).status).toBe('lobby');

        const retry = svc.start(host.code, host.memberId);
        await vi.waitFor(() => expect(slow.builds()).toBe(2));
        slow.release(deck);
        await retry;
        expect((await svc.view(host.code)).status).toBe('swiping');
      });

      it('concurrent rebuilds share one build too', async () => {
        const slow = slowDeckSource();
        const svc = new SessionService({ store, deckSource: slow.source, now: () => clock });
        const host = await svc.create({ hostName: 'Host', matchRule: 'everyone' });
        const starting = svc.start(host.code, host.memberId);
        await vi.waitFor(() => expect(slow.builds()).toBe(1));
        slow.release(deck);
        await starting;

        const a = svc.rebuildDeck(host.code, host.memberId);
        const b = svc.rebuildDeck(host.code, host.memberId);
        await vi.waitFor(() => expect(slow.builds()).toBe(2));
        slow.release(deck);
        await Promise.all([a, b]);
        expect(slow.builds()).toBe(2);
      });
    });

    describe('AI re-rank', () => {
      const big: Card[] = Array.from({ length: 16 }, (_, i) => ({
        id: `c${i}`,
        title: `Card ${i}`,
        tags: [],
        blurb: `Card ${i}!`,
      }));

      it('reorders only unswiped cards, once, after every member has swiped 8', async () => {
        const rerank = vi.fn(async ({ cards }: { cards: Card[] }) =>
          cards.map((c) => c.id).reverse(),
        );
        const svc = new SessionService({
          store,
          deckSource: { mode: 'cook-in', buildDeck: async () => big, rerank },
          now: () => clock,
        });
        const seen: SessionEvent[] = [];
        svc.subscribe((e) => seen.push(e));

        const host = await svc.create({ hostName: 'Host', matchRule: 'everyone' });
        const sam = await svc.join(host.code, 'Sam');
        await svc.start(host.code, host.memberId);
        for (let i = 0; i < 8; i++) {
          await svc.swipe(host.code, host.memberId, { cardId: `c${i}`, direction: 'like' });
        }
        expect(rerank).not.toHaveBeenCalled(); // Sam hasn't swiped yet.
        for (let i = 0; i < 8; i++) {
          await svc.swipe(host.code, sam.memberId, { cardId: `c${i}`, direction: 'skip' });
        }

        await vi.waitFor(() =>
          expect(seen).toContainEqual({
            type: 'deck-progress',
            code: host.code,
            stage: 'reranked',
          }),
        );
        expect(rerank).toHaveBeenCalledOnce();
        expect(rerank.mock.calls[0]![0].cards.map((c: Card) => c.id)).toEqual(
          big.slice(8).map((c) => c.id),
        );
        const view = await svc.view(host.code);
        expect(view.deck.map((c) => c.id)).toEqual([
          ...big.slice(0, 8).map((c) => c.id),
          ...big
            .slice(8)
            .map((c) => c.id)
            .reverse(),
        ]);

        await svc.swipe(host.code, host.memberId, { cardId: 'c15', direction: 'like' });
        expect(rerank).toHaveBeenCalledOnce(); // Never twice.
      });

      it('leaves the deck alone when the AI has nothing to offer', async () => {
        const svc = new SessionService({
          store,
          deckSource: { mode: 'cook-in', buildDeck: async () => big, rerank: async () => null },
          now: () => clock,
        });
        const host = await svc.create({ hostName: 'Host', matchRule: 'everyone' });
        await svc.start(host.code, host.memberId);
        for (let i = 0; i < 8; i++) {
          await svc.swipe(host.code, host.memberId, { cardId: `c${i}`, direction: 'like' });
        }
        await new Promise((r) => setTimeout(r, 20));
        expect((await svc.view(host.code)).deck.map((c) => c.id)).toEqual(big.map((c) => c.id));
      });
    });

    describe('after the decision (Phase 7)', () => {
      let svc: SessionService;

      beforeEach(() => {
        nextDeck = recipeDeck;
        listCalls = 0;
        mediateCalls = 0;
        listGate = Promise.resolve();
        listError = null;
        svc = new SessionService({ store, deckSource, followUps, now: () => clock });
        svc.subscribe((e) => events.push(e));
      });

      async function started(guests: string[]) {
        const host = await svc.create({ hostName: 'Host', matchRule: 'everyone' });
        const others = [];
        for (const name of guests) others.push(await svc.join(host.code, name));
        await svc.start(host.code, host.memberId);
        return { code: host.code, ids: [host.memberId, ...others.map((o) => o.memberId)] };
      }

      async function matchFirstCard() {
        const s = await started(['Sam']);
        for (const id of s.ids) {
          await svc.swipe(s.code, id, { cardId: 'spoonacular:1', direction: 'like' });
        }
        return s;
      }

      async function finishWithoutMatch() {
        const s = await started(['Sam']);
        for (const card of recipeDeck) {
          await svc.swipe(s.code, s.ids[0]!, { cardId: card.id, direction: 'skip' });
        }
        await svc.swipe(s.code, s.ids[1]!, { cardId: 'spoonacular:1', direction: 'skip' });
        await svc.swipe(s.code, s.ids[1]!, { cardId: 'spoonacular:2', direction: 'like' });
        await svc.swipe(s.code, s.ids[1]!, { cardId: 'spoonacular:3', direction: 'skip' });
        return s;
      }

      it('makes one list per matched card, even when two people tap at once', async () => {
        const { code, ids } = await matchFirstCard();
        let open!: () => void;
        listGate = new Promise((resolve) => (open = resolve));
        const first = svc.createShoppingList(code, ids[0]!, {
          cardId: 'spoonacular:1',
          servings: 4,
        });
        const second = svc.createShoppingList(code, ids[1]!, {
          cardId: 'spoonacular:1',
          servings: 4,
        });
        await vi.waitFor(async () =>
          expect((await svc.view(code)).shoppingLists[0]?.status).toBe('building'),
        );
        open();
        await Promise.all([first, second]);

        expect(listCalls).toBe(1);
        const [list] = (await svc.view(code)).shoppingLists;
        expect(list).toMatchObject({
          status: 'ready',
          source: 'ai',
          servings: 4,
          createdBy: ids[0],
          title: 'Recipe 1',
        });
        expect(list!.lines[0]).toMatchObject({ name: 'Garlic', quantity: '4 cloves' });

        // Asking again for a finished list changes nothing and costs nothing.
        await svc.createShoppingList(code, ids[1]!, { cardId: 'spoonacular:1', servings: 2 });
        expect(listCalls).toBe(1);
      });

      it('only makes lists for matched cards, and only for members', async () => {
        const { code, ids } = await matchFirstCard();
        await expect(
          svc.createShoppingList(code, ids[0]!, { cardId: 'spoonacular:2', servings: 2 }),
        ).rejects.toMatchObject({ code: 'not_allowed' });
        await expect(
          svc.createShoppingList(code, 'stranger', { cardId: 'spoonacular:1', servings: 2 }),
        ).rejects.toMatchObject({ code: 'not_member' });
        expect(listCalls).toBe(0);
      });

      it('shares "we have it" ticks and rescales without another run', async () => {
        const { code, ids } = await matchFirstCard();
        await svc.createShoppingList(code, ids[0]!, { cardId: 'spoonacular:1', servings: 2 });
        await svc.toggleShoppingLine(code, ids[1]!, {
          cardId: 'spoonacular:1',
          lineId: 'l1',
          have: true,
        });
        await svc.setShoppingServings(code, ids[1]!, { cardId: 'spoonacular:1', servings: 6 });

        const [list] = (await svc.view(code)).shoppingLists;
        expect(list!.servings).toBe(6);
        expect(list!.lines[0]).toMatchObject({ quantity: '6 cloves', have: true });
        expect(listCalls).toBe(1);
        await expect(
          svc.toggleShoppingLine(code, ids[0]!, {
            cardId: 'spoonacular:1',
            lineId: 'l9',
            have: true,
          }),
        ).rejects.toMatchObject({ code: 'no_list' });
      });

      it('shows a failed list with its reason, and lets anyone retry', async () => {
        const { code, ids } = await matchFirstCard();
        listError = new FollowUpError('Recipe API daily quota is used up; try again tomorrow');
        await svc.createShoppingList(code, ids[0]!, { cardId: 'spoonacular:1', servings: 2 });
        expect((await svc.view(code)).shoppingLists[0]).toMatchObject({
          status: 'failed',
          error: 'Recipe API daily quota is used up; try again tomorrow',
        });

        listError = null;
        await svc.createShoppingList(code, ids[1]!, { cardId: 'spoonacular:1', servings: 2 });
        expect((await svc.view(code)).shoppingLists[0]?.status).toBe('ready');
      });

      it('runs the mediator once when everyone finished and nothing matched', async () => {
        const { code, ids } = await finishWithoutMatch();
        // The last swipe's broadcast already says a compromise is on its way.
        const lastState = events.filter((e) => e.type === 'changed').at(-1);
        expect(lastState?.type === 'changed' && lastState.view.mediating).toBe(true);

        await svc.settled();
        const view = await svc.view(code);
        expect(view.suggestion).toEqual({
          cardId: 'spoonacular:2',
          reason: 'It got the most yums.',
          source: 'fallback',
          acceptedBy: null,
        });
        expect(view.mediating).toBe(false);

        // More changes to the finished session don't run it again.
        await svc.setConnected(code, ids[0]!, true);
        await svc.setConnected(code, ids[0]!, false);
        await svc.settled();
        expect(mediateCalls).toBe(1);
      });

      it('does not mediate while people are still swiping, or after a match', async () => {
        const { code } = await matchFirstCard();
        await svc.settled();
        expect(mediateCalls).toBe(0);
        expect((await svc.view(code)).suggestion).toBeNull();
      });

      it('"Go with it" accepts the compromise, which can then get a shopping list', async () => {
        const { code, ids } = await finishWithoutMatch();
        await svc.settled();
        await expect(
          svc.createShoppingList(code, ids[0]!, { cardId: 'spoonacular:2', servings: 2 }),
        ).rejects.toMatchObject({ code: 'not_allowed' });

        await svc.acceptSuggestion(code, ids[1]!);
        expect((await svc.view(code)).suggestion?.acceptedBy).toBe(ids[1]);
        await svc.createShoppingList(code, ids[0]!, { cardId: 'spoonacular:2', servings: 2 });
        expect((await svc.view(code)).shoppingLists[0]?.status).toBe('ready');
      });

      it('a rebuild clears lists and the compromise, and may mediate again', async () => {
        const { code, ids } = await finishWithoutMatch();
        await svc.settled();
        await svc.acceptSuggestion(code, ids[0]!);
        await svc.createShoppingList(code, ids[0]!, { cardId: 'spoonacular:2', servings: 2 });

        await svc.rebuildDeck(code, ids[0]!);
        const view = await svc.view(code);
        expect(view.shoppingLists).toEqual([]);
        expect(view.suggestion).toBeNull();
        expect(view.mediating).toBe(false);

        for (const id of ids) {
          for (const card of recipeDeck) {
            await svc.swipe(code, id, { cardId: card.id, direction: 'skip' });
          }
        }
        await svc.settled();
        expect(mediateCalls).toBe(2);
      });

      it('rejects "Go with it" when there is nothing to accept', async () => {
        const { code, ids } = await matchFirstCard();
        await expect(svc.acceptSuggestion(code, ids[0]!)).rejects.toMatchObject({
          code: 'not_allowed',
        });
      });
    });

    describe('presence sweep', () => {
      it('removes only members offline for longer than the grace period', async () => {
        const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
        const gone = await service.join(host.code, 'Gone');
        const recent = await service.join(host.code, 'Recent');
        await service.setConnected(host.code, host.memberId, true);
        await service.setConnected(host.code, gone.memberId, true);
        await service.setConnected(host.code, recent.memberId, true);

        await service.setConnected(host.code, gone.memberId, false); // Offline at t=1000.
        clock = 1_500;
        await service.setConnected(host.code, recent.memberId, false); // Offline at t=1500.

        clock = 1_600;
        expect(await service.removeStaleMembers(300)).toBe(1); // Cutoff t=1300.
        const names = (await service.view(host.code)).members.map((m) => m.name);
        expect(names).toEqual(['Host', 'Recent']);
        expect(events).toContainEqual({
          type: 'member-removed',
          code: host.code,
          memberId: gone.memberId,
        });
      });

      it('does not remove a member who reconnected after the sweep found them', async () => {
        const host = await service.create({ hostName: 'Host', matchRule: 'everyone' });
        const guest = await service.join(host.code, 'Guest');
        await service.setConnected(host.code, guest.memberId, false);
        clock = 5_000;
        await service.setConnected(host.code, guest.memberId, true); // Back online.

        await service.removeMember(host.code, guest.memberId, { onlyIfOfflineSince: 4_000 });
        expect((await service.view(host.code)).members).toHaveLength(2);
      });

      it('marks everyone offline at startup, keeping their place in the session', async () => {
        const { code, ids } = await startedSession(['Sam']);
        for (const id of ids) await service.setConnected(code, id, true);
        await service.swipe(code, ids[1]!, { cardId: 'soup', direction: 'like' });

        clock = 9_000;
        await service.markAllOffline();
        const view = await service.view(code);
        expect(view.members.every((m) => !m.connected)).toBe(true);
        expect(view.members[1]?.swipedCount).toBe(1);
      });
    });
  });
});
