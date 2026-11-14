import {
  MAX_MEMBERS,
  canMakeShoppingList,
  matchRules,
  evaluateCard,
  mergePreferences,
  uncoveredRules,
  type AttributedRule,
  type Card,
  type CreateShoppingList,
  type HardFilters,
  type MatchRuleId,
  type MemberPreferences,
  type Membership,
  type SessionPreview,
  type SessionView,
  type ShoppingList,
  type SwipeInput,
  type ToggleShoppingLine,
} from '@yumanimous/shared';
import { DeckError, type DeckProgressStage, type DeckSource } from '../deck/deckSource.js';
import { FollowUpError, type FollowUps } from '../followUps/followUps.js';
import { contenders } from '../followUps/mediator.js';
import { rescaleLines } from '../followUps/shoppingList.js';
import { applyRerank, shouldRerank, unswipedByAnyone } from './rerank.js';
import {
  generateMemberId,
  generateSessionCode,
  generateToken,
  hashToken,
  tokenMatches,
} from './codes.js';
import type { SessionStore, StoredMember, StoredSession } from './sessionStore.js';

export type SessionErrorCode =
  | 'not_found'
  | 'full'
  | 'name_taken'
  | 'not_host'
  | 'not_member'
  | 'not_started'
  | 'already_started'
  | 'unknown_card'
  | 'deck_unavailable'
  | 'not_allowed'
  | 'no_list';

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
  | { type: 'deck-progress'; code: string; stage: DeckProgressStage | 'reranked' }
  | { type: 'ended'; code: string };

type Listener = (event: SessionEvent) => void;

type DeckJobKind = 'start' | 'rebuild';

/**
 * A mediator claim older than this with no suggestion is assumed lost (e.g. the API
 * restarted mid-run), and the next change to the session starts it again.
 */
const MEDIATION_STALE_MS = 2 * 60_000;

export interface SessionServiceOptions {
  store: SessionStore;
  deckSource: DeckSource;
  /** Phase 7: shopping lists and the no-match mediator. Off when omitted. */
  followUps?: FollowUps;
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
  /** The deck build running for each session, if any (see deckJob). */
  private readonly deckJobs = new Map<string, { kind: DeckJobKind; promise: Promise<void> }>();
  private readonly followUps: FollowUps | null;
  /** Shopping lists being made, by `${code}:${cardId}` (one run per list). */
  private readonly listJobs = new Map<string, Promise<void>>();
  /** Background mediator runs, so tests (and shutdown) can wait for them. */
  private readonly background = new Set<Promise<void>>();

