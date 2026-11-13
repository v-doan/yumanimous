import {
  CardSchema,
  emptyPreferences,
  mergePreferences,
  type Card,
  type GroupPreferences,
} from '@yumanimous/shared';
import type { AiCallKind, AiCallLog, AiCallStatus, BudgetGuard } from '../ai/aiCallLog.js';
import { AgentRunError, type AiUsage, type DeckAgent, type DeckProposal } from '../ai/deckAgent.js';
import type { DeckBuildContext, DeckSource } from './deckSource.js';
import { softScore, type RecipeDeckSource } from './recipeDeckSource.js';

export interface AiDeckSourceOptions {
  /** The non-AI source: provides the safe candidate pool, and is the fallback. */
  base: RecipeDeckSource;
  agent: DeckAgent;
  log: AiCallLog;
  budget: BudgetGuard;
  deckSize?: number;
  timeoutMs?: number;
  rerankTimeoutMs?: number;
  warn?: (message: string) => void;
}

/** Fewer valid AI picks than this and the proposal isn't worth using. */
const MIN_AI_PICKS = 3;

const noHardRules = mergePreferences([{ name: '', preferences: emptyPreferences() }]);

/**
 * Deck building with AI on top of the Phase 5 source. AI suggests, code enforces:
 *
 * - The candidate pool comes from `base`, searched with the group's hard rules, so
 *   every candidate is already safe. The scout can only add more candidates through
 *   a search that ALSO applies those rules.
 * - The proposal is validated: cards must come from the candidate pool, appear once,
 *   and have a short, clean blurb. Anything else is dropped.
 * - Budget reached, timeout, refusal, bad output, any error: the non-AI deck is used,
 *   so starting a session never depends on the AI. Every run is logged with its cost.
 */
export class AiDeckSource implements DeckSource {
  readonly mode = 'cook-in' as const;
  private readonly deckSize: number;
  private readonly timeoutMs: number;
  private readonly rerankTimeoutMs: number;
  private readonly warn: (message: string) => void;

  constructor(private readonly opts: AiDeckSourceOptions) {
    this.deckSize = opts.deckSize ?? 20;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.rerankTimeoutMs = opts.rerankTimeoutMs ?? 45_000;
    this.warn = opts.warn ?? ((m) => console.warn(m));
  }

  async buildDeck(group?: GroupPreferences, context?: DeckBuildContext): Promise<Card[]> {
    // DeckError (no safe pool at all) propagates: neither AI nor non-AI can help.
    const pool = await this.opts.base.candidatePool(group);
    const fallback = () => this.opts.base.deal(pool, group, this.deckSize);
    if (!context) return fallback();

    const sessionCode = context.sessionCode;
    if (!(await this.withinBudget(sessionCode, 'deck'))) return fallback();

    const hard = (group ?? noHardRules).hard;
    let orderReady: (order: { chosen: Card[]; candidates: Map<string, Card> }) => void = () => {};
    const order = new Promise<{ chosen: Card[]; candidates: Map<string, Card> }>((resolve) => {
      orderReady = resolve;
    });
    const running = this.run(sessionCode, 'deck', this.timeoutMs, (signal) =>
      this.opts.agent.buildDeck({
        sessionCode,
        deckSize: this.deckSize,
        pool,
        searchMore: this.opts.base.canSearch
          ? (extra) => this.opts.base.searchMore(hard, extra)
          : null,
        onProgress: context.onProgress,
        onOrder: (chosen, candidates) => orderReady({ chosen, candidates }),
        signal,
      }),
    );

    // Whichever comes first: the curator's order (go live now, blurbs follow), or
    // the end of the run (e.g. it failed before ordering).
    const first = await Promise.race([
      order.then((o) => ({ kind: 'order' as const, ...o })),
      running.then((outcome) => ({ kind: 'done' as const, outcome })),
    ]);
    if (first.kind === 'order') {
      const early = assembleDeck(
        {
          picks: first.chosen.map((c) => ({ cardId: c.id, blurb: '' })),
          candidates: first.candidates,
        },
        this.deckSize,
        group,
      );
      if (early) {
        void running.then((outcome) =>
          this.finishInBackground(sessionCode, outcome, early, context),
        );
        return early;
      }
      // Too few valid cards to go live on: wait for the run and decide then.
    }

    const outcome = first.kind === 'done' ? first.outcome : await running;
    if (!outcome) return fallback();

    const deck = assembleDeck(outcome.result, this.deckSize, group);
    await this.record(sessionCode, 'deck', deck ? 'ok' : 'fallback', outcome.usage, null);
    if (!deck) this.warn(`[ai] ${sessionCode}: unusable deck proposal, using the non-AI deck`);
    return deck ?? fallback();
  }

  /**
   * After an early deck went live: log the run, and hand over the writer's blurbs
   * for the cards that are in it. If the run failed, its cost was already logged by
   * `run`, and the deck simply keeps the recipe blurbs.
   */
  private async finishInBackground(
    sessionCode: string,
    outcome: { result: DeckProposal; usage: AiUsage } | null,
    deck: Card[],
    context: DeckBuildContext,
  ) {
    if (!outcome) return;
    await this.record(sessionCode, 'deck', 'ok', outcome.usage, null);
    const inDeck = new Set(deck.map((c) => c.id));
    const blurbs = new Map<string, string>();
    for (const pick of outcome.result.picks) {
      const blurb = cleanBlurb(pick.blurb);
      if (blurb && inDeck.has(pick.cardId)) blurbs.set(pick.cardId, blurb);
    }
    if (blurbs.size === 0) return;
    try {
      context.onBlurbs?.(blurbs);
    } catch (err) {
      this.warn(`[ai] ${sessionCode}: could not apply blurbs: ${(err as Error).message}`);
    }
  }

