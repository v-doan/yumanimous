import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyPreferences,
  mergePreferences,
  type Card,
  type MemberPreferences,
} from '@yumanimous/shared';
import { BudgetGuard, InMemoryAiCallLog } from '../ai/aiCallLog.js';
import {
  AgentRunError,
  type AiUsage,
  type DeckAgent,
  type DeckRequest,
  type RerankRequest,
} from '../ai/deckAgent.js';
import { AiDeckSource, assembleDeck, cleanBlurb, completeOrder } from './aiDeckSource.js';
import type { RecipeDeckSource } from './recipeDeckSource.js';

const card = (id: string, tags: string[] = []): Card => ({
  id,
  title: `Dish ${id}`,
  tags,
  blurb: `Original blurb for ${id}.`,
});
const pool = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => card(id));
const usage = (costUsd = 0.003): AiUsage => ({
  model: 'claude-haiku-5-5',
  costUsd,
  inputTokens: 50,
  outputTokens: 400,
  cacheReadTokens: 9000,
  cacheWriteTokens: 0,
  durationMs: 5000,
  numTurns: 4,
});

/** A scripted stand-in for the Claude agent. */
class FakeAgent implements DeckAgent {
  readonly model = 'claude-haiku-5-5';
  deckRequests: DeckRequest[] = [];
  deckResult: (req: DeckRequest) => Promise<{ cardId: string; blurb: string }[]> = async () => [];
  rerankResult: (req: RerankRequest) => Promise<string[]> = async () => [];

  async buildDeck(req: DeckRequest) {
    this.deckRequests.push(req);
    const picks = await this.deckResult(req);
    return { picks, candidates: new Map(req.pool.map((c) => [c.id, c])), usage: usage() };
  }

  async rerank(req: RerankRequest) {
    return { order: await this.rerankResult(req), usage: usage(0.001) };
  }
}

const base = {
  candidatePool: vi.fn(async () => pool),
  deal: vi.fn((cards: Card[], _group: unknown, size = 10) => cards.slice(0, size)),
  canSearch: true,
  searchMore: vi.fn(async () => [card('x')]),
} as unknown as RecipeDeckSource & {
  searchMore: ReturnType<typeof vi.fn>;
};

let agent: FakeAgent;
let log: InMemoryAiCallLog;
let budgetUsd: number;

function source(opts: { timeoutMs?: number } = {}) {
  return new AiDeckSource({
    base,
    agent,
    log,
    budget: new BudgetGuard(log, budgetUsd),
    deckSize: 4,
    warn: () => {},
    ...opts,
  });
}

const ctx = { sessionCode: 'ABCDEF' };

beforeEach(() => {
  agent = new FakeAgent();
  log = new InMemoryAiCallLog();
  budgetUsd = 8;
  vi.clearAllMocks();
});

