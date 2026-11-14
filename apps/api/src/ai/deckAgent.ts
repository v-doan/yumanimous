import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Card } from '@yumanimous/shared';
import { DATA_NOTE, lockedDownOptions, runQuery, type AiUsage } from './agentRun.js';
import { createDeckTools, type ScoutQuery } from './deckTools.js';

// Moved to agentRun.ts (shared with the Phase 7 agents); re-exported for callers.
export { AgentRunError, type AiUsage } from './agentRun.js';

export type ProgressStage = 'scouting' | 'curating' | 'writing';

export interface DeckRequest {
  sessionCode: string;
  deckSize: number;
  pool: Card[];
  searchMore: ((extra: ScoutQuery) => Promise<Card[]>) | null;
  onProgress?: (stage: ProgressStage) => void;
  /** The curator's order, the moment it's handed in (see createDeckTools). */
  onOrder?: (chosen: Card[], candidates: Map<string, Card>) => void;
  signal: AbortSignal;
}

export interface RerankRequest {
  sessionCode: string;
  /** Cards nobody has swiped yet: the only ones a re-rank may reorder. */
  cards: Card[];
  signal: AbortSignal;
}

/**
 * What the model proposed, before the app checks it. `candidates` is every card the
 * agents were shown; the caller only accepts picks from it.
 */
export interface DeckProposal {
  picks: { cardId: string; blurb: string }[];
  candidates: Map<string, Card>;
  usage: AiUsage;
  /** Wall-clock milliseconds per stage, e.g. { setup, scout, curator, writer, finish }. */
  stages?: Record<string, number>;
}

export interface RerankProposal {
  order: string[];
  usage: AiUsage;
}

/** The AI side of deck building. Tests use a fake; ClaudeDeckAgent calls the API. */
export interface DeckAgent {
  readonly model: string;
  buildDeck: (request: DeckRequest) => Promise<DeckProposal>;
  rerank: (request: RerankRequest) => Promise<RerankProposal>;
}

const RerankOutputSchema = z.object({ order: z.array(z.string()) });

export interface ClaudeDeckAgentOptions {
  model: string;
  /**
   * Builds mcp-session (Phase 4) on a read-only Postgres pool, served in-process.
   * A factory, not an instance: an McpServer can only be connected to one transport
   * at a time, and two sessions may start at the same moment.
   */
  createSessionServer: () => McpServer;
  /** Per-run spending caps, enforced by the Agent SDK. */
  maxDeckUsd?: number;
  maxRerankUsd?: number;
  /**
   * Extended thinking. Haiku 5.5 accepts 'disabled' at effort high or below. Most of a
   * run's output tokens (time and cost) are thinking; the job is mostly lookup and
   * short writing.
   */
  thinking?: 'adaptive' | 'disabled';
  /** Debugging: one line per SDK message (type, agent, tools, timing). */
  trace?: (line: string) => void;
}

/**
 * Deck building with the Claude Agent SDK: an orchestrator that delegates to three
 * subagents (scout, curator, writer), each limited to the tools its job needs.
 */
export class ClaudeDeckAgent implements DeckAgent {
  readonly model: string;

  constructor(private readonly opts: ClaudeDeckAgentOptions) {
    this.model = opts.model;
  }

