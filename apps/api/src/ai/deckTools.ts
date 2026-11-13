import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CUISINES, type Card } from '@yumanimous/shared';

/** Extra search terms the scout may add. Hard filters are NOT part of this. */
export interface ScoutQuery {
  query?: string;
  cuisine?: (typeof CUISINES)[number];
}

export interface DeckToolsOptions {
  /** The starting pool: already searched with the group's hard filters. */
  pool: Card[];
  /**
   * Runs a recipe search with the group's hard filters already applied by the
   * caller. The scout only chooses the extra terms; it never sees or sets diets.
   */
  searchMore: ((extra: ScoutQuery) => Promise<Card[]>) | null;
  maxSearches?: number;
  /**
   * Called on each accepted submit_order with the chosen cards, in order, and every
   * candidate. Lets the deck go live before the writer has finished.
   */
  onOrder?: (chosen: Card[], candidates: Map<string, Card>) => void;
}

/**
 * MCP tools for ONE deck-building run, served in-process to the agents.
 *
 * This is where "AI suggests, code enforces" lives:
 * - `search_candidates` has no diet or allergen parameters at all. The caller's
 *   `searchMore` injects the group's hard filters, so the scout can widen variety
 *   ("Thai", "one-pot") but can never drop a restriction.
 * - Every card the agents can see is recorded in `candidates`. The final deck may
 *   only contain cards from this map; anything else the model returns is rejected.
 * - The curator and writer hand in their work through `submit_order` and
 *   `submit_blurbs`, validated on arrival and kept here. The deck is assembled from
 *   that, by code: no agent ever retypes card ids or blurbs into a final answer,
 *   which is both faster and one less place for a model to garble an id.
 */
export function createDeckTools({ pool, searchMore, maxSearches = 2, onOrder }: DeckToolsOptions) {
  const candidates = new Map<string, Card>(pool.map((c) => [c.id, c]));
  let searches = 0;
  /** The curator's choice, best first. Only ever holds ids from `candidates`. */
  let order: string[] = [];
  /** The writer's blurbs, for chosen cards only. Length-checked again on assembly. */
  const blurbs = new Map<string, string>();

  const server = new McpServer({ name: 'deck', version: '0.1.0' });

  server.registerTool(
    'list_candidates',
    {
      description:
        'Recipes this deck may use. Every one already satisfies all of the group’s hard food rules. Pass cardIds to see only those.',
      inputSchema: { cardIds: z.array(z.string().max(64)).max(60).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ cardIds }) => {
      const wanted = cardIds ? new Set(cardIds) : null;
      const rows = [...candidates.values()]
        .filter((c) => !wanted || wanted.has(c.id))
        .map((c) => ({ cardId: c.id, title: c.title, tags: c.tags }));
      return json({ count: rows.length, candidates: rows });
    },
  );

  server.registerTool(
    'search_candidates',
    {
      description: `Find more recipes for variety, e.g. a cuisine the group likes. The group's hard food rules are applied automatically. At most ${maxSearches} searches per deck.`,
      inputSchema: {
        query: z.string().trim().min(2).max(60).optional().describe('e.g. "one-pot", "noodles"'),
        cuisine: z.enum(CUISINES).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, cuisine }) => {
      if (!searchMore) return error('Recipe search is unavailable; use the existing candidates.');
      if (searches >= maxSearches) {
        return error(`Search limit reached (${maxSearches}); use the existing candidates.`);
      }
      searches++;
      try {
        const found = await searchMore({ query, cuisine });
        let added = 0;
        for (const card of found) {
          if (!candidates.has(card.id)) {
            candidates.set(card.id, card);
            added++;
          }
        }
        return json({ found: found.length, added, total: candidates.size });
      } catch {
        return error('Recipe search failed; use the existing candidates.');
      }
    },
  );

  server.registerTool(
    'submit_order',
    {
      description:
        'Hand in the deck: distinct cardIds from list_candidates, best first. Replaces any earlier submission.',
      inputSchema: { cardIds: z.array(z.string().max(64)).min(1).max(40) },
    },
    async ({ cardIds }) => {
      const accepted = [...new Set(cardIds)].filter((id) => candidates.has(id));
      const rejected = cardIds.filter((id) => !candidates.has(id));
      order = accepted;
      if (accepted.length)
        onOrder?.(
          accepted.map((id) => candidates.get(id)!),
          candidates,
        );
      return json({ accepted: accepted.length, rejected });
    },
  );

  server.registerTool(
    'list_chosen',
    {
      description: 'The cards the curator chose, in order: the ones that need blurbs.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      json({
        cards: order.map((id) => {
          const c = candidates.get(id)!;
          return { cardId: c.id, title: c.title, tags: c.tags };
        }),
      }),
  );

  server.registerTool(
    'submit_blurbs',
    {
      description: 'Hand in one blurb per chosen card (at most 100 characters each).',
      inputSchema: {
        blurbs: z
          .array(z.object({ cardId: z.string().max(64), blurb: z.string().max(300) }))
          .min(1)
          .max(40),
      },
    },
    async ({ blurbs: submitted }) => {
      const chosen = new Set(order);
      let accepted = 0;
      const rejected: string[] = [];
      for (const { cardId, blurb } of submitted) {
        if (chosen.has(cardId)) {
          blurbs.set(cardId, blurb);
          accepted++;
        } else {
          rejected.push(cardId);
        }
      }
      return json({ accepted, rejected, missing: order.filter((id) => !blurbs.has(id)) });
    },
  );

  return {
    server,
    candidates,
    searchesUsed: () => searches,
    /** The submitted deck: chosen ids in order, each with its blurb ('' if none). */
    picks: () => order.map((cardId) => ({ cardId, blurb: blurbs.get(cardId) ?? '' })),
  };
}

// Untrusted strings (recipe titles from an external API) only ever travel as JSON
// values inside tool results, never spliced into instructions.
const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

const error = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});
