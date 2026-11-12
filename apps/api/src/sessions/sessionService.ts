import {
  MAX_MEMBERS,
  matchRules,
  evaluateCard,
  type MatchRuleId,
  type Membership,
  type SessionPreview,
  type SessionView,
  type SwipeInput,
} from '@yumanimous/shared';
import type { DeckSource } from '../deck/deckSource.js';
import {
  generateMemberId,
  generateSessionCode,
  generateToken,
  hashToken,
  tokenMatches,
} from './codes.js';
import type { SessionStore, StoredMember, StoredSession } from './sessionStore.js';

export type SessionErrorCode =
  'not_found' | 'full' | 'name_taken' | 'not_host' | 'not_member' | 'not_started' | 'unknown_card';

/** An expected, user-facing failure. Its message is safe to show to clients. */
export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

/** What the realtime layer needs to know after each change. */
export type SessionEvent =
  | { type: 'changed'; code: string; view: SessionView }
  | { type: 'match'; code: string; cardId: string }
  | { type: 'member-removed'; code: string; memberId: string }
  | { type: 'ended'; code: string };

type Listener = (event: SessionEvent) => void;

export interface SessionServiceOptions {
  store: SessionStore;
  deckSource: DeckSource;
  /** Injected so tests can control time. */
  now?: () => number;
}

/**
 * All session rules live here, with no HTTP or Socket.io code, so they can be
 * tested directly. Transports call these methods and relay the events.
 */
export class SessionService {
  private readonly store: SessionStore;
  private readonly deckSource: DeckSource;
  private readonly now: () => number;
  private readonly listeners = new Set<Listener>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor({ store, deckSource, now = Date.now }: SessionServiceOptions) {
    this.store = store;
    this.deckSource = deckSource;
    this.now = now;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(input: { hostName: string; matchRule: MatchRuleId }): Promise<Membership> {
    const deck = await this.deckSource.buildDeck();
    const token = generateToken();
    const host = this.newMember(input.hostName, token);

    // ~887M possible codes, so a collision is rare, but a retry costs nothing.
    for (let attempt = 0; attempt < 5; attempt++) {
      const session: StoredSession = {
        code: generateSessionCode(),
        mode: this.deckSource.mode,
        matchRule: input.matchRule,
        status: 'lobby',
        hostId: host.id,
        deck,
        members: [host],
        swipes: [],
        matches: [],
        updatedAt: this.now(),
      };
      if (await this.store.create(session)) {
        return { code: session.code, memberId: host.id, token };
      }
    }
    throw new Error('Could not allocate a unique session code');
  }

  async preview(code: string): Promise<SessionPreview> {
    const session = await this.require(code);
    const host = session.members.find((m) => m.id === session.hostId);
    return {
      code: session.code,
      mode: session.mode,
      matchRule: session.matchRule,
      status: session.status,
      hostName: host?.name ?? 'Host',
      memberCount: session.members.length,
      full: session.members.length >= MAX_MEMBERS,
    };
  }

  /** Late joiners are welcome: they get the same deck and swipe it from the start. */
  async join(code: string, name: string): Promise<Membership> {
    const token = generateToken();
    const member = await this.update(code, (session) => {
      if (session.members.length >= MAX_MEMBERS) {
        throw new SessionError('full', `This session already has ${MAX_MEMBERS} people`);
      }
      // Two "Sam"s would make the results screen ambiguous.
      const taken = session.members.some((m) => m.name.toLowerCase() === name.toLowerCase());
      if (taken) throw new SessionError('name_taken', 'Someone already has that name here');

      const newMember = this.newMember(name, token);
      session.members.push(newMember);
      return newMember;
    });
    return { code, memberId: member.id, token };
  }

  /** Returns the member id for a valid rejoin token, or null. */
  async authenticate(code: string, token: string): Promise<string | null> {
    const session = await this.store.get(code);
    const member = session?.members.find((m) => tokenMatches(token, m.tokenHash));
    return member?.id ?? null;
  }

  async view(code: string): Promise<SessionView> {
    return toView(await this.require(code));
  }

  async start(code: string, memberId: string): Promise<void> {
    await this.update(code, (session) => {
      if (session.hostId !== memberId) {
        throw new SessionError('not_host', 'Only the host can start');
      }
      session.status = 'swiping';
    });
  }

  /** Idempotent per card: a member's first swipe stands, repeats are ignored. */
  async swipe(code: string, memberId: string, input: SwipeInput): Promise<void> {
    await this.update(code, (session) => {
      requireMember(session, memberId);
      if (session.status !== 'swiping') {
        throw new SessionError('not_started', 'The host has not started yet');
      }
      if (!session.deck.some((card) => card.id === input.cardId)) {
        throw new SessionError('unknown_card', 'That card is not in this deck');
      }
      const already = session.swipes.some(
        (s) => s.memberId === memberId && s.cardId === input.cardId,
      );
      if (!already) session.swipes.push({ ...input, memberId });
    });
  }

  /** Online/offline only. Offline members still count toward matches until removed. */
  async setConnected(code: string, memberId: string, connected: boolean): Promise<void> {
    await this.update(
      code,
      (session) => {
        const member = session.members.find((m) => m.id === memberId);
        if (!member || member.connected === connected) return false;
        member.connected = connected;
        return true;
      },
      { ifExists: true },
    );
  }

  /**
   * Explicit leave, or the disconnect grace period ran out. The member and their
   * swipes are deleted, so their votes stop counting (which can create a match).
   * The host role passes to the earliest-joined member, preferring one who is online.
   */
  async removeMember(code: string, memberId: string): Promise<void> {
    let removed = false;
    let empty = false;
    await this.update(
      code,
      (session) => {
        const index = session.members.findIndex((m) => m.id === memberId);
        if (index === -1) return false;
        session.members.splice(index, 1);
        session.swipes = session.swipes.filter((s) => s.memberId !== memberId);
        removed = true;

        if (session.members.length === 0) {
          empty = true;
          return false; // Nothing to broadcast to; deleted below.
        }
        if (session.hostId === memberId) {
          const next = session.members.find((m) => m.connected) ?? session.members[0]!;
          session.hostId = next.id;
        }
        return true;
      },
      { ifExists: true },
    );

    if (removed) this.emit({ type: 'member-removed', code, memberId });
    if (empty) await this.end(code);
  }

  /** Deletes sessions with no activity for `maxIdleMs`. Returns how many were removed. */
  async sweepIdle(maxIdleMs: number): Promise<number> {
    const codes = await this.store.idleSince(this.now() - maxIdleMs);
    for (const code of codes) await this.end(code);
    return codes.length;
  }

  // ---- internals ----

  private newMember(name: string, token: string): StoredMember {
    return {
      id: generateMemberId(),
      name,
      tokenHash: hashToken(token),
      joinedAt: this.now(),
      // Joining is a REST call; the member counts as online once their socket connects.
      connected: false,
    };
  }

  private async require(code: string): Promise<StoredSession> {
    const session = await this.store.get(code);
    if (!session) throw new SessionError('not_found', 'That session does not exist');
    return session;
  }

  private async end(code: string): Promise<void> {
    await this.withLock(code, () => this.store.delete(code));
    this.emit({ type: 'ended', code });
  }

  /**
   * Read-modify-write under a per-session lock. Two members swiping the same instant
   * would otherwise both read the old state and one swipe would be lost. Matches are
   * re-evaluated after every change, and listeners hear about it once it's saved.
   *
   * `mutate` may return `false` to mean "nothing changed, don't save or broadcast".
   */
  private async update<T>(
    code: string,
    mutate: (session: StoredSession) => T,
    { ifExists = false } = {},
  ): Promise<T> {
    const result = await this.withLock(code, async () => {
      const session = await this.store.get(code);
      if (!session) {
        if (ifExists) return { value: undefined as T, session: undefined, newMatches: [] };
        throw new SessionError('not_found', 'That session does not exist');
      }
      const value = mutate(session);
      if (value === false) return { value, session: undefined, newMatches: [] };

      const newMatches = recordNewMatches(session, this.now());
      session.updatedAt = this.now();
      await this.store.save(session);
      return { value, session, newMatches };
    });

    if (result.session) {
      this.emit({ type: 'changed', code, view: toView(result.session) });
      for (const cardId of result.newMatches) this.emit({ type: 'match', code, cardId });
    }
    return result.value;
  }

  private async withLock<T>(code: string, fn: () => Promise<T>): Promise<T> {
    // Chain onto the previous operation for this code, ignoring its failure.
    const previous = this.locks.get(code) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(code, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(code) === tail) this.locks.delete(code);
    }
  }