  constructor({ store, deckSource, followUps, now = Date.now }: SessionServiceOptions) {
    this.store = store;
    this.deckSource = deckSource;
    this.followUps = followUps ?? null;
    this.now = now;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The deck isn't built yet: it waits for everyone's food rules, at the start. */
  async create(input: { hostName: string; matchRule: MatchRuleId }): Promise<Membership> {
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
        deck: [],
        deckFilters: null,
        rerankedAt: null,
        members: [host],
        swipes: [],
        matches: [],
        shoppingLists: [],
        suggestion: null,
        mediatedAt: null,
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

  /** Saves a member's confirmed food rules. Allowed in the lobby and mid-session. */
  async setPreferences(
    code: string,
    memberId: string,
    preferences: MemberPreferences,
  ): Promise<void> {
    await this.update(code, (session) => {
      requireMember(session, memberId).preferences = preferences;
    });
  }

  /**
   * Host only: build the deck from everyone's merged rules, then open swiping. Any
   * member's dietary restriction is a hard filter for the whole group.
   *
   * Idempotent while it runs: a second tap, or the host refreshing mid-build, joins
   * the build in progress instead of paying for another one.
   */
  async start(code: string, memberId: string): Promise<void> {
    return this.deckJob(code, memberId, 'start');
  }

  /**
   * Host only, mid-session: a fresh deck for everyone's current rules (e.g. a late
   * joiner's allergy). Votes and matches go too: they were cast on another deck.
   * Like start, concurrent requests share one build.
   */
  async rebuildDeck(code: string, memberId: string): Promise<void> {
    return this.deckJob(code, memberId, 'rebuild');
  }

  /**
   * Runs at most one deck build per session at a time. Checking for a running build
   * and registering a new one happen together under a short lock, so two requests
   * arriving at once can't both start one. The slow build itself runs outside it.
   * (One API process: like presence, several processes would need a shared lock.)
   */
  private async deckJob(code: string, memberId: string, kind: DeckJobKind): Promise<void> {
    const { job } = await this.withLock(`deck-job:${code}`, async () => {
      const session = await this.require(code);
      requireHost(
        session,
        memberId,
        kind === 'start' ? 'Only the host can start' : 'Only the host can rebuild the deck',
      );
      const running = this.deckJobs.get(code);
      if (running?.kind === kind) return { job: running.promise };
      if (kind === 'start' && (running || session.status !== 'lobby')) {
        throw new SessionError('already_started', 'This session has already started');
      }
      if (kind === 'rebuild' && (running || session.status !== 'swiping')) {
        throw new SessionError('not_started', 'The host has not started yet');
      }

      const promise = this.buildAndApply(code, memberId, kind, session).finally(() =>
        this.deckJobs.delete(code),
      );
      this.deckJobs.set(code, { kind, promise });
      // Wrapped in an object: returning the promise itself would make this lock wait
      // for the whole build.
      return { job: promise };
    });
    return job;
  }

  private async buildAndApply(
    code: string,
    memberId: string,
    kind: DeckJobKind,
    session: StoredSession,
  ): Promise<void> {
    // The AI writer's blurbs can arrive after the deck goes live, or (if it's quick)
    // before this build has saved the deck. Hold them until the deck is saved.
    let deckSaved = false;
    let heldBlurbs: Map<string, string> | null = null;
    const onBlurbs = (blurbs: Map<string, string>) => {
      if (deckSaved) void this.applyBlurbs(code, blurbs).catch((e) => console.error('[blurbs]', e));
      else heldBlurbs = blurbs;
    };

    const { deck, filters } = await this.buildDeck(session, onBlurbs);

    await this.update(code, (current) => {
      // Re-checked under the session lock: the build above took a while.
      requireHost(current, memberId, 'Only the host can change the deck');
      if (kind === 'start') {
        if (current.status !== 'lobby') {
          throw new SessionError('already_started', 'This session has already started');
        }
        current.status = 'swiping';
      } else {
        current.swipes = [];
        current.matches = [];
        current.rerankedAt = null; // A new deck may be re-ranked once too.
        // Lists and the compromise were for the old deck.
        current.shoppingLists = [];
        current.suggestion = null;
        current.mediatedAt = null;
      }
      current.deck = deck;
      current.deckFilters = filters;
    });
    deckSaved = true;
    const held: Map<string, string> | null = heldBlurbs;
    if (held) void this.applyBlurbs(code, held).catch((e) => console.error('[blurbs]', e));
  }

  /** Swaps in AI blurbs for cards still in the deck (by id; positions don't matter). */
  private async applyBlurbs(code: string, blurbs: Map<string, string>): Promise<void> {
    await this.update(
      code,
      (session) => {
        let changed = false;
        session.deck = session.deck.map((card) => {
          const blurb = blurbs.get(card.id);
          if (!blurb || blurb === card.blurb) return card;
          changed = true;
          return { ...card, blurb };
        });
        return changed;
      },
      { ifExists: true },
    );
  }

  /** Idempotent per card: a member's first swipe stands, repeats are ignored. */
  async swipe(code: string, memberId: string, input: SwipeInput): Promise<void> {
    const rerankCards = await this.update(code, (session) => {
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

      // Claim the one-time re-rank in this same transaction, so two swipes landing
      // together can't both start it, and no extra round trip is needed per swipe.
      if (this.deckSource.rerank && shouldRerank(session)) {
        session.rerankedAt = this.now();
        return unswipedByAnyone(session.deck, session.swipes);
      }
      return null;
    });
    // Off the swipe path: the swipe is already saved and broadcast.
    if (rerankCards) {
      void this.rerank(code, rerankCards).catch((err) => console.error('[rerank]', err));
    }
  }

  /**
   * Once per session, after every member has swiped enough to show the group's taste,
   * the deck source reorders the cards nobody has swiped yet. Runs in the
   * background; swiping never waits for it.
   */
  private async rerank(code: string, remaining: Card[]): Promise<void> {
    if (!this.deckSource.rerank) return;
    const order = await this.deckSource.rerank({ sessionCode: code, cards: remaining });
    if (!order) return;

    // Cards swiped while the AI was thinking stay where they are (applyRerank).
    const applied = await this.update(
      code,
      (session) => {
        if (session.status !== 'swiping') return false;
        // The host rebuilt the deck while the AI was thinking: this order is stale.
        const deckIds = new Set(session.deck.map((c) => c.id));
        if (!remaining.every((c) => deckIds.has(c.id))) return false;
        session.deck = applyRerank(session.deck, session.swipes, order);
        return true;
      },
      { ifExists: true },
    );
    if (applied) this.emit({ type: 'deck-progress', code, stage: 'reranked' });
  }

  /**
   * Anyone, for a matched recipe (or the accepted compromise): make its shopping list
   * for `servings`. One list per card: a second request while it's being made joins
   * that run, and a finished list is left as it is (use setShoppingServings).
   * Resolves when the list is ready or has failed; everyone sees the progress live.
   */
  async createShoppingList(
    code: string,
    memberId: string,
    { cardId, servings }: CreateShoppingList,
  ): Promise<void> {
    const followUps = this.followUps;
    if (!followUps) throw new SessionError('not_allowed', 'Shopping lists are not available');
    const key = `${code}:${cardId}`;

    // Check and claim under one short lock, like deckJob, so two taps start one run.
    const { job } = await this.withLock(`list-job:${key}`, async () => {
      const running = this.listJobs.get(key);
      if (running) {
        requireMember(await this.require(code), memberId);
        return { job: running };
      }
      const card = await this.update(code, (session) => {
        requireMember(session, memberId);
        if (!canMakeShoppingList(toView(session), cardId)) {
          throw new SessionError('not_allowed', 'A list can only be made for a matched recipe');
        }
        const existing = session.shoppingLists.find((l) => l.cardId === cardId);
        // A failed list can be retried; one stuck "building" after a restart too.
        if (existing?.status === 'ready') return false;
        const card = session.deck.find((c) => c.id === cardId)!;
        const placeholder: ShoppingList = {
          cardId,
          title: card.title,
          servings,
          recipeServings: null,
          status: 'building',
          source: null,
          createdBy: memberId,
          ingredients: [],
          lines: [],
          error: null,
        };
        session.shoppingLists = [
          ...session.shoppingLists.filter((l) => l.cardId !== cardId),
          placeholder,
        ];
        return card;
      });
      if (card === false) return { job: Promise.resolve() };

      const promise = this.buildList(code, card, servings, followUps).finally(() =>
        this.listJobs.delete(key),
      );
      this.listJobs.set(key, promise);
      return { job: promise }; // Wrapped: see deckJob.
    });
    return job;
  }

  /** Runs outside the session lock: it may call the recipe API and the AI. */
  private async buildList(code: string, card: Card, servings: number, followUps: FollowUps) {
    let patch: Partial<ShoppingList>;
    try {
      const result = await followUps.shoppingList({ sessionCode: code, card, servings });
      patch = { ...result, status: 'ready', error: null };
    } catch (err) {
      if (!(err instanceof FollowUpError)) console.error('[shopping]', err);
      const error =
        err instanceof FollowUpError ? err.message : 'Something went wrong making the list';
      patch = { status: 'failed', error: error.slice(0, 200) };
    }
    await this.update(
      code,
      (session) => {
        // The deck was rebuilt meanwhile: this list belongs to the old one.
        const list = session.shoppingLists.find((l) => l.cardId === card.id);
        if (!list || list.status !== 'building') return false;
        Object.assign(list, patch);
        return true;
      },
      { ifExists: true },
    );
  }

  /** "We have it" on one line, for everyone. */
  async toggleShoppingLine(
    code: string,
    memberId: string,
    { cardId, lineId, have }: ToggleShoppingLine,
  ): Promise<void> {
    await this.update(code, (session) => {
      requireMember(session, memberId);
      const line = readyList(session, cardId).lines.find((l) => l.id === lineId);
      if (!line) throw new SessionError('no_list', 'That item is not on the list');
      if (line.have === have) return false;
      line.have = have;
      return true;
    });
  }

  /** Rescales a finished list. Arithmetic only: no AI call, no recipe lookup. */
  async setShoppingServings(
    code: string,
    memberId: string,
    { cardId, servings }: CreateShoppingList,
  ): Promise<void> {
    await this.update(code, (session) => {
      requireMember(session, memberId);
      const list = readyList(session, cardId);
      if (list.servings === servings) return false;
      list.servings = servings;
      list.lines = rescaleLines(list.lines, list.ingredients, servings, list.recipeServings);
      return true;
    });
  }

  /** Anyone: "Go with it" on the mediator's compromise. */
  async acceptSuggestion(code: string, memberId: string): Promise<void> {
    await this.update(code, (session) => {
      requireMember(session, memberId);
      if (!session.suggestion || session.matches.length > 0) {
        throw new SessionError('not_allowed', 'There is no suggestion to accept');
      }
      if (session.suggestion.acceptedBy !== null) return false;
      session.suggestion.acceptedBy = memberId;
      return true;
    });
  }

  /**
   * The mediator, in the background: everyone finished and nothing matched. Claimed
   * once per deck in `update` (mediatedAt), so it runs once however many changes
   * land at the same moment.
   */
  private async mediate(code: string, claimedAt: number): Promise<void> {
    if (!this.followUps) return;
    const session = await this.store.get(code);
    if (!session) return;
    const memberIds = session.members.map((m) => m.id);
    const result = await this.followUps.mediate({
      sessionCode: code,
      contenders: contenders(session.deck, session.swipes, memberIds, session.matchRule),
      memberCount: memberIds.length,
    });
    if (!result) return;
    await this.update(
      code,
      (current) => {
        // A rebuild (new claim or none) or a match since: this pick is stale.
        if (current.mediatedAt !== claimedAt || current.matches.length > 0) return false;
        if (!current.deck.some((c) => c.id === result.cardId)) return false;
        current.suggestion = { ...result, acceptedBy: null };
        return true;
      },
      { ifExists: true },
    );
  }

  /** Waits for background follow-up work (the mediator). For tests and shutdown. */
  async settled(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /**
   * Online/offline only. Offline members still count toward matches until the
   * presence sweep removes them (see `removeStaleMembers`).
   */
  async setConnected(code: string, memberId: string, connected: boolean): Promise<void> {
    await this.update(
      code,
      (session) => {
        const member = session.members.find((m) => m.id === memberId);
        if (!member || (member.disconnectedAt === null) === connected) return false;
        member.disconnectedAt = connected ? null : this.now();
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
  async removeMember(
    code: string,
    memberId: string,
    { onlyIfOfflineSince }: { onlyIfOfflineSince?: number } = {},
  ): Promise<void> {
    let removed = false;
    let empty = false;
    await this.update(
      code,
      (session) => {
        const index = session.members.findIndex((m) => m.id === memberId);
        if (index === -1) return false;
        // The sweep re-checks under the lock: the member may have reconnected
        // between the sweep's query and now, and must not be removed then.
        const member = session.members[index]!;
        if (
          onlyIfOfflineSince !== undefined &&
          (member.disconnectedAt === null || member.disconnectedAt >= onlyIfOfflineSince)
        ) {
          return false;
        }
        session.members.splice(index, 1);
        session.swipes = session.swipes.filter((s) => s.memberId !== memberId);
        removed = true;

        if (session.members.length === 0) {
          empty = true;
          return false; // Nothing to broadcast to; deleted below.
        }
        if (session.hostId === memberId) {
          const next =
            session.members.find((m) => m.disconnectedAt === null) ?? session.members[0]!;
          session.hostId = next.id;
        }
        return true;
      },
      { ifExists: true },
    );

    if (removed) this.emit({ type: 'member-removed', code, memberId });
    if (empty) await this.end(code);
  }

  /**
   * Removes members offline for longer than `graceMs`. Runs on an interval instead of
   * one timer per disconnect, because timers die with the process; the timestamps in
   * the store survive an API restart. Returns how many were removed.
   */
  async removeStaleMembers(graceMs: number): Promise<number> {
    const cutoff = this.now() - graceMs;
    const stale = await this.store.disconnectedBefore(cutoff);
    for (const { code, memberId } of stale) {
      await this.removeMember(code, memberId, { onlyIfOfflineSince: cutoff });
    }
    return stale.length;
  }

  /**
   * Called once at startup: no sockets exist yet, so everyone is offline as of now.
   * Their phones reconnect automatically; anyone who doesn't is swept after the grace
   * period. (Assumes one API process; several would need shared presence.)
   */
  async markAllOffline(): Promise<void> {
    await this.store.markAllDisconnected(this.now());
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
      disconnectedAt: this.now(),
      preferences: null,
    };
  }

  /** Runs outside the session lock: it may call the recipe API. */
  private async buildDeck(
    session: StoredSession,
    onBlurbs?: (blurbs: Map<string, string>) => void,
  ): Promise<{ deck: Card[]; filters: HardFilters }> {
    const group = mergePreferences(session.members);
    const code = session.code;
    try {
      const deck = await this.deckSource.buildDeck(group, {
        sessionCode: code,
        onProgress: (stage) => this.emit({ type: 'deck-progress', code, stage }),
        ...(onBlurbs ? { onBlurbs } : {}),
      });
      return { deck, filters: group.hard };
    } catch (err) {
      if (err instanceof DeckError) throw new SessionError('deck_unavailable', err.message);
      throw err;
    }
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
   * Read-modify-write, atomically. Two members swiping the same instant would
   * otherwise both read the old state and one swipe would be lost. Two layers:
   * - an in-process lock queues operations on one session (cheap, no DB contention);
   * - the store's transaction (`SELECT ... FOR UPDATE` in Postgres) protects against
   *   other API processes.
   * Matches are re-evaluated after every change; listeners hear about it once saved.
   *
   * `mutate` may return `false` to mean "nothing changed, don't save or broadcast".
   */
  private async update<T>(
    code: string,
    mutate: (session: StoredSession) => T,
    { ifExists = false } = {},
  ): Promise<T> {
    let newMatches: string[] = [];
    let mediateAt: number | null = null;
    const { value, saved } = await this.withLock(code, () =>
      this.store.update(code, (session) => {
        if (!session) {
          if (ifExists) return { save: false, value: undefined as T };
          throw new SessionError('not_found', 'That session does not exist');
        }
        const result = mutate(session);
        if (result === false) return { save: false, value: result };

        newMatches = recordNewMatches(session, this.now());
        // Claimed in the same transaction as the change that finished the session
        // (a last swipe, or someone leaving), so it starts exactly once.
        if (this.followUps && needsMediation(session, this.now())) {
          session.mediatedAt = this.now();
          mediateAt = session.mediatedAt;
        }
        session.updatedAt = this.now();
        return { save: true, value: result };
      }),
    );

    if (saved) {
      this.emit({ type: 'changed', code, view: toView(saved) });
      for (const cardId of newMatches) this.emit({ type: 'match', code, cardId });
    }
    const claimed: number | null = mediateAt;
    if (saved && claimed !== null) {
      // Off the swipe path: the swipe is already saved and broadcast.
      const run: Promise<void> = this.mediate(code, claimed)
        .catch((err) => console.error('[mediator]', err))
        .finally(() => this.background.delete(run));
      this.background.add(run);
    }
    return value;
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

function requireHost(session: StoredSession, memberId: string, message: string) {
  if (session.hostId !== memberId) throw new SessionError('not_host', message);
}

function requireMember(session: StoredSession, memberId: string): StoredMember {
  const member = session.members.find((m) => m.id === memberId);
  if (!member) throw new SessionError('not_member', 'You are not in this session');
  return member;
}

function readyList(session: StoredSession, cardId: string): ShoppingList {
  const list = session.shoppingLists.find((l) => l.cardId === cardId);
  if (list?.status !== 'ready') {
    throw new SessionError('no_list', 'That shopping list is not ready');
  }
  return list;
}

/** True once every current member has swiped every card. */
function isFinished(session: StoredSession): boolean {
  if (session.status !== 'swiping' || session.members.length === 0) return false;
  const deckIds = new Set(session.deck.map((c) => c.id));
  return session.members.every(
    (m) =>
      session.swipes.filter((s) => s.memberId === m.id && deckIds.has(s.cardId)).length ===
      session.deck.length,
  );
}

/** Everyone finished, nothing matched, and no compromise yet (or a lost claim). */
function needsMediation(session: StoredSession, now: number): boolean {
  return (
    session.deck.length > 0 &&
    session.matches.length === 0 &&
    session.suggestion === null &&
    (session.mediatedAt === null || now - session.mediatedAt > MEDIATION_STALE_MS) &&
    isFinished(session)
  );
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
    connected: m.disconnectedAt === null,
    preferences: m.preferences,
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
    finished: isFinished(session),
    deckFilters: session.deckFilters,
    uncovered: session.deckFilters ? uncoveredFor(session, session.deckFilters) : [],
    shoppingLists: session.shoppingLists,
    suggestion: session.suggestion,
    mediating:
      session.mediatedAt !== null &&
      session.suggestion === null &&
      session.matches.length === 0 &&
      isFinished(session),
  };
}

/** Each member's hard rules the deck wasn't built with, grouped by rule. */
function uncoveredFor(session: StoredSession, deckFilters: HardFilters): AttributedRule[] {
  const byRule = new Map<string, string[]>();
  for (const member of session.members) {
    if (!member.preferences) continue;
    const own = mergePreferences([member]).hard;
    for (const rule of uncoveredRules(own, deckFilters)) {
      byRule.set(rule, [...(byRule.get(rule) ?? []), member.name]);
    }
  }
  return [...byRule].map(([rule, members]) => ({ rule, members }));
}