  async buildDeck(req: DeckRequest): Promise<DeckProposal> {
    const tools = createDeckTools({
      pool: req.pool,
      searchMore: req.searchMore,
      ...(req.onOrder ? { onOrder: req.onOrder } : {}),
    });
    const code = req.sessionCode;
    const n = req.deckSize;

    // Wall-clock per stage: when each subagent is called, and when its answer returns.
    const t0 = Date.now();
    const stageOf = new Map<string, string>(); // Agent tool_use id -> subagent name
    const marks: { stage: string; start: number; end?: number }[] = [];

    const run = await runQuery({
      trace: this.opts.trace,
      prompt:
        `Build a swipe deck of exactly ${n} dinner recipes for session ${code}: ` +
        'scout, then curator, then writer.',
      // No structured output: the curator and writer hand in their work through
      // tools, and the code assembles the deck from that (see deckTools).
      signal: req.signal,
      onToolUse: (name, input, id) => {
        if (name !== 'Agent') return;
        const agent = (input as { subagent_type?: string }).subagent_type;
        if (agent) {
          stageOf.set(id, agent);
          marks.push({ stage: agent, start: Date.now() });
        }
        if (agent === 'scout') req.onProgress?.('scouting');
        if (agent === 'curator') req.onProgress?.('curating');
        if (agent === 'writer') req.onProgress?.('writing');
      },
      onToolResult: (toolUseId) => {
        const agent = stageOf.get(toolUseId);
        const mark = [...marks].reverse().find((m) => m.stage === agent && m.end === undefined);
        if (mark) mark.end = Date.now();
      },
      options: {
        ...this.baseOptions(tools.server),
        maxBudgetUsd: this.opts.maxDeckUsd ?? 0.4,
        maxTurns: 12,
        systemPrompt:
          'You run a small team that builds a recipe deck for a group deciding what to cook together. ' +
          'Call the Agent tool three times, one after another, waiting for each: scout, then curator, then writer. ' +
          'Always pass run_in_background: false, since each step needs the previous one. ' +
          'Tell each one the session code and the deck size. They save their work through tools, so you never ' +
          'repeat cards or blurbs. When the writer has finished, reply with just "done". ' +
          DATA_NOTE,
        tools: ['Agent'],
        agents: {
          scout: {
            description: 'Gathers candidate recipes for the deck.',
            prompt:
              'Call list_candidates to see the pool, and get_member_preferences for the session to see what the group likes. ' +
              `If the pool has fewer than ${n + 5} recipes, or little that matches the group’s liked cuisines or cravings, ` +
              'call search_candidates (at most twice) with a cuisine or a short query that fits their tastes. ' +
              'Hard food rules are applied for you; never try to work around them. ' +
              'Then reply with one short sentence, nothing else. ' +
              DATA_NOTE,
            tools: [
              'mcp__deck__list_candidates',
              'mcp__deck__search_candidates',
              'mcp__session__get_member_preferences',
            ],
            model: this.model,
            // Run inline: a background subagent ends the orchestrator's turn and
            // restarts it when done, re-reading everything (slower and dearer).
            background: false,
          },
          curator: {
            description: 'Chooses and orders the deck for the whole group.',
            prompt:
              'Call get_member_preferences and get_session for the session, then list_candidates. ' +
              `Choose exactly ${n} distinct cardIds (fewer only if there are fewer candidates) that the whole group will enjoy: ` +
              'favour liked cuisines and cravings, avoid disliked cuisines and ingredients, and mix cuisines and cooking times. ' +
              'Put the strongest crowd-pleasers first. Call submit_order once with them, best first. ' +
              'Then reply with one short sentence, nothing else. ' +
              DATA_NOTE,
            tools: [
              'mcp__deck__list_candidates',
              'mcp__deck__submit_order',
              'mcp__session__get_member_preferences',
              'mcp__session__get_session',
            ],
            model: this.model,
            background: false,
          },
          writer: {
            description: 'Writes a short, fun blurb for each chosen card.',
            prompt:
              'Call list_chosen. For every card it returns, write one playful blurb of at most 100 characters (one or two short sentences) ' +
              'that makes the dish sound good. Never mention diets, allergens, health claims or people. ' +
              'Call submit_blurbs once with all of them. Then reply with one short sentence, nothing else. ' +
              DATA_NOTE,
            tools: ['mcp__deck__list_chosen', 'mcp__deck__submit_blurbs'],
            model: this.model,
            background: false,
          },
        },
        allowedTools: [
          'Agent',
          'mcp__deck__list_candidates',
          'mcp__deck__search_candidates',
          'mcp__deck__submit_order',
          'mcp__deck__list_chosen',
          'mcp__deck__submit_blurbs',
          'mcp__session__get_member_preferences',
          'mcp__session__get_session',
        ],
      },
    });

    const end = Date.now();
    const stages: Record<string, number> = { setup: (marks[0]?.start ?? end) - t0 };
    for (const m of marks) stages[m.stage] = (stages[m.stage] ?? 0) + ((m.end ?? end) - m.start);
    stages.finish = end - (marks.at(-1)?.end ?? marks.at(-1)?.start ?? t0);
    return {
      picks: tools.picks(),
      candidates: tools.candidates,
      usage: run.usage,
      stages,
    };
  }

  async rerank(req: RerankRequest): Promise<RerankProposal> {
    // Only the cards nobody has swiped are in the pool, so they're all it can order.
    const tools = createDeckTools({ pool: req.cards, searchMore: null });
    const run = await runQuery({
      trace: this.opts.trace,
      prompt: `Re-rank the remaining cards for session ${req.sessionCode}.`,
      schema: RerankOutputSchema,
      signal: req.signal,
      options: {
        ...this.baseOptions(tools.server),
        maxBudgetUsd: this.opts.maxRerankUsd ?? 0.15,
        maxTurns: 6,
        systemPrompt:
          'You reorder the rest of a recipe deck based on what a group has swiped so far. ' +
          'Call get_swipe_history and get_member_preferences for the session, then list_candidates. ' +
          'Return every candidate cardId exactly once, most likely group favourites first: lean towards cuisines, ' +
          'tags and styles the group said yum to, away from what they skipped. ' +
          DATA_NOTE,
        tools: [],
        allowedTools: [
          'mcp__deck__list_candidates',
          'mcp__session__get_swipe_history',
          'mcp__session__get_member_preferences',
        ],
      },
    });
    return { order: run.output?.order ?? [], usage: run.usage };
  }

  private baseOptions(deckServer: McpServer): Options {
    return lockedDownOptions({
      model: this.model,
      thinking: this.opts.thinking,
      mcpServers: {
        deck: deckServer,
        session: this.opts.createSessionServer(),
      },
    });
  }
}