  private emit(event: SessionEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

function requireMember(session: StoredSession, memberId: string): StoredMember {
  const member = session.members.find((m) => m.id === memberId);
  if (!member) throw new SessionError('not_member', 'You are not in this session');
  return member;
}

/** Applies the session's match rule to every unmatched card. Matches are sticky. */
function recordNewMatches(session: StoredSession, now: number): string[] {
  if (session.status !== 'swiping') return [];
  const rule = matchRules[session.matchRule];
  const memberIds = session.members.map((m) => m.id);
  const alreadyMatched = new Set(session.matches.map((m) => m.cardId));

  const newMatches = session.deck
    .filter((card) => !alreadyMatched.has(card.id))
    .filter((card) => evaluateCard(rule, card.id, session.swipes, memberIds).outcome === 'match')
    .map((card) => card.id);

  for (const cardId of newMatches) session.matches.push({ cardId, matchedAt: now });
  return newMatches;
}

/** The public shape every member receives. Token hashes never leave the server. */
export function toView(session: StoredSession): SessionView {
  const deckIds = new Set(session.deck.map((c) => c.id));
  const swipedCount = (memberId: string) =>
    session.swipes.filter((s) => s.memberId === memberId && deckIds.has(s.cardId)).length;

  const members = session.members.map((m) => ({
    id: m.id,
    name: m.name,
    isHost: m.id === session.hostId,
    connected: m.connected,
    swipedCount: swipedCount(m.id),
    joinedAt: m.joinedAt,
  }));

  return {
    code: session.code,
    mode: session.mode,
    matchRule: session.matchRule,
    status: session.status,
    deck: session.deck,
    members,
    swipes: session.swipes,
    matches: session.matches,
    finished:
      session.status === 'swiping' &&
      members.length > 0 &&
      members.every((m) => m.swipedCount === session.deck.length),
  };
}