  async rerank({ sessionCode, cards }: { sessionCode: string; cards: Card[] }) {
    if (!(await this.withinBudget(sessionCode, 'rerank'))) return null;
    const outcome = await this.run(sessionCode, 'rerank', this.rerankTimeoutMs, (signal) =>
      this.opts.agent.rerank({ sessionCode, cards, signal }),
    );
    if (!outcome) return null;

    const order = completeOrder(outcome.result.order, cards);
    await this.record(sessionCode, 'rerank', order ? 'ok' : 'fallback', outcome.usage, null);
    return order;
  }

  private async withinBudget(sessionCode: string, kind: AiCallKind): Promise<boolean> {
    const budget = await this.opts.budget.status();
    if (budget.allowed) return true;
    this.warn(
      `[ai] monthly budget reached ($${budget.spentUsd.toFixed(2)} of $${budget.budgetUsd}); skipping ${kind}`,
    );
    await this.record(sessionCode, kind, 'skipped', null, 'Monthly AI budget reached');
    return false;
  }

  /** Runs one agent job under a timeout. Errors are logged (with cost) and return null. */
  private async run<T extends { usage: AiUsage }>(
    sessionCode: string,
    kind: AiCallKind,
    timeoutMs: number,
    job: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ result: T; usage: AiUsage } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const result = await job(controller.signal);
      return { result, usage: result.usage };
    } catch (err) {
      const message = controller.signal.aborted
        ? `Timed out after ${timeoutMs} ms`
        : (err as Error).message;
      this.warn(`[ai] ${sessionCode} ${kind} failed: ${message}`);
      // A failed run can still have cost money; AgentRunError carries what it spent.
      const usage =
        err instanceof AgentRunError
          ? err.usage
          : { ...emptyUsage(this.opts.agent.model), durationMs: Date.now() - started };
      await this.record(sessionCode, kind, 'error', usage, message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async record(
    sessionCode: string,
    kind: AiCallKind,
    status: AiCallStatus,
    usage: AiUsage | null,
    error: string | null,
  ) {
    const u = usage ?? emptyUsage(this.opts.agent.model);
    try {
      await this.opts.log.record({
        sessionCode,
        kind,
        status,
        model: u.model,
        costUsd: u.costUsd,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        durationMs: u.durationMs,
        numTurns: u.numTurns,
        error,
      });
    } catch (err) {
      // Logging must never break deck building.
      this.warn(`[ai] could not log AI call: ${(err as Error).message}`);
    }
  }
}

const emptyUsage = (model: string): AiUsage => ({
  model,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  durationMs: 0,
  numTurns: 0,
});

// Control characters and bidi overrides have no place in a card blurb.
const UNSAFE = /[\p{Cc}‪-‮⁦-⁩]/gu;

/** A model-written blurb, cleaned; null if it's unusable (then the card keeps its own). */
export function cleanBlurb(raw: string): string | null {
  const text = raw.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  return text.length >= 10 && text.length <= 160 ? text : null;
}

/**
 * Turns a proposal into a deck, or null if it isn't usable. Pure, so the safety rules
 * are unit-tested without any AI:
 * - only cards from the candidate pool (which already satisfies the hard rules);
 * - each card once;
 * - blurbs cleaned and length-checked, else the card's own blurb;
 * - topped up to the deck size from the remaining candidates, best soft score first.
 */
export function assembleDeck(
  proposal: Pick<DeckProposal, 'picks' | 'candidates'>,
  deckSize: number,
  group: GroupPreferences | undefined,
): Card[] | null {
  const chosen: Card[] = [];
  const seen = new Set<string>();

  for (const pick of proposal.picks) {
    const card = proposal.candidates.get(pick.cardId);
    if (!card || seen.has(card.id) || chosen.length >= deckSize) continue;
    seen.add(card.id);
    const blurb = cleanBlurb(pick.blurb) ?? card.blurb;
    const withBlurb = CardSchema.safeParse({ ...card, blurb });
    chosen.push(withBlurb.success ? withBlurb.data : card);
  }
  if (chosen.length < MIN_AI_PICKS) return null;

  const soft = (group ?? noHardRules).soft;
  const rest = [...proposal.candidates.values()]
    .filter((c) => !seen.has(c.id))
    .sort((a, b) => softScore(b, soft) - softScore(a, soft) || a.id.localeCompare(b.id));
  for (const card of rest) {
    if (chosen.length >= deckSize) break;
    chosen.push(card);
  }
  return chosen;
}

/**
 * A re-rank must be a permutation of the given cards. Unknown ids are dropped,
 * duplicates ignored, and any card the model forgot keeps its place at the end.
 * Null if the model returned nothing usable.
 */
export function completeOrder(order: string[], cards: Card[]): string[] | null {
  const known = new Set(cards.map((c) => c.id));
  const result: string[] = [];
  for (const id of order) {
    if (known.has(id) && !result.includes(id)) result.push(id);
  }
  if (result.length === 0) return null;
  for (const card of cards) if (!result.includes(card.id)) result.push(card.id);
  return result;
}