describe('AiDeckSource', () => {
  it('uses the AI’s picks, order and blurbs, and logs the run’s cost', async () => {
    agent.deckResult = async () => [
      { cardId: 'c', blurb: 'Crispy, saucy and gone in ten minutes flat.' },
      { cardId: 'a', blurb: 'The one everybody secretly wants.' },
      { cardId: 'e', blurb: 'Big flavour, tiny washing-up pile.' },
      { cardId: 'b', blurb: 'Comfort in a bowl, no debate needed.' },
    ];
    const deck = await source().buildDeck(undefined, ctx);

    expect(deck.map((c) => c.id)).toEqual(['c', 'a', 'e', 'b']);
    expect(deck[0]!.blurb).toBe('Crispy, saucy and gone in ten minutes flat.');
    const [logged] = await log.list({ limit: 1 });
    expect(logged).toMatchObject({
      kind: 'deck',
      status: 'ok',
      costUsd: 0.003,
      sessionCode: 'ABCDEF',
    });
  });

  it('drops invented and repeated cards, then tops up from the safe pool', async () => {
    agent.deckResult = async () => [
      { cardId: 'a', blurb: 'First pick, a real one from the pool.' },
      { cardId: 'not-in-pool', blurb: 'An invented recipe the model made up.' },
      { cardId: 'a', blurb: 'The same card again.' },
      { cardId: 'b', blurb: 'Second real pick from the pool.' },
      { cardId: 'c', blurb: 'Third real pick from the pool.' },
    ];
    const deck = await source().buildDeck(undefined, ctx);
    expect(deck.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(deck.every((c) => pool.some((p) => p.id === c.id))).toBe(true);
  });

  it('falls back to the non-AI deck when the AI picks too little that’s valid', async () => {
    agent.deckResult = async () => [{ cardId: 'ghost', blurb: 'Nothing real here at all.' }];
    const deck = await source().buildDeck(undefined, ctx);
    expect(base.deal).toHaveBeenCalled();
    expect(deck.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
    expect((await log.list({ limit: 1 }))[0]!.status).toBe('fallback');
  });

  it('falls back and logs the cost when the run fails', async () => {
    agent.deckResult = async () => {
      throw new AgentRunError('error_max_budget_usd: over budget', usage(0.4));
    };
    const deck = await source().buildDeck(undefined, ctx);
    expect(deck).toHaveLength(4);
    expect((await log.list({ limit: 1 }))[0]).toMatchObject({
      status: 'error',
      costUsd: 0.4,
      error: 'error_max_budget_usd: over budget',
    });
  });

  it('times out a slow run and falls back', async () => {
    agent.deckResult = (req) =>
      new Promise((_, reject) =>
        req.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    const deck = await source({ timeoutMs: 20 }).buildDeck(undefined, ctx);
    expect(deck).toHaveLength(4);
    expect((await log.list({ limit: 1 }))[0]!.error).toBe('Timed out after 20 ms');
  });

  it('skips the AI entirely once the monthly budget is used up', async () => {
    budgetUsd = 0.01;
    await log.record({
      ...usage(0.02),
      sessionCode: null,
      kind: 'deck',
      status: 'ok',
      error: null,
    });
    await source().buildDeck(undefined, ctx);
    expect(agent.deckRequests).toHaveLength(0);
    expect((await log.list({ limit: 1 }))[0]).toMatchObject({ status: 'skipped', costUsd: 0 });
  });

  it('gives the scout a search that always carries the group’s hard rules', async () => {
    const group = mergePreferences([
      { name: 'Sam', preferences: { ...emptyPreferences(), intolerances: ['peanut'] } },
    ]);
    agent.deckResult = async (req) => {
      await req.searchMore!({ cuisine: 'Thai' });
      return [];
    };
    await source().buildDeck(group, ctx);
    expect(base.searchMore).toHaveBeenCalledWith(
      expect.objectContaining({ intolerances: ['peanut'] }),
      { cuisine: 'Thai' },
    );
  });

  it('forwards progress for the live “scouting… writing…” display', async () => {
    const onProgress = vi.fn();
    agent.deckResult = async (req) => {
      req.onProgress?.('scouting');
      req.onProgress?.('writing');
      return [];
    };
    await source().buildDeck(undefined, { ...ctx, onProgress });
    expect(onProgress.mock.calls).toEqual([['scouting'], ['writing']]);
  });

  it('does not call the AI without a session context', async () => {
    await source().buildDeck();
    expect(agent.deckRequests).toHaveLength(0);
  });

  describe('going live on the curator’s order', () => {
    /** Lets a test decide when the fake writer "finishes". */
    function deferred() {
      let release: () => void = () => {};
      const done = new Promise<void>((r) => (release = r));
      return { done, release };
    }

    it('returns the deck as soon as the order is in, and sends blurbs when they’re written', async () => {
      const writer = deferred();
      const onBlurbs = vi.fn();
      agent.deckResult = async (req) => {
        req.onOrder!([pool[2]!, pool[0]!, pool[1]!], new Map(pool.map((c) => [c.id, c])));
        await writer.done;
        return [
          { cardId: 'c', blurb: 'Late but lovely, this one is a winner.' },
          { cardId: 'a', blurb: 'x' }, // Too short: dropped, card keeps its own.
          { cardId: 'zzz', blurb: 'Not in the deck, so never sent anywhere.' },
        ];
      };

      const deck = await source().buildDeck(undefined, { ...ctx, onBlurbs });
      // Live already: curator's order, recipe blurbs, topped up to the deck size.
      expect(deck.map((c) => c.id)).toEqual(['c', 'a', 'b', 'd']);
      expect(deck[0]!.blurb).toBe('Original blurb for c.');
      expect(onBlurbs).not.toHaveBeenCalled();
      expect(await log.list({ limit: 1 })).toEqual([]); // Not finished yet.

      writer.release();
      await vi.waitFor(() => expect(onBlurbs).toHaveBeenCalledOnce());
      expect([...onBlurbs.mock.calls[0]![0]]).toEqual([
        ['c', 'Late but lovely, this one is a winner.'],
      ]);
      expect((await log.list({ limit: 1 }))[0]).toMatchObject({ kind: 'deck', status: 'ok' });
    });

    it('keeps the live deck and logs the cost if the writer then fails', async () => {
      const onBlurbs = vi.fn();
      agent.deckResult = async (req) => {
        req.onOrder!(pool.slice(0, 4), new Map(pool.map((c) => [c.id, c])));
        throw new AgentRunError('error_max_turns: writer ran out of turns', usage(0.01));
      };
      const deck = await source().buildDeck(undefined, { ...ctx, onBlurbs });
      expect(deck.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
      await vi.waitFor(async () =>
        expect((await log.list({ limit: 1 }))[0]).toMatchObject({ status: 'error', costUsd: 0.01 }),
      );
      expect(onBlurbs).not.toHaveBeenCalled();
    });

    it('waits for the whole run when the early order has too few real cards', async () => {
      agent.deckResult = async (req) => {
        req.onOrder!([pool[0]!], new Map([[pool[0]!.id, pool[0]!]])); // 1 card: not enough.
        return ['b', 'c', 'd', 'e'].map((cardId) => ({
          cardId,
          blurb: 'A full, final pick with its blurb.',
        }));
      };
      const deck = await source().buildDeck(undefined, ctx);
      expect(deck.map((c) => c.id)).toEqual(['b', 'c', 'd', 'e']);
      expect(deck[0]!.blurb).toBe('A full, final pick with its blurb.');
    });
  });

  it('re-ranks into a permutation of the given cards', async () => {
    agent.rerankResult = async () => ['c', 'zzz', 'a', 'c'];
    const order = await source().rerank({ sessionCode: 'ABCDEF', cards: pool.slice(0, 3) });
    expect(order).toEqual(['c', 'a', 'b']);
    expect((await log.list({ limit: 1 }))[0]).toMatchObject({ kind: 'rerank', status: 'ok' });
  });
});

describe('assembleDeck', () => {
  const prefs = (p: Partial<MemberPreferences>) => ({ ...emptyPreferences(), ...p });

  it('tops up by the group’s soft preferences', () => {
    const group = mergePreferences([
      { name: 'A', preferences: prefs({ cuisinesLiked: ['Thai'] }) },
    ]);
    const candidates = new Map(
      [card('a'), card('b'), card('thai', ['Thai']), card('d')].map((c) => [c.id, c]),
    );
    const picks = ['a', 'b', 'd'].map((cardId) => ({ cardId, blurb: 'A perfectly fine blurb.' }));
    const deck = assembleDeck({ picks, candidates }, 4, group)!;
    expect(deck.map((c) => c.id)).toEqual(['a', 'b', 'd', 'thai']);
  });
});

describe('cleanBlurb', () => {
  it.each([
    ['  Spicy,   saucy\\nand quick. ', 'Spicy, saucy\\nand quick.'],
    ['Tasty‮dish with bidi tricks', 'Tasty dish with bidi tricks'],
    ['too short', null],
    ['x'.repeat(161), null],
  ])('%j -> %j', (raw, expected) => {
    expect(cleanBlurb(raw)).toBe(expected);
  });
});

describe('completeOrder', () => {
  it('returns null when nothing usable came back', () => {
    expect(completeOrder(['nope'], pool)).toBeNull();
  });
});

describe('AiDeckSource: play again (Phase 8)', () => {
  it('keeps earlier rounds’ cards out of the agent’s pool and the scout’s searches', async () => {
    base.searchMore.mockResolvedValueOnce([card('a'), card('y')]);
    agent.deckResult = async (req) => {
      const found = await req.searchMore!({ cuisine: 'Thai' });
      expect(found.map((c) => c.id)).toEqual(['y']); // 'a' was shown last round.
      return req.pool.map((c) => ({ cardId: c.id, blurb: '' }));
    };
    const deck = await source().buildDeck(undefined, {
      ...ctx,
      excludeCardIds: ['a'],
      round: 2,
    });
    expect(agent.deckRequests[0]!.pool.map((c) => c.id)).toEqual(['b', 'c', 'd', 'e', 'f']);
    expect(agent.deckRequests[0]!.round).toBe(2);
    expect(deck.map((c) => c.id)).not.toContain('a');
  });

  it('allows repeats only when too few fresh cards are left, and deals them last', async () => {
    agent.deckResult = async (req) => req.pool.map((c) => ({ cardId: c.id, blurb: '' }));
    const deck = await source().buildDeck(undefined, {
      ...ctx,
      excludeCardIds: ['a', 'b', 'c'], // Only 3 fresh: fewer than a round needs.
    });
    expect(agent.deckRequests[0]!.pool).toHaveLength(6);
    expect(deck.map((c) => c.id)).toEqual(['d', 'a', 'b', 'c']);
  });
});
