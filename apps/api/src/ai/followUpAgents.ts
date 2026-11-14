import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MediatorPickSchema, type MediatorPick } from '../followUps/mediator.js';
import { checkCoverage, LinePlanSchema, type LinePlan } from '../followUps/shoppingList.js';
import { DATA_NOTE, lockedDownOptions, runQuery, type AiUsage } from './agentRun.js';

/** One ingredient as the sous-chef sees it: already scaled by code. */
export interface ScaledIngredient {
  index: number;
  name: string;
  /** e.g. "3 cloves", "½ cup"; empty for "to taste". */
  quantity: string;
  aisle: string | null;
}

export interface ShoppingPlanRequest {
  sessionCode: string;
  title: string;
  ingredients: ScaledIngredient[];
  signal: AbortSignal;
}

export interface MediatorRequest {
  sessionCode: string;
  signal: AbortSignal;
}

/** The AI side of Phase 7. Tests use a fake; ClaudeFollowUpAgent calls the API. */
export interface FollowUpAgent {
  readonly model: string;
  /** null plan: the agent never handed in a list that passed the checks. */
  planShoppingList: (
    req: ShoppingPlanRequest,
  ) => Promise<{ plan: LinePlan[] | null; usage: AiUsage }>;
  pickCompromise: (req: MediatorRequest) => Promise<{ pick: MediatorPick; usage: AiUsage }>;
}

/** Tries the sous-chef gets to hand in a list that covers every ingredient. */
const MAX_SUBMISSIONS = 3;

/**
 * The sous-chef's tools for ONE list. `submit_shopping_list` checks the grouping on
 * arrival (every ingredient exactly once, nothing invented) and answers with the
 * problems, so the model can fix them; only a list that passes is kept.
 */
export function createShoppingTools(ingredients: ScaledIngredient[]) {
  let accepted: LinePlan[] | null = null;
  let submissions = 0;
  const server = new McpServer({ name: 'shop', version: '0.1.0' });

  server.registerTool(
    'list_ingredients',
    {
      description:
        'The recipe’s ingredients, numbered by index, with quantities already scaled for the group.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json({ count: ingredients.length, ingredients }),
  );

  server.registerTool(
    'submit_shopping_list',
    {
      description:
        'Hand in the shopping list. Each line covers one or more ingredient indexes; every index must be covered by exactly one line.',
      inputSchema: { lines: z.array(LinePlanSchema).min(1).max(60) },
    },
    async ({ lines }) => {
      submissions++;
      if (submissions > MAX_SUBMISSIONS) return error('No more submissions; stop now.');
      const problems = checkCoverage(lines, ingredients.length);
      if (problems.length) {
        return error(`Not saved. ${problems.join(' ')} Fix these and submit the whole list again.`);
      }
      accepted = lines;
      return json({ saved: true, lines: lines.length });
    },
  );

  return { server, plan: () => accepted };
}

export interface ClaudeFollowUpAgentOptions {
  model: string;
  /** mcp-session on a read-only pool, as for the deck agents. A factory: see deckAgent. */
  createSessionServer: () => McpServer;
  maxShoppingUsd?: number;
  maxMediatorUsd?: number;
  trace?: (line: string) => void;
}

/**
 * Two small single agents (no subagents: neither job has steps worth splitting):
 * - sous-chef: groups a recipe's ingredients into shopping lines;
 * - mediator: picks a compromise when nothing matched, from the vote tally.
 */
export class ClaudeFollowUpAgent implements FollowUpAgent {
  readonly model: string;

  constructor(private readonly opts: ClaudeFollowUpAgentOptions) {
    this.model = opts.model;
  }

  async planShoppingList(req: ShoppingPlanRequest) {
    const tools = createShoppingTools(req.ingredients);
    const run = await runQuery({
      trace: this.opts.trace,
      prompt: `Make the shopping list for the recipe ${JSON.stringify(req.title)}.`,
      signal: req.signal,
      options: {
        ...lockedDownOptions({ model: this.model, mcpServers: { shop: tools.server } }),
        maxBudgetUsd: this.opts.maxShoppingUsd ?? 0.1,
        maxTurns: 6,
        systemPrompt:
          'You turn a recipe’s ingredients into a tidy supermarket shopping list. ' +
          'Call list_ingredients. Then group them into lines: one line per thing to buy, so the same item used twice ' +
          '(e.g. garlic for the sauce and garlic for the topping) is ONE line covering both indexes. ' +
          'Give each line a short shopper-friendly name ("Chicken thighs", "Fresh ginger") and one aisle, e.g. ' +
          'Produce, Meat & Fish, Dairy & Eggs, Bakery, Pantry, Spices, Frozen, Drinks, Other. ' +
          'Set likelyAtHome for basics most kitchens already have: water, salt, pepper, cooking oil, sugar. ' +
          'Rules: cover every index exactly once; never add, drop or substitute an ingredient; never write quantities. ' +
          'Call submit_shopping_list with every line. If it reports problems, fix them and submit again. ' +
          'When it is saved, reply with just "done". ' +
          DATA_NOTE,
        tools: [],
        allowedTools: ['mcp__shop__list_ingredients', 'mcp__shop__submit_shopping_list'],
      },
    });
    return { plan: tools.plan(), usage: run.usage };
  }

  async pickCompromise(req: MediatorRequest) {
    const run = await runQuery({
      trace: this.opts.trace,
      prompt: `Nothing matched in session ${req.sessionCode}. Suggest a compromise.`,
      schema: MediatorPickSchema,
      signal: req.signal,
      options: {
        ...lockedDownOptions({
          model: this.model,
          mcpServers: { session: this.opts.createSessionServer() },
        }),
        maxBudgetUsd: this.opts.maxMediatorUsd ?? 0.1,
        maxTurns: 4,
        systemPrompt:
          'A group swiped on dinner recipes and nothing matched. You suggest the fairest compromise. ' +
          'Call get_vote_tally and get_member_preferences for the session. ' +
          'Pick one card with the most yums, or at most one yum fewer if it suits the whole group better ' +
          '(fits more people’s liked cuisines, nobody skipped it, nobody dislikes its cuisine). ' +
          'Reply with its cardId and a warm, short reason for the group (at most 240 characters): why it is fair, ' +
          'e.g. who said yum. Never mention diets, allergies or health. ' +
          DATA_NOTE,
        tools: [],
        allowedTools: ['mcp__session__get_vote_tally', 'mcp__session__get_member_preferences'],
      },
    });
    // runQuery throws when there's no valid structured output, so this is set.
    return { pick: run.output!, usage: run.usage };
  }
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function error(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
